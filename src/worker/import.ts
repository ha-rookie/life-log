import { hash, previewCsv, previewCsvFileBytes, decodeCsvBase64, MAX_BYTES, type CsvRow, type CsvSource } from "../shared/csv-import";

// Defense in depth for the ONLY mutating import route. The trusted runtime flag
// must never be configured on any remote Worker. Host/Origin can be forged by
// non-browser clients, so they are NOT substitutes for local-only deployment.
export function isSafeLocalImport(request: Request, enabled: string | undefined): boolean {
  if (enabled !== "true" || request.method !== "POST") return false;
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1"
      && url.hostname !== "[::1]") return false;
  // Reject missing/null/cross-origin Origin rather than treating it as a safe CLI call.
  if (request.headers.get("Origin") !== url.origin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return fetchSite === null || fetchSite === "same-origin";
}

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface ImportDb {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });
const reject = (error: string, status = 422) => json({ error }, status);
type Resolution = { mode: "keep_existing"; token: string };
type Payload = { source: CsvSource; csv?: string; csvBase64?: string; confirmed?: boolean; hash?: string; resolution?: Resolution };
type LifestyleRow = CsvRow & { day: string; presence: 0 | 1 | null; cups: number | null; steps: number | null };
type StoredDay = {
  source_id: string; source_row_key: string;
  drinking_presence: 0 | 1 | null; drink_cups: number | null; steps: number | null;
};
type SnapshotDay = { incoming: LifestyleRow; existing: StoredDay[] };
export type LifestyleConflict = { day: string; fields: string[] };
type AuditCount = { result: string; n: number };
type Summary = { inserted: number; skipped: number; conflicted: number };

function valid(x: unknown): x is Payload {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const p = x as Record<string, unknown>;
  if (p.source !== "eclear" && p.source !== "lifestyle") return false;
  const legacyText = typeof p.csv === "string" && p.csvBase64 === undefined;
  const originalBytes = typeof p.csvBase64 === "string" && p.csv === undefined;
  if (!legacyText && !originalBytes) return false;
  if (legacyText && new TextEncoder().encode(p.csv as string).length > MAX_BYTES) return false;
  if (originalBytes && (p.csvBase64 as string).length > Math.ceil(MAX_BYTES / 3) * 4) return false;
  if (p.confirmed !== undefined && typeof p.confirmed !== "boolean") return false;
  if (p.hash !== undefined && typeof p.hash !== "string") return false;
  if (p.resolution !== undefined) {
    if (!p.resolution || typeof p.resolution !== "object" || Array.isArray(p.resolution)) return false;
    const r = p.resolution as Record<string, unknown>;
    if (r.mode !== "keep_existing" || typeof r.token !== "string" || !/^[0-9a-f]{64}$/.test(r.token)) return false;
  }
  return true;
}
function lifestyle(rows: CsvRow[]): LifestyleRow[] { return rows as LifestyleRow[]; }

async function snapshotDays(db: ImportDb, owner: string, rows: LifestyleRow[]): Promise<SnapshotDay[]> {
  const out: SnapshotDay[] = [];
  for (const incoming of rows) {
    const found = await db.prepare(
      "SELECT source_id,source_row_key,drinking_presence,drink_cups,steps FROM lifestyle_days "
      + "WHERE owner_id=? AND local_day=? ORDER BY source_id,source_row_key"
    ).bind(owner, incoming.day).all<StoredDay>();
    out.push({ incoming, existing: found.results });
  }
  return out;
}
const same = (a: LifestyleRow, b: StoredDay): boolean =>
  a.presence === b.drinking_presence && a.cups === b.drink_cups && a.steps === b.steps;

