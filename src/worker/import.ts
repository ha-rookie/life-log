import { previewCsv, MAX_BYTES, type CsvSource, type CsvRow } from "../shared/csv-import";

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
}
export interface ImportDb {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const response = (body: unknown, status = 200) => Response.json(body, { status, headers });
const error = (code: string, status = 422) => response({ error: code }, status);
type Payload = { source: CsvSource; csv: string; confirmed?: boolean; hash?: string };
type Lifestyle = CsvRow & { day: string; presence: 0 | 1 | null; cups: number | null; steps: number | null };
type StoredLifestyle = {
  local_day: string;
  drinking_presence: 0 | 1 | null;
  drink_cups: number | null;
  steps: number | null;
};
export type LifestyleConflict = { day: string; fields: string[] };

function valid(x: unknown): x is Payload {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const p = x as Record<string, unknown>;
  return (p.source === "eclear" || p.source === "lifestyle")
    && typeof p.csv === "string" && new TextEncoder().encode(p.csv).length <= MAX_BYTES
    && (p.confirmed === undefined || typeof p.confirmed === "boolean")
    && (p.hash === undefined || typeof p.hash === "string");
}
function lifestyleRows(rows: CsvRow[]): Lifestyle[] { return rows as Lifestyle[]; }

// NULL-safe comparison: unknown is NOT zero. This queries all source types for the owner/day.
async function findLifestyleConflicts(db: ImportDb, owner: string, rows: Lifestyle[]): Promise<LifestyleConflict[]> {
  const conflicts: LifestyleConflict[] = [];
  for (const row of rows) {
    const found = await db.prepare(
      "SELECT local_day, drinking_presence, drink_cups, steps FROM lifestyle_days "
      + "WHERE owner_id=? AND local_day=? "
      + "AND (drinking_presence IS NOT ? OR drink_cups IS NOT ? OR steps IS NOT ?) LIMIT 1"
    ).bind(owner, row.day, row.presence, row.cups, row.steps).first<StoredLifestyle>();
    if (!found) continue;
    const fields: string[] = [];
    if (found.drinking_presence !== row.presence) fields.push("drinking_presence");
    if (found.drink_cups !== row.cups) fields.push("drink_cups");
    if (found.steps !== row.steps) fields.push("steps");
    conflicts.push({ day: row.day, fields });
  }
  return conflicts;
}

// A D1 batch is transactional. Recheck ALL dates in the job INSERT itself so a
// concurrent import after preflight cannot silently bypass the conflict check.
// The existing status CHECK rejects the impossible 'conflict' value and forces
// a rollback of the job AND every row (no schema migration required).
function createJobStatement(
  db: ImportDb, job: string, owner: string, source: CsvSource,
  fileHash: string, now: string, rows: CsvRow[],
): Statement {
  const conditions = source === "lifestyle"
    ? lifestyleRows(rows).map(() =>
      "(local_day=? AND (drinking_presence IS NOT ? OR drink_cups IS NOT ? OR steps IS NOT ?))"
    ).join(" OR ")
    : "";
  const status = source === "lifestyle"
    ? "CASE WHEN EXISTS(SELECT 1 FROM lifestyle_days WHERE owner_id=? AND ("
      + conditions + ")) THEN 'conflict' ELSE 'confirmed' END"
    : "'confirmed'";
  const sql = "INSERT INTO import_jobs"
    + "(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at) "
    + "VALUES (?,?,?,?,?," + status + ",?,?)";
  const guardParams = source === "lifestyle"
    ? [owner, ...lifestyleRows(rows).flatMap(r => [r.day, r.presence, r.cups, r.steps])]
    : [];
  return db.prepare(sql).bind(job, owner, source, "csv:" + source, fileHash, ...guardParams, now, now);
}
function insert(db: ImportDb, owner: string, source: CsvSource, job: string, r: CsvRow): Statement {
  if (source === "eclear") {
    return db.prepare(
      "INSERT OR IGNORE INTO body_measurements"
      + "(id,owner_id,measured_at,source_timezone,weight_kg,body_fat_pct,"
      + "source_id,source_row_key,reliable_fingerprint,source_kind,import_job_id)"
      + " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(job + ":" + r.line, owner, r.timestamp, "Asia/Tokyo", r.weight, r.fat,
      "csv:eclear", r.key, r.fingerprint, "measured", job);
  }
  // One canonical row per owner/day for this import. Equal rows from other
  // sources are skipped; differing rows are rejected by the transactional job guard.
  return db.prepare(
    "INSERT INTO lifestyle_days"
    + "(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id)"
    + " SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS "
    + "(SELECT 1 FROM lifestyle_days WHERE owner_id=? AND local_day=?)"
  ).bind(owner, r.day, r.presence, r.cups, r.steps,
    "csv:lifestyle", r.key, job, owner, r.day);
}
function conflictResponse(conflicts: LifestyleConflict[]) {
  return response({ error: "LIFESTYLE_CONFLICT", conflicts }, 409);
}
export async function handleImport(req: Request, db: ImportDb, owner: string): Promise<Response> {
  if (req.method !== "POST") return error("METHOD", 405);
  if (!req.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return error("CONTENT_TYPE", 415);
  if (Number(req.headers.get("Content-Length") || 0) > MAX_BYTES * 2) return error("SIZE", 413);
  let payload: unknown;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BYTES * 2) return error("SIZE", 413);
    payload = JSON.parse(raw);
  } catch { return error("JSON", 400); }
  if (!valid(payload)) return error("PAYLOAD", 400);
  let preview;
  try { preview = await previewCsv(payload.source, payload.csv); }
  catch { return error("CSV"); }
  if (new URL(req.url).pathname === "/api/import/preview") return response(preview);
  if (payload.confirmed !== true || payload.hash !== preview.hash) return error("CONFIRM_REQUIRED", 409);
  if (preview.errors.length || !preview.rows.length) return error("INVALID_ROWS");
  const keys = new Set<string>();
  for (const row of preview.rows) {
    const key = payload.source === "eclear" ? row.fingerprint! : row.day!;
    if (keys.has(key)) return error("DUPLICATE_IN_FILE");
    keys.add(key);
  }
  const job = owner + ":" + payload.source + ":" + preview.hash;
  try {
    const existing = await db.prepare(
      "SELECT status FROM import_jobs WHERE owner_id=? AND source_type=? AND file_sha256=?"
    ).bind(owner, payload.source, preview.hash).first<{ status: string }>();
    if (existing) return existing.status === "confirmed"
      ? response({ status: "already_imported", inserted: 0, skipped: preview.rows.length })
      : error("JOB_CONFLICT", 409);

    if (payload.source === "lifestyle") {
      const conflicts = await findLifestyleConflicts(db, owner, lifestyleRows(preview.rows));
      if (conflicts.length) return conflictResponse(conflicts);
    }

    const now = new Date().toISOString();
    const ops: Statement[] = [
      db.prepare("INSERT OR IGNORE INTO owners(id,created_at) VALUES (?,?)").bind(owner, now),
      createJobStatement(db, job, owner, payload.source, preview.hash, now, preview.rows),
      ...preview.rows.map(row => insert(db, owner, payload.source, job, row)),
    ];
    const result = await db.batch(ops);
    if (result.length !== ops.length) throw Error("INCOMPLETE_BATCH");
    const changes = result.slice(2).map(x => (x as { meta?: { changes?: number } }).meta?.changes);
    if (changes.some(x => typeof x !== "number")) return error("UNVERIFIED_BATCH", 503);
    const inserted = changes.reduce<number>((sum, n) => sum + (n === 1 ? 1 : 0), 0);
    return response({ status: "confirmed", inserted, skipped: preview.rows.length - inserted });
  } catch {
    // The transactional guard catches a race between the SELECT and batch.
    // Report a true conflict explicitly; all writes were rolled back by D1.
    if (payload.source === "lifestyle") {
      try {
        const conflicts = await findLifestyleConflicts(db, owner, lifestyleRows(preview.rows));
        if (conflicts.length) return conflictResponse(conflicts);
      } catch { /* Failing DB reads cannot authorize retry or persistence. */ }
    }
    // A concurrent identical upload can win the unique job insertion.
    try {
      const winner = await db.prepare(
        "SELECT status FROM import_jobs WHERE owner_id=? AND source_type=? AND file_sha256=?"
      ).bind(owner, payload.source, preview.hash).first<{ status: string }>();
      if (winner?.status === "confirmed") {
        return response({ status: "already_imported", inserted: 0, skipped: preview.rows.length });
      }
    } catch { /* Don't expose database internals. */ }
    return error("IMPORT_FAILED", 503);
  }
}
