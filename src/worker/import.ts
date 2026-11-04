import { csvSha256, previewCsv, CsvIssue, CSV_MAX_BYTES, type ImportRow, type ImportKind } from "../shared/csv-import";

// A D1 batch executes as one atomic transaction. Never use separate mutations
// for the job/rows/audit: failure must leave no partially committed imports.
export interface BoundStatement { first<T>(): Promise<T | null> }
export interface ImportDatabase {
  prepare(query: string): { bind(...values: unknown[]): BoundStatement };
  batch(statements: BoundStatement[]): Promise<unknown[]>;
}
export class ImportFailure extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details?: { line: number; code: string }[]) {
    super(code);
  }
}
export interface ImportResponse {
  kind: ImportKind;
  fileHash: string;
  inserted: number;
  skipped: number;
  replay: boolean;
}

function same(a: unknown, b: unknown): boolean {
  return a === b;
}
async function readLimited(request: Request): Promise<string> {
  const maxBytes = CSV_MAX_BYTES * 2;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new ImportFailure(413, "REQUEST_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new ImportFailure(400, "EMPTY_REQUEST");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ImportFailure(413, "REQUEST_TOO_LARGE");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (e) {
    if (e instanceof ImportFailure) throw e;
    throw new ImportFailure(400, "INVALID_ENCODING");
  }
  return text;
}
export function isSafeLocalImport(request: Request, enabled: string | undefined): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  return enabled === "true"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    && origin === url.origin
    && (site === null || site === "same-origin");
}