function conflictsOf(snapshots: SnapshotDay[]): LifestyleConflict[] {
  const conflicts: LifestyleConflict[] = [];
  for (const { incoming, existing } of snapshots) {
    if (existing.every(row => same(incoming, row))) continue;
    const fields = new Set<string>();
    for (const row of existing) {
      if (row.drinking_presence !== incoming.presence) fields.add("drinking_presence");
      if (row.drink_cups !== incoming.cups) fields.add("drink_cups");
      if (row.steps !== incoming.steps) fields.add("steps");
    }
    conflicts.push({ day: incoming.day, fields: [...fields] });
  }
  return conflicts;
}
// A resolution is valid only for the same owner, CSV bytes and exact reviewed DB rows.
// It is NOT authorization: the Worker must authenticate before calling this function.
async function reviewToken(owner: string, fileHash: string, snapshots: SnapshotDay[]): Promise<string> {
  return hash(JSON.stringify([owner, fileHash, snapshots.map(s => [
    s.incoming.day, s.existing.map(r => [
      r.source_id, r.source_row_key, r.drinking_presence, r.drink_cups, r.steps,
    ]),
  ])]));
}

// The job insert checks the preflight state INSIDE the same transactional D1.batch.
// Count + every source/key/value tuple prevents changed, removed or added records
// from causing an incorrect inserted/skipped/conflict audit after a concurrent write.
function jobStatement(
  db: ImportDb, owner: string, source: CsvSource, fileHash: string,
  job: string, now: string, snapshots: SnapshotDay[], status: "confirmed" | "partial",
): Statement {
  const checks: string[] = [];
  const params: unknown[] = [];
  for (const { incoming, existing } of snapshots) {
    const conditions: string[] = [
      "(SELECT COUNT(*) FROM lifestyle_days WHERE owner_id=? AND local_day=?)=?",
    ];
    params.push(owner, incoming.day, existing.length);
    for (const row of existing) {
      conditions.push("EXISTS(SELECT 1 FROM lifestyle_days WHERE owner_id=? AND local_day=? "
        + "AND source_id=? AND source_row_key=? AND drinking_presence IS ? "
        + "AND drink_cups IS ? AND steps IS ?)");
      params.push(owner, incoming.day, row.source_id, row.source_row_key,
        row.drinking_presence, row.drink_cups, row.steps);
    }
    checks.push("(" + conditions.join(" AND ") + ")");
  }
  const statusSql = source === "lifestyle"
    ? "CASE WHEN " + checks.join(" AND ") + " THEN ? ELSE 'stale_guard' END"
    : "?";
  const sql = "INSERT INTO import_jobs"
    + "(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at)"
    + " VALUES (?,?,?,?,?," + statusSql + ",?,?)";
  // The job source marker differentiates audited-v2 jobs from confirmed pre-audit jobs.
  // Destination row source_id remains the same, preserving existing deduplication.
  return db.prepare(sql).bind(job, owner, source, "csv:audited-v2:" + source, fileHash,
    ...(source === "lifestyle" ? params : []), status, now, now);
}
function insertRow(db: ImportDb, owner: string, source: CsvSource, job: string, row: CsvRow): Statement {
  if (source === "eclear") {
    return db.prepare(
      "INSERT OR IGNORE INTO body_measurements"
      + "(id,owner_id,measured_at,source_timezone,weight_kg,body_fat_pct,skeletal_muscle_pct,"
      + "source_id,source_row_key,reliable_fingerprint,source_kind,import_job_id)"
      + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(job + ":" + row.line, owner, row.timestamp, "Asia/Tokyo", row.weight, row.fat,
      row.muscle ?? null, "csv:eclear", row.key, row.fingerprint, "measured", job);
  }
  return db.prepare(
    "INSERT INTO lifestyle_days"
    + "(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id)"
    + " SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS "
    + "(SELECT 1 FROM lifestyle_days WHERE owner_id=? AND local_day=?)"
  ).bind(owner, row.day, row.presence, row.cups, row.steps,
    "csv:lifestyle", row.key, job, owner, row.day);
}

// Row audit lives in the SAME atomic batch immediately after its destination insert.
// Classification queries the actual D1 state, not a guessed preflight outcome.
function auditRow(db: ImportDb, owner: string, source: CsvSource, job: string, row: CsvRow): Statement {
  if (source === "eclear") {
    const inserted = "EXISTS(SELECT 1 FROM body_measurements WHERE owner_id=? AND import_job_id=? AND source_row_key=?)";
    return db.prepare(
      "INSERT INTO import_row_audit(id,import_job_id,source_row_number,source_row_key,result,error_code)"
      + " VALUES (?,?,?,?,CASE WHEN " + inserted + " THEN 'inserted' ELSE 'skipped' END,NULL)"
    ).bind(job + ":" + row.line, job, row.line, row.key, owner, job, row.key);
  }
  const inserted = "EXISTS(SELECT 1 FROM lifestyle_days WHERE owner_id=? AND local_day=? "
    + "AND import_job_id=? AND source_row_key=?)";
  const differing = "EXISTS(SELECT 1 FROM lifestyle_days WHERE owner_id=? AND local_day=? "
    + "AND (drinking_presence IS NOT ? OR drink_cups IS NOT ? OR steps IS NOT ?))";
  const sql = "INSERT INTO import_row_audit(id,import_job_id,source_row_number,source_row_key,result,error_code)"
    + " VALUES (?,?,?,?,CASE WHEN " + inserted
    + " THEN 'inserted' WHEN " + differing + " THEN 'conflict' ELSE 'skipped' END,"
    + "CASE WHEN " + differing + " THEN 'LIFESTYLE_CONFLICT_KEPT' ELSE NULL END)";
  const d = [owner, row.day, row.presence, row.cups, row.steps];
  return db.prepare(sql).bind(job + ":" + row.line, job, row.line, row.key,
    owner, row.day, job, row.key, ...d, ...d);
}
function counts(rows: AuditCount[]): Summary {
  const result = { inserted: 0, skipped: 0, conflicted: 0 };
  for (const row of rows) {
    if (row.result === "inserted") result.inserted += row.n;
    else if (row.result === "skipped") result.skipped += row.n;
    else if (row.result === "conflict") result.conflicted += row.n;
    else throw Error("UNKNOWN_AUDIT_RESULT");
  }
  return result;
}
// Pre-audit confirmed jobs used the exact marker "csv:<source>" and legitimately
// have NO import_row_audit rows. Modern jobs carry "csv:audited-v2:<source>".
// This deliberately does not guess historical inserted/skipped/conflict counts.
type ExistingJob = { status: string; source_id: string };
async function existingJobResponse(
  db: ImportDb, job: string, rows: number, existing: ExistingJob, source: CsvSource,
): Promise<Response> {
  const result = await db.prepare(
    "SELECT result,COUNT(*) AS n FROM import_row_audit WHERE import_job_id=? GROUP BY result"
  ).bind(job).all<AuditCount>();
  if (result.results.length === 0
      && existing.status === "confirmed"
      && existing.source_id === "csv:" + source) {
    return json({
      status: "already_imported", inserted: 0, skipped: rows, conflicted: 0,
      auditStatus: "legacy_unavailable", original: null,
    });
  }
  // An audited job with missing records, a partially missing audit, or a
  // partial legacy job is corrupt/ambiguous: do NOT backfill or re-import.
  const original = counts(result.results);
  if (original.inserted + original.skipped + original.conflicted !== rows) {
    return reject("INCOMPLETE_AUDIT", 503);
  }
  return json({ status: "already_imported", inserted: 0, skipped: rows,
    conflicted: 0, auditStatus: "complete", original });
}

export async function handleImport(request: Request, db: ImportDb, owner: string): Promise<Response> {
  if (request.method !== "POST") return reject("METHOD", 405);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return reject("CONTENT_TYPE", 415);
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BYTES * 2) return reject("SIZE", 413);
  let payload: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES * 2) return reject("SIZE", 413);
    payload = JSON.parse(text);
  } catch { return reject("JSON", 400); }
  if (!valid(payload)) return reject("PAYLOAD", 400);
  let preview;
  try {
    preview = typeof payload.csvBase64 === "string"
      ? await previewCsvFileBytes(payload.source, decodeCsvBase64(payload.csvBase64))
      : await previewCsv(payload.source, payload.csv!);
  } catch { return reject("CSV"); }

  if (new URL(request.url).pathname === "/api/import/preview") return json(preview);
  if (payload.confirmed !== true || payload.hash !== preview.hash) return reject("CONFIRM_REQUIRED", 409);
  if (preview.errors.length || preview.rows.length === 0) return reject("INVALID_ROWS");
  const distinct = new Set<string>();
  for (const row of preview.rows) {
    const key = payload.source === "eclear" ? row.fingerprint! : row.day!;
    if (distinct.has(key)) return reject("DUPLICATE_IN_FILE");
    distinct.add(key);
  }
  if (payload.source !== "lifestyle" && payload.resolution) return reject("RESOLUTION_NOT_APPLICABLE", 409);
  const job = owner + ":" + payload.source + ":" + preview.hash;

  try {
    const existing = await db.prepare(
      "SELECT status,source_id FROM import_jobs WHERE owner_id=? AND source_type=? AND file_sha256=?"
    ).bind(owner, payload.source, preview.hash).first<ExistingJob>();
    if (existing) {
      if (existing.status === "confirmed" || existing.status === "partial") {
        return existingJobResponse(db, job, preview.rows.length, existing, payload.source);
      }
      return reject("JOB_CONFLICT", 409);
    }
    const snapshots = payload.source === "lifestyle"
      ? await snapshotDays(db, owner, lifestyle(preview.rows)) : [];
    const conflicts = conflictsOf(snapshots);
    const token = payload.source === "lifestyle"
      ? await reviewToken(owner, preview.hash, snapshots) : null;

    if (payload.resolution) {
      if (!conflicts.length || payload.resolution.token !== token) {
        return json({ error: "REVIEW_STALE", conflicts, reviewToken: token }, 409);
      }
    } else if (conflicts.length) {
      return json({ error: "LIFESTYLE_CONFLICT", conflicts, reviewToken: token }, 409);
    }

    const status = conflicts.length ? "partial" : "confirmed";
    const now = new Date().toISOString();
    const ops: Statement[] = [
      db.prepare("INSERT OR IGNORE INTO owners(id,created_at) VALUES (?,?)").bind(owner, now),
      jobStatement(db, owner, payload.source, preview.hash, job, now, snapshots, status),
    ];
    for (const row of preview.rows) {
      ops.push(insertRow(db, owner, payload.source, job, row));
      ops.push(auditRow(db, owner, payload.source, job, row));
    }
    ops.push(db.prepare(
      "SELECT result,COUNT(*) AS n FROM import_row_audit WHERE import_job_id=? GROUP BY result"
    ).bind(job));
    const batches = await db.batch(ops);
    if (batches.length !== ops.length) return reject("INCOMPLETE_BATCH", 503);
    const audit = (batches[batches.length - 1] as { results?: AuditCount[] }).results;
    if (!Array.isArray(audit)) return reject("UNVERIFIED_AUDIT", 503);
    const summary = counts(audit);
    if (summary.inserted + summary.skipped + summary.conflicted !== preview.rows.length) {
      return reject("INCOMPLETE_AUDIT", 503);
    }
    return json({ status, ...summary });
  } catch {
    // If a concurrent change invalidated our in-batch snapshot guard, the
    // entire D1 batch (including audit) was rolled back. Require fresh review.
    if (payload.source === "lifestyle") {
      try {
        const now = await snapshotDays(db, owner, lifestyle(preview.rows));
        const token = await reviewToken(owner, preview.hash, now);
        const conflicts = conflictsOf(now);
        if (conflicts.length) {
          if (payload.resolution && token !== payload.resolution.token) {
            return json({ error: "REVIEW_STALE", conflicts, reviewToken: token }, 409);
          }
          return json({ error: "LIFESTYLE_CONFLICT", conflicts, reviewToken: token }, 409);
        }
      } catch { /* fail closed; no health data in the response */ }
    }
    // A parallel identical job may have committed first. Do not create another.
    try {
      const winner = await db.prepare(
        "SELECT status,source_id FROM import_jobs WHERE owner_id=? AND source_type=? AND file_sha256=?"
      ).bind(owner, payload.source, preview.hash).first<ExistingJob>();
      if (winner?.status === "confirmed" || winner?.status === "partial") {
        return existingJobResponse(db, job, preview.rows.length, winner, payload.source);
      }
    } catch { /* fail closed */ }
    return reject("IMPORT_FAILED", 503);
  }
}
