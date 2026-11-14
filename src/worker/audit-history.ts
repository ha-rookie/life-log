import type { ImportDb } from "./import";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
type Job = { handle: number; id: string; source_type: string; source_id: string; status: string; started_at: string; completed_at: string | null };
type Count = { n: number };
type Outcome = { result: string; error_code: string|null; n: number };
type Row = { source_row_number: number; result: string; error_code: string | null;
  drinking_presence: number | null; drink_cups: number | null; steps: number | null;
  weight_kg: number | null; body_fat_pct: number | null; fit_steps: number|null };
type Cursor = { time: string; id: string } | { row: number };
/** Only contract-approved public audit classification codes may leave the Worker. */
const PUBLIC_AUDIT_ERRORS = new Set(["LIFESTYLE_CONFLICT_KEPT","AMBIGUOUS_ECLEAR_TIMESTAMP"]);
const originalHashFromMarker=(marker:string):string|null=>{
  const found=/^csv:audited-(?:v2:(?:eclear|lifestyle|fit|weight_day)|v3:lifestyle_weight):raw-utf8-sha256:([0-9a-f]{64})$/.exec(marker);
  return found?.[1]??null;
};
const publicAuditError = (code:string|null):string|null =>
  code!==null && PUBLIC_AUDIT_ERRORS.has(code) ? code : null;
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
  const r = await db.prepare("SELECT result,error_code,COUNT(*) AS n FROM import_row_audit WHERE import_job_id=? GROUP BY result,error_code")
    .bind(job).all<Outcome>();
  const counts = { inserted: 0, updated: 0, skipped: 0, conflict: 0, invalid: 0 };
  for (const item of r.results) {
    if (item.result === "inserted" && item.error_code === "UPDATED") { counts.updated += item.n; continue; }
    if (!(item.result in counts)) return { counts, total: -1 };
    counts[item.result as keyof typeof counts] += item.n;
  }
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
// V3 counts expected target outcomes independently from the original one-row audit.
// Never confuse 2 destinations from one CSV row with an incomplete legacy audit.
type TargetOutcome = {result:string;error_code:string|null;n:number};
async function v3TargetStatus(db:ImportDb,job:string,sourceRows:number,insertedDestinations:number){
  const manifest=await db.prepare(
    "SELECT expected_source_rows AS rows,expected_target_rows AS targets,contract_version AS version"+
    " FROM import_job_target_manifest WHERE import_job_id=?"
  ).bind(job).first<{rows:number;targets:number;version:string}>();
  if(!manifest||manifest.version!=="v3"||manifest.rows!==sourceRows)return null;
  const outcomes=await db.prepare(
    "SELECT result,error_code,COUNT(*) AS n FROM import_target_audit"+
    " WHERE import_job_id=? GROUP BY result,error_code"
  ).bind(job).all<TargetOutcome>();
  const counts={inserted:0,skipped:0,conflict:0};
  let total=0;
  for(const item of outcomes.results){
    if(!(item.result in counts))return null;
    counts[item.result as keyof typeof counts]+=item.n;
    total+=item.n;
  }
  return {complete:total===manifest.targets&&counts.inserted===insertedDestinations,
    counts,expectedTargets:manifest.targets,auditCount:total};
}
// Compare persisted inserted destinations with their recorded audit outcomes.
// Without an original expected-row count, missing skipped/conflict audits remain undetectable.
async function countDestinations(db: ImportDb, owner: string, job: string): Promise<number> {
  const result = await db.prepare(
    "SELECT (SELECT COUNT(*) FROM lifestyle_days WHERE owner_id=? AND import_job_id=?)"
    + "+(SELECT COUNT(*) FROM body_measurements WHERE owner_id=? AND import_job_id=?)"
    + "+(SELECT COUNT(*) FROM activity_daily WHERE owner_id=? AND import_job_id=?) AS n"
  ).bind(owner, job, owner, job, owner, job).first<Count>();
  if (!result || !Number.isSafeInteger(result.n) || result.n < 0) throw Error("DESTINATION_COUNT_UNAVAILABLE");
  return result.n;
}
function auditStatus(job: Job, audit: Awaited<ReturnType<typeof countAudit>>, insertedRecords: number,
  targetEvidence:Awaited<ReturnType<typeof v3TargetStatus>>|null=null) {
  if(job.source_type==="lifestyle_weight")
    return audit.total<=0||!targetEvidence?.complete?"incomplete":"available";
  if (audit.total === 0 && job.status === "confirmed" && job.source_id === "csv:" + job.source_type) {
    return "legacy_unavailable";
  }
  return audit.total <= 0 || audit.counts.inserted !== insertedRecords ? "incomplete" : "available";
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
        const insertedRecords = await countDestinations(db,owner,job.id);
        const v3=job.source_type==="lifestyle_weight"
          ?await v3TargetStatus(db,job.id,audit.total,insertedRecords):null;
        jobs.push({ id:String(job.handle),source:job.source_type,status:job.status,startedAt:job.started_at,
          completedAt:job.completed_at,auditStatus:auditStatus(job,audit,insertedRecords,v3),
          auditCount:audit.total<0?0:audit.total,insertedRecords,
          ...(v3?{targetAuditCount:v3.auditCount,expectedTargets:v3.expectedTargets}:{}),
          originalSha256:originalHashFromMarker(job.source_id) });
      }
      const last=selected.at(-1);
      return reply({ jobs,nextCursor:rows.results.length>args.limit&&last
        ?encode({time:last.started_at,id:String(last.handle)}):null });
    }
    const job=await db.prepare("SELECT rowid AS handle,id,source_type,source_id,status,started_at,completed_at FROM import_jobs WHERE owner_id=? AND rowid=?")
      .bind(owner,Number(detail)).first<Job>();
    if (!job) return reply({error:"NOT_FOUND"},404);
    const stats=await countAudit(db,job.id);
    const insertedRecords=await countDestinations(db,owner,job.id);
    const v3=job.source_type==="lifestyle_weight"
      ?await v3TargetStatus(db,job.id,stats.total,insertedRecords):null;
    const status=auditStatus(job,stats,insertedRecords,v3);
    const cursor=args.cursor as {row:number}|null;
    if (cursor) {
      const anchor=await db.prepare("SELECT source_row_number FROM import_row_audit WHERE import_job_id=? AND source_row_number=?")
        .bind(job.id,cursor.row).first<{source_row_number:number}>();
      if (!anchor) return reply({error:"INVALID_PAGE"},400);
    }
    const rows=await db.prepare(
      "SELECT a.source_row_number,a.result,a.error_code,"
      + "l.drinking_presence,l.drink_cups,l.steps,b.weight_kg,b.body_fat_pct,"
      + "f.steps AS fit_steps "
      + "FROM import_row_audit a "
      + "LEFT JOIN lifestyle_days l ON l.owner_id=? AND l.import_job_id=a.import_job_id "
      + "AND l.source_row_key=a.source_row_key AND a.result='inserted' AND ? IN ('lifestyle','lifestyle_weight') "
      + "LEFT JOIN body_measurements b ON b.owner_id=? AND b.import_job_id=a.import_job_id "
      + "AND b.source_row_key=a.source_row_key AND a.result='inserted' AND ?='eclear' "
      + "LEFT JOIN activity_daily f ON f.owner_id=? AND f.import_job_id=a.import_job_id "
      + "AND f.source_row_key=a.source_row_key AND a.result='inserted' AND ?='fit' "
      + "WHERE a.import_job_id=?"+(cursor?" AND a.source_row_number>?":"")
      + " ORDER BY a.source_row_number ASC LIMIT ?"
    ).bind(owner,job.source_type,owner,job.source_type,owner,job.source_type,job.id,...(cursor?[cursor.row]:[]),args.limit+1).all<Row>();
    const selected=rows.results.slice(0,args.limit);
    const targetByRow=new Map<number,{target:string;result:string;errorCode:string|null}[]>();
    if(job.source_type==="lifestyle_weight"&&selected.length){
      const markers=selected.map(() => "?").join(",");
      const rows=await db.prepare(
        "SELECT source_row_number,target_type,result,error_code FROM import_target_audit"+
        " WHERE import_job_id=? AND source_row_number IN ("+markers+")"+
        " ORDER BY source_row_number,target_type"
      ).bind(job.id,...selected.map(r=>r.source_row_number))
       .all<{source_row_number:number;target_type:string;result:string;error_code:string|null}>();
      for(const row of rows.results){
        const target=targetByRow.get(row.source_row_number)??[];
        target.push({target:row.target_type,result:row.result,errorCode:publicAuditError(row.error_code)});
        targetByRow.set(row.source_row_number,target);
      }
    }
    const last=selected.at(-1);
    return reply({job:{id:String(job.handle),source:job.source_type,status:job.status,startedAt:job.started_at,
      auditStatus:status,counts:status==="available"?stats.counts:null,
      ...(v3?{targetCounts:status==="available"?v3.counts:null,
        expectedTargets:v3.expectedTargets}:{}),
      originalSha256:originalHashFromMarker(job.source_id)},
      rows:selected.map(r=>({line:r.source_row_number,
        result:r.result==="inserted"&&r.error_code==="UPDATED"?"updated":r.result,
        errorCode:publicAuditError(r.error_code),
        ...(job.source_type==="lifestyle_weight"?{targets:targetByRow.get(r.source_row_number)??[]}:{}),
        // Historic before/after values were never stored; do not manufacture
        // past readings by joining today's updated destination rows.
        values:r.error_code==="UPDATED"||r.result!=="inserted"?null:(job.source_type==="lifestyle"||job.source_type==="lifestyle_weight")
          ?{drinkingPresence:r.drinking_presence,drinkCups:r.drink_cups,steps:r.steps}
          :job.source_type==="fit"?{steps:r.fit_steps}
          :{weightKg:r.weight_kg,bodyFatPct:r.body_fat_pct}})),
      nextCursor:rows.results.length>args.limit&&last?encode({row:last.source_row_number}):null});
  } catch {
    return reply({error:"HISTORY_UNAVAILABLE"},503);
  }
}