export async function confirmImport(request: Request, db: ImportDatabase, ownerId: string): Promise<ImportResponse> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new ImportFailure(415, "JSON_REQUIRED");
  const raw = await readLimited(request);
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new ImportFailure(400, "INVALID_JSON"); }
  if (!payload || typeof payload !== "object") throw new ImportFailure(400, "INVALID_REQUEST");
  const value = payload as Record<string, unknown>;
  if (value.confirm !== true || typeof value.csv !== "string" || typeof value.hash !== "string" ||
      (value.kind !== "eclear" && value.kind !== "lifestyle") ||
      !/^[0-9a-f]{64}$/.test(value.hash))
    throw new ImportFailure(400, "CONFIRMATION_REQUIRED");
  const fileHash = await csvSha256(value.csv);
  if (fileHash !== value.hash) throw new ImportFailure(422, "FILE_CHANGED");
  let parsed;
  try { parsed = previewCsv(value.csv); }
  catch (e) { throw new ImportFailure(422, e instanceof CsvIssue ? e.code : "INVALID_CSV"); }
  if (parsed.kind !== value.kind) throw new ImportFailure(422, "FORMAT_MISMATCH");
  if (parsed.errors.length) throw new ImportFailure(422, "INVALID_ROWS", parsed.errors);
  if (typeof db?.batch !== "function") throw new ImportFailure(503, "DATABASE_UNAVAILABLE");

  const existingJob = await db.prepare(
    "SELECT status FROM import_jobs WHERE owner_id = ? AND source_type = ? AND file_sha256 = ?"
  ).bind(ownerId, parsed.kind, fileHash).first<{ status: string }>();
  if (existingJob) {
    if (existingJob.status === "confirmed")
      return { kind: parsed.kind, fileHash, inserted: 0, skipped: parsed.rows.length, replay: true };
    throw new ImportFailure(409, "IMPORT_ALREADY_IN_PROGRESS");
  }

  const planned: { row: ImportRow; exists: boolean }[] = [];
  for (const row of parsed.rows) {
    if (row.kind === "lifestyle") {
      const prior = await db.prepare(
        "SELECT drinking_presence, drink_cups, steps FROM lifestyle_days WHERE owner_id = ? AND local_day = ? AND source_id = ?"
      ).bind(ownerId, row.localDay, "lifestyle").first<{ drinking_presence: number | null; drink_cups: number | null; steps: number | null }>();
      const priorWeight = await db.prepare(
        "SELECT weight_kg FROM body_measurements WHERE owner_id = ? AND source_id = ? AND source_row_key = ?"
      ).bind(ownerId, "lifestyle", row.key).first<{ weight_kg: number | null }>();
      if (prior || priorWeight) {
        if (!prior || !same(prior.drinking_presence, row.drinkingPresence) ||
            !same(prior.drink_cups, row.drinkCups) || !same(prior.steps, row.steps) ||
            !same(priorWeight?.weight_kg ?? null, row.weightKg))
          throw new ImportFailure(409, "EXISTING_CONFLICT", [{ line: row.line, code: "EXISTING_CONFLICT" }]);
        planned.push({ row, exists: true });
      } else planned.push({ row, exists: false });
    } else {
      const prior = await db.prepare(
        "SELECT weight_kg, body_fat_pct, skeletal_muscle_pct FROM body_measurements WHERE owner_id = ? AND source_id = ? AND source_row_key = ?"
      ).bind(ownerId, "eclear", row.key).first<{ weight_kg: number | null; body_fat_pct: number | null; skeletal_muscle_pct: number | null }>();
      if (prior) {
        if (!same(prior.weight_kg, row.weightKg) || !same(prior.body_fat_pct, row.bodyFatPct) ||
            !same(prior.skeletal_muscle_pct, row.skeletalMusclePct))
          throw new ImportFailure(409, "EXISTING_CONFLICT", [{ line: row.line, code: "EXISTING_CONFLICT" }]);
        planned.push({ row, exists: true });
      } else planned.push({ row, exists: false });
    }
  }

  const jobId = "csv:" + parsed.kind + ":" + fileHash;
  const now = new Date().toISOString();
  const statements: BoundStatement[] = [
    db.prepare("INSERT OR IGNORE INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, now),
    db.prepare(
      "INSERT INTO import_jobs(id, owner_id, source_type, source_id, file_sha256, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)"
    ).bind(jobId, ownerId, parsed.kind, parsed.kind, fileHash, now, now),
  ];
  for (const { row, exists } of planned) {
    if (!exists && row.kind === "lifestyle") {
      statements.push(db.prepare(
        "INSERT INTO lifestyle_days(owner_id, local_day, drinking_presence, drink_cups, steps, source_id, source_row_key, import_job_id) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(ownerId, row.localDay, row.drinkingPresence, row.drinkCups, row.steps, "lifestyle", row.key, jobId));
      if (row.weightKg !== null) statements.push(db.prepare(
        "INSERT INTO body_measurements(id, owner_id, measured_at, weight_kg, source_id, source_row_key, source_kind, import_job_id) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(jobId + ":" + row.line, ownerId, row.localDay, row.weightKg, "lifestyle", row.key, "reported", jobId));
    }
    if (!exists && row.kind === "eclear") statements.push(db.prepare(
      "INSERT INTO body_measurements(id, owner_id, measured_at, weight_kg, body_fat_pct, skeletal_muscle_pct, source_id, source_row_key, reliable_fingerprint, source_kind, import_job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(jobId + ":" + row.line, ownerId, row.measuredAt, row.weightKg, row.bodyFatPct, row.skeletalMusclePct,
      "eclear", row.key, "eclear:" + row.key, "measured", jobId));
    statements.push(db.prepare(
      "INSERT INTO import_row_audit(id, import_job_id, source_row_number, source_row_key, result) VALUES (?,?,?,?,?)"
    ).bind(jobId + ":" + row.line, jobId, row.line, row.key, exists ? "skipped" : "inserted"));
  }
  try {
    // D1 guarantees batch rollback on any failed statement.
    await db.batch(statements);
  } catch {
    // Do not reveal SQL, uploaded file content, credentials or internal DB errors.
    throw new ImportFailure(409, "ATOMIC_IMPORT_RETRY");
  }
  return {
    kind: parsed.kind, fileHash,
    inserted: planned.filter(p => !p.exists).length,
    skipped: planned.filter(p => p.exists).length,
    replay: false,
  };
}
