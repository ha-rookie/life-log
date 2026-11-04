import { previewCsv,MAX_BYTES,type CsvSource,type CsvRow } from "../shared/csv-import";
export interface Statement { bind(...values:unknown[]):Statement; first<T>():Promise<T|null>; }
export interface ImportDb { prepare(sql:string):Statement; batch(statements:Statement[]):Promise<unknown[]>; }
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
const response=(body:unknown,status=200)=>Response.json(body,{status,headers});
const error=(code:string,status=422)=>response({error:code},status);
type Payload={source:CsvSource;csv:string;confirmed?:boolean;hash?:string};
function valid(x:unknown):x is Payload{
  if(!x||typeof x!=="object"||Array.isArray(x))return false;
  const p=x as Record<string,unknown>;
  return (p.source==="eclear"||p.source==="lifestyle")&&typeof p.csv==="string"&&new TextEncoder().encode(p.csv).length<=MAX_BYTES&&(p.confirmed===undefined||typeof p.confirmed==="boolean")&&(p.hash===undefined||typeof p.hash==="string");
}
function insert(db:ImportDb,owner:string,source:CsvSource,job:string,r:CsvRow):Statement{
  if(source==="eclear")return db.prepare("INSERT OR IGNORE INTO body_measurements(id,owner_id,measured_at,source_timezone,weight_kg,body_fat_pct,source_id,source_row_key,reliable_fingerprint,source_kind,import_job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(job+":"+r.line,owner,r.timestamp,"Asia/Tokyo",r.weight,r.fat,"csv:eclear",r.key,r.fingerprint,"measured",job);
  return db.prepare("INSERT OR IGNORE INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id) VALUES (?,?,?,?,?,?,?,?)")
    .bind(owner,r.day,r.presence,r.cups,r.steps,"csv:lifestyle",r.key,job);
}
export async function handleImport(req:Request,db:ImportDb,owner:string):Promise<Response>{
  if(req.method!=="POST")return error("METHOD",405);
  if(!req.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))return error("CONTENT_TYPE",415);
  if(Number(req.headers.get("Content-Length")||0)>MAX_BYTES*2)return error("SIZE",413);
  let payload:unknown;
  try{const raw=await req.text();if(new TextEncoder().encode(raw).length>MAX_BYTES*2)return error("SIZE",413);payload=JSON.parse(raw);}catch{return error("JSON",400);}
  if(!valid(payload))return error("PAYLOAD",400);
  let p;try{p=await previewCsv(payload.source,payload.csv);}catch{return error("CSV");}
  if(new URL(req.url).pathname==="/api/import/preview")return response(p);
  if(payload.confirmed!==true||payload.hash!==p.hash)return error("CONFIRM_REQUIRED",409);
  if(p.errors.length||!p.rows.length)return error("INVALID_ROWS");
  const keys=new Set<string>();for(const r of p.rows){const k=payload.source==="eclear"?r.fingerprint!:r.day!;if(keys.has(k))return error("DUPLICATE_IN_FILE");keys.add(k);}
  // Owner-specific ID and file digest; no raw CSV or private row data in logs.
  const job=owner+":"+p.hash;
  try{
    const existing=await db.prepare("SELECT status FROM import_jobs WHERE owner_id=? AND source_type=? AND file_sha256=?").bind(owner,payload.source,p.hash).first<{status:string}>();
    if(existing)return existing.status==="confirmed"?response({status:"already_imported",inserted:0,skipped:p.rows.length}):error("JOB_CONFLICT",409);
    const now=new Date().toISOString(),ops:Statement[]=[
      db.prepare("INSERT OR IGNORE INTO owners(id,created_at) VALUES (?,?)").bind(owner,now),
      db.prepare("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)").bind(job,owner,payload.source,"csv:"+payload.source,p.hash,"confirmed",now,now)
    ];
    for(const r of p.rows)ops.push(insert(db,owner,payload.source,job,r));
    // Cloudflare D1 batch is transactional: SQL error rolls back all statements.
    const result=await db.batch(ops);
    if(result.length!==ops.length)throw Error("INCOMPLETE_BATCH");
    const changes=result.slice(2).map(x=>(x as {meta?:{changes?:number}}).meta?.changes);
    if(changes.some(x=>typeof x!=="number"))return error("UNVERIFIED_BATCH",503);
    const inserted=changes.reduce<number>((sum,x)=>sum+(x===1?1:0),0);
    return response({status:"confirmed",inserted,skipped:p.rows.length-inserted});
  }catch{return error("IMPORT_FAILED",503);}
}
