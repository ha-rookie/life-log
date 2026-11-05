import type { ImportDb } from "./import";

type AuditDb = Pick<ImportDb, "prepare">;
type Source = "lifestyle" | "eclear";
export type AuditState = "recorded" | "legacy_unavailable" | "incomplete";

interface JobRow {
  id: string;
  source_type: Source;
  source_id: string;
  status: "confirmed" | "partial";
  started_at: string;
  completed_at: string | null;
  audit_count: number;
  inserted_count: number;
  skipped_count: number;
  conflict_count: number;
}
interface AuditRow {
  source_row_number: number;
  result: string;
  error_code: string | null;
  has_current: number;
  drinking_presence: number | null;
  drink_cups: number | null;
  steps: number | null;
}

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const respond = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: privateHeaders });

const MAX_PAGE = 200;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;
const allowedResults = new Set(["inserted", "skipped", "conflict", "invalid"]);

function oneNumber(params: URLSearchParams, name: string, defaultValue: number, max: number): number | null {
  const values = params.getAll(name);
  if (values.length === 0) return defaultValue;
  if (values.length !== 1 || !/^[1-9][0-9]{0,3}$/.test(values[0])) return null;
  const number = Number(values[0]);
  return Number.isSafeInteger(number) && number <= max ? number : null;
}

function parsePaging(params: URLSearchParams, names: readonly string[]) {
  let invalid = false;
  params.forEach((_, key) => { if (!names.includes(key)) invalid = true; });
  if (invalid) return null;
  const page = oneNumber(params, "page", 1, MAX_PAGE);
  const limit = oneNumber(params, "limit", DEFAULT_LIMIT, MAX_LIMIT);
  if (page === null || limit === null) return null;
  return { page, limit, offset: (page - 1) * limit };
}

function stateOf(row: Pick<JobRow, "source_type" | "source_id" | "status" | "audit_count">): AuditState {
  if (row.source_id === "csv:audited-v2:" + row.source_type && row.audit_count > 0) {
    // The import schema stores no expected source-row count: this means
    // "records exist", NOT "the entire audit is proven complete".
    return "recorded";
  }
  if (row.status === "confirmed"
      && row.source_id === "csv:" + row.source_type
      && row.audit_count === 0) {
    return "legacy_unavailable";
  }
  return "incomplete";
}

function jobView(row: JobRow) {
  const auditState = stateOf(row);
  const present = auditState === "recorded";
  return {
    id: row.id, // Opaque to the UI; the authenticated owner alone may query it.
    source: row.source_type,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    auditState,
    auditCount: present ? row.audit_count : null,
    counts: present ? {
      inserted: row.inserted_count,
      skipped: row.skipped_count,
      conflicted: row.conflict_count,
    } : null,
  };
}

function validJob(job: string, owner: string): boolean {
  // A foreign user's ID looks exactly like a missing job to the caller.
  const parts = job.split(":");
  return parts.length === 3 && parts[0] === owner
    && (parts[1] === "lifestyle" || parts[1] === "eclear")
    && /^[0-9a-f]{64}$/.test(parts[2]);
}

async function listJobs(db: AuditDb, owner: string, page: number, limit: number, offset: number) {
  // All query inputs are bound. Read only (SELECT), with a deterministic tie-break.
  // Correlated audit counts cover only the limited page, not all owners' jobs.
  const records = await db.prepare(
    "SELECT j.id,j.source_type,j.source_id,j.status,j.started_at,j.completed_at,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=j.id) AS audit_count,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=j.id AND a.result='inserted') AS inserted_count,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=j.id AND a.result='skipped') AS skipped_count,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=j.id AND a.result='conflict') AS conflict_count "
      + "FROM import_jobs j WHERE j.owner_id=? "
      + "AND j.status IN ('confirmed','partial') "
      + "AND ((j.source_type='lifestyle' AND j.source_id IN ('csv:lifestyle','csv:audited-v2:lifestyle'))"
      + " OR (j.source_type='eclear' AND j.source_id IN ('csv:eclear','csv:audited-v2:eclear'))) "
      + "ORDER BY COALESCE(j.completed_at,j.started_at) DESC,j.id DESC LIMIT ? OFFSET ?"
  ).bind(owner, limit + 1, offset).all<JobRow>();
  const items = records.results.slice(0, limit);
  return {
    page, limit, hasMore: page < MAX_PAGE && records.results.length > limit,
    jobs: items.map(jobView),
  };
}

