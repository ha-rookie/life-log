import type { ImportDb } from "./import";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
type Job = { handle: number; id: string; source_type: string; source_id: string; status: string; started_at: string; completed_at: string | null };
type Count = { n: number };
type Outcome = { result: string; n: number };
type Row = { source_row_number: number; result: string; error_code: string | null;
  drinking_presence: number | null; drink_cups: number | null; steps: number | null;
  weight_kg: number | null; body_fat_pct: number | null };
type Cursor = { time: string; id: string } | { row: number };
const PAGE_MAX = 25;
const encode = (value: Cursor) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
function decode(input: string, kind: "jobs" | "rows"): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,600}$/.test(input)) return null;
  try {
    const raw = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (kind === "jobs" && Object.keys(v).sort().join(",") === "id,time"
      && typeof v.time === "string" && v.time.length <= 40 && typeof v.id === "string"
      && /^[1-9][0-9]{0,15}$/.test(v.id)) return { time: v.time, id: v.id };
    if (kind === "rows" && Object.keys(v).join(",") === "row"
      && Number.isSafeInteger(v.row) && Number(v.row) >= 1) return { row: Number(v.row) };
  } catch { /* malformed cursor */ }
  return null;
}
function pageArgs(request: Request, kind: "jobs" | "rows") {
  const url = new URL(request.url);
  const allowed = new Set(["limit", "cursor"]);
  if ([...url.searchParams.keys()].some(k => !allowed.has(k))
    || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) return null;
  const raw = url.searchParams.get("limit");
  if (raw !== null && !/^(?:[1-9]|1\d|2[0-5])$/.test(raw)) return null;
  const token = url.searchParams.get("cursor");
  const cursor = token === null ? null : decode(token, kind);
  if (token !== null && cursor === null) return null;
  return { limit: raw === null ? 10 : Number(raw), cursor };
}
async function countAudit(db: ImportDb, job: string) {
  const r = await db.prepare("SELECT result,COUNT(*) AS n FROM import_row_audit WHERE import_job_id=? GROUP BY result")
    .bind(job).all<Outcome>();
  const counts = { inserted: 0, skipped: 0, conflict: 0, invalid: 0 };
  for (const item of r.results) {
    if (!(item.result in counts)) return { counts, total: -1 };
    counts[item.result as keyof typeof counts] += item.n;
  }
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
function auditState(job: Job, total: number, expected: number) {
  if (total === 0 && job.status === "confirmed" && job.source_id === "csv:" + job.source_type)
    return "legacy_unavailable";
  if (total !== expected || total < 0) return "incomplete";
  return "complete";
}
export async function handleAuditHistory(request: Request, db: ImportDb, owner: string): Promise<Response> {
  if (request.method !== "GET") return reply({ error: "METHOD" }, 405);
  const pathname = new URL(request.url).pathname;
  const prefix = "/api/import/history";
  const tail = pathname.slice(prefix.length);
  if (tail && (!tail.startsWith("/") || tail.slice(1).includes("/") || !tail.slice(1))) return reply({ error: "NOT_FOUND" }, 404);
  const detail = tail ? tail.slice(1) : null;
  if (detail && !/^[1-9][0-9]{0,15}$/.test(detail)) return reply({ error: "NOT_FOUND" }, 404);
  const args = pageArgs(request, detail ? "rows" : "jobs");
  if (!args) return reply({ error: "INVALID_PAGE" }, 400);
  try {
    if (!detail) {
      const cursor = args.cursor as {time:string;id:string} | null;
      // Cursor must refer to a job owned by the authenticated owner, not merely a syntactically valid tuple.
      if (cursor) {
        const anchor = await db.prepare("SELECT rowid AS handle FROM import_jobs WHERE owner_id=? AND rowid=? AND started_at=?")
          .bind(owner, Number(cursor.id), cursor.time).first<{handle:number}>();
        if (!anchor) return reply({ error: "INVALID_PAGE" }, 400);
      }
      const rows = await db.prepare(
        "SELECT rowid AS handle,id,source_type,source_id,status,started_at,completed_at FROM import_jobs WHERE owner_id=?"
        + (cursor ? " AND (started_at<? OR (started_at=? AND rowid<?))" : "")
        + " ORDER BY started_at DESC,rowid DESC LIMIT ?"
      ).bind(owner, ...(cursor ? [cursor.time,cursor.time,Number(cursor.id)] : []), args.limit + 1).all<Job>();
      const selected = rows.results.slice(0,args.limit);
      const jobs = [];
      for (const job of selected) {
        const audit = await countAudit(db,job.id);
        // Count the actual destination rows, including a legacy job whose original per-row outcomes are unavailable.
        const destinations = await db.prepare(
          "SELECT (SELECT COUNT(*) FROM lifestyle_days WHERE owner_id=? AND import_job_id=?)"
          + "+(SELECT COUNT(*) FROM body_measurements WHERE owner_id=? AND import_job_id=?) AS n"
        ).bind(owner,job.id,owner,job.id).first<Count>();
        jobs.push({ id:String(job.handle),source:job.source_type,status:job.status,startedAt:job.started_at,
          completedAt:job.completed_at,auditStatus: audit.total===0&&job.status==="confirmed"&&job.source_id==="csv:"+job.source_type
            ? "legacy_unavailable" : audit.total<0||audit.total===0 ? "incomplete" : "available",
          auditCount:audit.total<0?0:audit.total,insertedRecords:destinations?.n??0 });
      }
      const last=selected.at(-1);
      return reply({ jobs,nextCursor:rows.results.length>args.limit&&last
        ?encode({time:last.started_at,id:String(last.handle)}):null });
    }
    const job=await db.prepare("SELECT rowid AS handle,id,source_type,source_id,status,started_at,completed_at FROM import_jobs WHERE owner_id=? AND rowid=?")
      .bind(owner,Number(detail)).first<Job>();
    if (!job) return reply({error:"NOT_FOUND"},404);
    const stats=await countAudit(db,job.id);
    // Count is not recoverable from historical jobs; only detect missing modern audits here.
    const auditStatus=stats.total===0&&job.status==="confirmed"&&job.source_id==="csv:"+job.source_type
      ? "legacy_unavailable" : stats.total<=0 ? "incomplete" : "available";
    const cursor=args.cursor as {row:number}|null;
    if (cursor) {
      const anchor=await db.prepare("SELECT source_row_number FROM import_row_audit WHERE import_job_id=? AND source_row_number=?")
        .bind(job.id,cursor.row).first<{source_row_number:number}>();
      if (!anchor) return reply({error:"INVALID_PAGE"},400);
    }
    const rows=await db.prepare(
      "SELECT a.source_row_number,a.result,a.error_code,"
      + "l.drinking_presence,l.drink_cups,l.steps,b.weight_kg,b.body_fat_pct "
      + "FROM import_row_audit a "
      + "LEFT JOIN lifestyle_days l ON l.owner_id=? AND l.import_job_id=a.import_job_id "
      + "AND l.source_row_key=a.source_row_key AND a.result='inserted' AND ?='lifestyle' "
      + "LEFT JOIN body_measurements b ON b.owner_id=? AND b.import_job_id=a.import_job_id "
      + "AND b.source_row_key=a.source_row_key AND a.result='inserted' AND ?='eclear' "
      + "WHERE a.import_job_id=?"+(cursor?" AND a.source_row_number>?":"")
      + " ORDER BY a.source_row_number ASC LIMIT ?"
    ).bind(owner,job.source_type,owner,job.source_type,job.id,...(cursor?[cursor.row]:[]),args.limit+1).all<Row>();
    const selected=rows.results.slice(0,args.limit);
    const last=selected.at(-1);
    return reply({job:{id:String(job.handle),source:job.source_type,status:job.status,startedAt:job.started_at,
      auditStatus,counts:auditStatus==="available"?stats.counts:null},
      rows:selected.map(r=>({line:r.source_row_number,result:r.result,errorCode:r.error_code,
        values:r.result!=="inserted"?null:job.source_type==="lifestyle"
          ?{drinkingPresence:r.drinking_presence,drinkCups:r.drink_cups,steps:r.steps}
          :{weightKg:r.weight_kg,bodyFatPct:r.body_fat_pct}})),
      nextCursor:rows.results.length>args.limit&&last?encode({row:last.source_row_number}):null});
  } catch {
    return reply({error:"HISTORY_UNAVAILABLE"},503);
  }
}
