import {hash, MAX_BYTES} from "../shared/csv-import";
import {inspectOfficialEclearComposition} from "../shared/source-adapter";
import {isSafeLocalImport, type ImportDb, type Statement} from "./import";
import {
  readEclearEnrichmentPlan, ECLEAR_FIELDS,
  type EclearEnrichmentSnapshot,
  type Field
} from "./eclear-enrichment";

const VERSION="eclear-enrichment-v2";
const TTL_MS=5*60*1000;
const HEADERS={
  "Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer"
};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:HEADERS});
const error=(code:string,status=409)=>json({error:code},status);
const enc=new TextEncoder();
const hex=(bytes:Uint8Array)=>Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
const fromHex=(raw:string)=>Uint8Array.from(raw.match(/../g)!.map(x=>parseInt(x,16)));

export type EclearEnrichmentConfig={
  enabled?:string;
  reviewKey?:string;
  remote?:{
    enabled?:string;
    target?:string;
    origin?:string;
    /** Set only after the Worker router has verified a stored passkey session. */
    passkeySession?:boolean;
  };
};

const UAT_ORIGIN="https://life-log-uat.ha-rookie.workers.dev";
const hasReviewKey=(key:unknown):key is string=>
  typeof key==="string" && enc.encode(key).length>=32;

/** Local test flag is independent from any UAT opt-in. Never deploy it. */
export function isSafeLocalEclear(request:Request,config:EclearEnrichmentConfig):boolean{
  return isSafeLocalImport(request,config.enabled)
    && hasReviewKey(config.reviewKey)
    && request.headers.get("X-Life-Log-Intent")===VERSION
    && request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")===true;
}

/**
 * Remote UAT is deliberately separate from LOCAL_ONLY and manual import flags.
 * Origin and Host alone are forgeable, so they are never sufficient: the
 * Worker MUST also prove an Owner passkey session before passing true.
 * No CORS is granted and the exact canonical HTTPS UAT origin is pinned.
 */
export function isSafeRemoteEclear(request:Request,config:EclearEnrichmentConfig):boolean{
  const remote=config.remote;
  if(remote?.enabled!=="true"||remote.target!=="uat"||
     remote.origin!==UAT_ORIGIN||remote.passkeySession!==true||
     !hasReviewKey(config.reviewKey)||request.method!=="POST")return false;
  const url=new URL(request.url);
  if(url.origin!==UAT_ORIGIN||url.username||url.password||url.search||url.hash)return false;
  if(request.headers.get("Origin")!==UAT_ORIGIN||
     request.headers.get("Sec-Fetch-Site")!=="same-origin")return false;
  return request.headers.get("X-Life-Log-Intent")===VERSION
    && request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")===true;
}