async function listRows(db: AuditDb, owner: string, jobId: string, page: number, limit: number, offset: number) {
  const job = await db.prepare(
    "SELECT id,source_type,source_id,status,started_at,completed_at,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=import_jobs.id) AS audit_count,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=import_jobs.id AND a.result='inserted') AS inserted_count,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=import_jobs.id AND a.result='skipped') AS skipped_count,"
      + "(SELECT COUNT(*) FROM import_row_audit a WHERE a.import_job_id=import_jobs.id AND a.result='conflict') AS conflict_count "
      + "FROM import_jobs WHERE owner_id=? AND id=? AND status IN ('confirmed','partial') "
      + "AND ((source_type='lifestyle' AND source_id IN ('csv:lifestyle','csv:audited-v2:lifestyle'))"
      + " OR (source_type='eclear' AND source_id IN ('csv:eclear','csv:audited-v2:eclear')))"
  ).bind(owner, jobId).first<JobRow>();
  if (!job) return respond({ error: "NOT_FOUND" }, 404);

  // Owner filter remains INSIDE the row query, not only in the preceding lookup.
  // No source row keys, raw CSV, owner e-mail, file hashes or database errors
  // are returned. Stored values, where present, are CURRENT, not old CSV values.
  const records = await db.prepare(
    "SELECT a.source_row_number,a.result,a.error_code,"
      + "CASE WHEN l.owner_id IS NOT NULL THEN 1 ELSE 0 END AS has_current,"
      + "l.drinking_presence,l.drink_cups,l.steps "
      + "FROM import_row_audit a "
      + "JOIN import_jobs j ON j.id=a.import_job_id AND j.owner_id=? "
      + "LEFT JOIN lifestyle_days l ON l.owner_id=j.owner_id AND l.import_job_id=a.import_job_id "
      + "AND l.source_row_key=a.source_row_key AND j.source_type='lifestyle' AND a.result='inserted' "
      + "WHERE a.import_job_id=? "
      + "ORDER BY a.source_row_number ASC LIMIT ? OFFSET ?"
  ).bind(owner, jobId, limit + 1, offset).all<AuditRow>();
  const rows = records.results.slice(0, limit).map((item) => {
    if (!allowedResults.has(item.result)) throw Error("UNKNOWN_AUDIT_RESULT");
    return {
      line: item.source_row_number,
      result: item.result,
      errorCode: item.error_code === "LIFESTYLE_CONFLICT_KEPT" ? item.error_code : null,
      currentLifestyle: item.result === "inserted" && item.has_current === 1
        ? {
          drinkingPresence: item.drinking_presence,
          drinkCups: item.drink_cups,
          steps: item.steps,
        }
        : null,
    };
  });
  return {
    job: jobView(job), page, limit,
    hasMore: page < MAX_PAGE && records.results.length > limit,
    rows,
  };
}

export async function handleHistory(request: Request, db: AuditDb, owner: string): Promise<Response> {
  if (request.method !== "GET") {
    const r = respond({ error: "METHOD" }, 405);
    r.headers.set("Allow", "GET");
    return r;
  }
  const url = new URL(request.url);
  const isRows = url.pathname === "/api/import/history/rows";
  if (!isRows && url.pathname !== "/api/import/history") {
    return respond({ error: "NOT_FOUND" }, 404);
  }
  const paging = parsePaging(url.searchParams, isRows ? ["job", "page", "limit"] : ["page", "limit"]);
  if (!paging) return respond({ error: "INVALID_PAGING" }, 400);

  const jobIds = url.searchParams.getAll("job");
  if (isRows) {
    if (jobIds.length !== 1 || jobIds[0].length > 100) {
      return respond({ error: "INVALID_JOB" }, 400);
    }
    if (!validJob(jobIds[0], owner)) return respond({ error: "NOT_FOUND" }, 404);
  }

  try {
    if (isRows) return await listRows(db, owner, jobIds[0], paging.page, paging.limit, paging.offset);
    return respond(await listJobs(db, owner, paging.page, paging.limit, paging.offset));
  } catch {
    // Never leak SQL, raw stored values, or auth details via exceptions.
    return respond({ error: "DATA_UNAVAILABLE" }, 503);
  }
}