async function mac(key:string,message:string):Promise<string>{
  const secret=await crypto.subtle.importKey("raw",enc.encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC",secret,enc.encode(message))));
}
async function verify(key:string,message:string,signature:string):Promise<boolean>{
  if(!/^[0-9a-f]{64}$/.test(signature))return false;
  const secret=await crypto.subtle.importKey("raw",enc.encode(key),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  return crypto.subtle.verify("HMAC",secret,fromHex(signature),enc.encode(message));
}
function signInput(owner:string,fileHash:string,digest:string,expiry:string):string{
  return JSON.stringify([VERSION,owner,fileHash,digest,expiry]);
}
async function snapshotHash(owner:string,fileHash:string,snapshots:EclearEnrichmentSnapshot[]):Promise<string>{
  // Private: never expose raw stored values, identities or incoming measurement values.
  return hash(JSON.stringify([VERSION,owner,fileHash,snapshots.map(s=>[
    s.incoming, s.existing.map(row=>[
      row.id,row.source_id,row.measured_at,
      ...ECLEAR_FIELDS.map(([,column])=>row[column])
    ])
  ])]));
}
type Plan=Awaited<ReturnType<typeof readEclearEnrichmentPlan>>;

function exactSnapshotGuard(db:ImportDb,owner:string,s:EclearEnrichmentSnapshot):Statement{
  const day=s.incoming.measuredAt.slice(0,10);
  const conditions=[
    "(SELECT COUNT(*) FROM body_measurements WHERE owner_id=? AND (measured_at=? OR measured_at=?))=?"
  ];
  const args:unknown[]=[owner,s.incoming.measuredAt,day,s.existing.length];
  for(const row of s.existing){
    conditions.push("EXISTS(SELECT 1 FROM body_measurements WHERE owner_id=? AND id=? AND source_id=? AND measured_at=? AND "+
      ECLEAR_FIELDS.map(([,column])=>column+" IS ?").join(" AND ")+")");
    args.push(owner,row.id,row.source_id,row.measured_at,
      ...ECLEAR_FIELDS.map(([,column])=>row[column]));
  }
  return db.prepare("INSERT INTO eclear_enrichment_asserts(passed) VALUES("+
    "CASE WHEN "+conditions.join(" AND ")+" THEN 1 ELSE 0 END)").bind(...args);
}

function updatedSnapshotGuard(
  db:ImportDb,owner:string,id:string,s:EclearEnrichmentSnapshot
):Statement{
  const original=s.existing.find(x=>x.id===id);
  if(!original)throw Error("ECLEAR_NO_CANONICAL_ROW");
  const expected=ECLEAR_FIELDS.map(([key,column])=>
    s.incoming[key]===null?original[column]:s.incoming[key]);
  return db.prepare("INSERT INTO eclear_enrichment_asserts(passed) VALUES("+
    "CASE WHEN (SELECT COUNT(*) FROM body_measurements WHERE owner_id=? AND id=? AND "+
    ECLEAR_FIELDS.map(([,column])=>column+" IS ?").join(" AND ")+
    ")=1 THEN 1 ELSE 0 END)").bind(owner,id,...expected);
}
function insertRow(
  db:ImportDb,owner:string,measurementId:string,fileHash:string,
  rowNumber:number,s:EclearEnrichmentSnapshot,fingerprint:string
):Statement{
  const columns=ECLEAR_FIELDS.map(([,col])=>col);
  const query="INSERT INTO body_measurements("+
    "id,owner_id,measured_at,source_timezone,"+columns.join(",")+
    ",source_id,source_row_key,reliable_fingerprint,source_kind) VALUES("+
    ["?","?","?","'Asia/Tokyo'",...columns.map(()=>"?"),"'csv:eclear'","?","?","'measured'"].join(",")+")";
  return db.prepare(query).bind(
    measurementId,owner,s.incoming.measuredAt,
    ...ECLEAR_FIELDS.map(([key])=>s.incoming[key]),
    VERSION+":"+fileHash+":"+rowNumber,fingerprint
  );
}
function updateRow(
  db:ImportDb,owner:string,measurementId:string,s:EclearEnrichmentSnapshot,keys:Field[]
):Statement{
  const columns=keys.map(key=>ECLEAR_FIELDS.find(([candidate])=>candidate===key)![1]);
  return db.prepare(
    "UPDATE body_measurements SET "+columns.map(col=>col+"=?").join(",")+
    " WHERE owner_id=? AND id=? AND source_id='csv:eclear' AND measured_at=? AND "+
    columns.map(col=>col+" IS NULL").join(" AND ")
  ).bind(...keys.map(key=>s.incoming[key]),owner,measurementId,s.incoming.measuredAt);
}
function auditCells(
  db:ImportDb,owner:string,measurementId:string,jobId:string,
  s:EclearEnrichmentSnapshot,keys:Field[]
):Statement[]{
  return keys.map(key=>{
    const col=ECLEAR_FIELDS.find(([candidate])=>candidate===key)![1];
    const value=s.incoming[key];
    if(value===null)throw Error("ECLEAR_MISSING_AUDIT_VALUE");
    return db.prepare(
      "INSERT INTO eclear_enrichment_cell_audit("+
      "owner_id,measurement_id,field_name,job_id,old_value,new_value) VALUES(?,?,?,?,NULL,?)"
    ).bind(owner,measurementId,col,jobId,value);
  });
}

async function commitPlan(
  db:ImportDb,owner:string,fileHash:string,digest:string,plan:Plan
):Promise<{inserted:number;enriched:number;cells:number}|null>{
  const preview=plan.preview;
  if(preview.conflictMeasurements>0)return null;
  const changes=preview.classifications.filter(x=>x.status==="new"||x.status==="enrich");
  if(changes.length===0)return {inserted:0,enriched:0,cells:0};

  const jobId=crypto.randomUUID();
  const now=new Date().toISOString();
  const ops:Statement[]=[];
  // Every original row, including unchanged ones, is rechecked INSIDE the
  // transaction. If anything changed, a CHECK violation rolls back the batch.
  for(const snapshot of plan.snapshots)ops.push(exactSnapshotGuard(db,owner,snapshot));
  ops.push(db.prepare("INSERT INTO eclear_enrichment_jobs("+
    "id,owner_id,contract_version,file_sha256,snapshot_sha256,"+
    "inserted_measurements,enriched_measurements,enriched_cells,created_at)"+
    " VALUES(?,?,?,?,?,?,?,?,?)").bind(
    jobId,owner,VERSION,fileHash,digest,
    preview.newMeasurements,preview.enrichMeasurements,
    preview.enrichCells,now
  ));
  let auditedRows=0,auditedCells=0;
  for(let i=0;i<plan.snapshots.length;i++){
    const s=plan.snapshots[i],cls=preview.classifications[i];
    if(cls.status!=="new"&&cls.status!=="enrich")continue;
    const created=cls.status==="new";
    const id=created?crypto.randomUUID():
      s.existing.find(x=>x.source_id==="csv:eclear"&&x.measured_at===s.incoming.measuredAt)!.id;
    const keys:Field[]=created
      ?ECLEAR_FIELDS.filter(([key])=>s.incoming[key]!==null).map(([key])=>key)
      :cls.enrichFields;
    if(created){
      const fingerprint=await hash(JSON.stringify([
        "eclear-v1",s.incoming.measuredAt,s.incoming.weightKg,s.incoming.bodyFatPct
      ]));
      ops.push(insertRow(db,owner,id,fileHash,cls.line,s,fingerprint));
    }else{
      ops.push(updateRow(db,owner,id,s,keys));
      ops.push(updatedSnapshotGuard(db,owner,id,s));
    }
    ops.push(db.prepare(
      "INSERT INTO eclear_enrichment_row_audit("+
      "id,job_id,source_row_number,measurement_id,result,changed_cells)"+
      " VALUES(?,?,?,?,?,?)"
    ).bind(crypto.randomUUID(),jobId,cls.line,id,created?"inserted":"enriched",keys.length));
    ops.push(...auditCells(db,owner,id,jobId,s,keys));
    auditedRows++;auditedCells+=keys.length;
  }
  // A failed audit assertion must rollback the job AND all measurement changes.
  ops.push(db.prepare(
    "INSERT INTO eclear_enrichment_asserts(passed) VALUES(CASE WHEN "+
    "(SELECT COUNT(*) FROM eclear_enrichment_row_audit WHERE job_id=?)=? AND "+
    "(SELECT COUNT(*) FROM eclear_enrichment_cell_audit WHERE job_id=?)=? "+
    "THEN 1 ELSE 0 END)"
  ).bind(jobId,auditedRows,jobId,auditedCells));
  ops.push(db.prepare("DELETE FROM eclear_enrichment_asserts"));
  if(auditedRows!==changes.length ||
    preview.enrichCells!==plan.preview.classifications.reduce((n,c)=>
      n+(c.status==="enrich"?c.enrichFields.length:0),0))throw Error("ECLEAR_PLAN_MISMATCH");
  const out=await db.batch(ops);
  if(out.length!==ops.length)throw Error("ECLEAR_BATCH_INCOMPLETE");
  return {inserted:preview.newMeasurements,enriched:preview.enrichMeasurements,cells:preview.enrichCells};
}

/**
 * Separate owner-only ECLEAR v2 endpoint, guarded at the Worker router as well.
 * This function never receives Access identity from a request header.
 * Preview is read-only. Confirm requires local opt-in or independently gated
 * UAT Owner passkey session, canonical Origin, intent and signing key.
 */
export async function handleEclearEnrichment(
  request:Request,db:ImportDb,owner:string,config:EclearEnrichmentConfig
):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path!=="/api/eclear/enrichment/preview"&&path!=="/api/eclear/enrichment/confirm")return error("NOT_FOUND",404);
  if(request.method!=="POST")return error("METHOD",405);
  // Authorization and feature flags are validated before parsing/reading any
  // enrichment data. Keep the existing client error contract fail-closed.
  if(owner!=="owner"||
     !(isSafeLocalEclear(request,config)||isSafeRemoteEclear(request,config)))
    return error("ECLEAR_LOCAL_DISABLED",403);
  let payload:unknown;
  try{
    if(Number(request.headers.get("Content-Length")||0)>MAX_BYTES*2)return error("SIZE",413);
    const raw=await request.text();
    if(enc.encode(raw).length>MAX_BYTES*2)return error("SIZE",413);
    payload=JSON.parse(raw);
  }catch{return error("JSON_INVALID",400);}
  if(!payload||typeof payload!=="object"||Array.isArray(payload))return error("PAYLOAD_INVALID",400);
  const p=payload as Record<string,unknown>;
  if(Object.keys(p).some(key=>key!=="csv"&&key!=="token") ||
    typeof p.csv!=="string"||enc.encode(p.csv).length>MAX_BYTES)return error("PAYLOAD_INVALID",400);
  if(path.endsWith("/preview")&&p.token!==undefined)return error("PAYLOAD_INVALID",400);
  if(path.endsWith("/confirm")&&typeof p.token!=="string")return error("CONFIRM_REQUIRED",409);
  let measurements;
  try{
    measurements=inspectOfficialEclearComposition(p.csv);
    if(measurements.length>40)throw Error("TOO_MANY_ROWS");
  }catch{return error("CSV_INVALID",422);}
  let plan:Plan;
  let fileHash:string,digest:string;
  try{
    fileHash=await hash(p.csv);
    plan=await readEclearEnrichmentPlan(db,owner,measurements);
    digest=await snapshotHash(owner,fileHash,plan.snapshots);
  }catch{return error("ECLEAR_DATA_UNAVAILABLE",503);}

  const key=config.reviewKey!;
  if(path.endsWith("/preview")){
    const expiry=String(Date.now()+TTL_MS);
    const signature=await mac(key,signInput(owner,fileHash,digest,expiry));
    return json({status:"preview",...plan.preview,reviewToken:expiry+"."+digest+"."+signature});
  }
  const token=p.token as string;
  const match=/^(\d{13})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(token);
  if(!match)return error("REVIEW_STALE",409);
  const [,expiry,reviewedDigest,signature]=match;
  if(Number(expiry)<=Date.now()||Number(expiry)>Date.now()+TTL_MS||
    reviewedDigest!==digest||
    !(await verify(key,signInput(owner,fileHash,reviewedDigest,expiry),signature)))
    return error("REVIEW_STALE",409);
  if(plan.preview.conflictMeasurements>0)return error("ECLEAR_CONFLICT",409);
  try{
    const outcome=await commitPlan(db,owner,fileHash,digest,plan);
    if(outcome===null)return error("ECLEAR_CONFLICT",409);
    return json({status:outcome.inserted||outcome.enriched?"applied":"unchanged",...outcome});
  }catch{
    // A stale concurrent snapshot, unique audit key or D1 error fails closed.
    // Do not claim that a timed-out or failed commit succeeded.
    return error("ECLEAR_REVIEW_OR_WRITE_FAILED",409);
  }
}
