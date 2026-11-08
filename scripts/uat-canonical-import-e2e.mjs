// One-shot authenticated real-UAT smoke using SYNTHETIC source data only.
// Never place connected personal health data, hashes, cookies, or D1 rows in logs.
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
const ORIGIN="https://life-log-uat.ha-rookie.workers.dev";
const sha=(s)=>createHash("sha256").update(s).digest("hex");
const randomToken=randomBytes(32).toString("hex");
const tokenHash=sha(randomToken);
const cookie="__Host-life_log_session="+randomToken;
const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
const sql=(command)=>{
  try {
    const out=execFileSync("npx",["--no-install","wrangler","d1","execute",
      "DB","--env","uat","--remote","--json","--command",command],{
      stdio:["ignore","pipe","pipe"],encoding:"utf8",timeout:75000
    });
    const result=JSON.parse(out);const items=Array.isArray(result)?result:[result];
    assert(items.length>0&&items.every(x=>x.success===true),"D1 SQL execution failed");
    return items.flatMap(x=>x.results||[]);
  }catch{throw Error("D1 operation failed; no secret or SQL emitted");}
};
const one=(command)=>{const rows=sql(command);assert(rows.length===1,"One D1 summary row expected");return rows[0];};
const snapshot=()=>one("SELECT "+
 "(SELECT COUNT(*) FROM body_measurements WHERE owner_id='owner') AS weights,"+
 "(SELECT COUNT(*) FROM activity_daily WHERE owner_id='owner') AS steps,"+
 "(SELECT COUNT(*) FROM import_jobs WHERE owner_id='owner') AS jobs,"+
 "(SELECT COUNT(*) FROM import_row_audit) AS audits,"+
 "(SELECT COUNT(*) FROM owner_sessions WHERE owner_id='owner') AS sessions,"+
 "(SELECT COUNT(*) FROM owner_passkey_credentials) AS passkeys");
const request=async(path,body,authenticated=true)=>{
 const response=await fetch(ORIGIN+path,{method:"POST",signal:AbortSignal.timeout(25000),
  redirect:"manual",headers:{
   "Content-Type":"application/json","Origin":ORIGIN,
   "Sec-Fetch-Site":"same-origin","X-Life-Log-Intent":"manual-write-v1",
   ...(authenticated?{"Cookie":cookie}:{})
  },body:JSON.stringify(body)});
 let json={};try{json=await response.json();}catch{/* no user data in output */}
 return {code:response.status,value:json};
};
const expectStatus=(r,status,label)=>assert(r.code===status,label+" expected "+status+" got "+r.code);
const date=one("SELECT date('now','+9 hours','-1 day') AS day").day;
assert(/^\d{4}-\d\d-\d\d$/.test(date),"Invalid JST day");
const eclear="measured_at,weight_kg,body_fat_pct\n"+date+"T07:45:00+09:00,75.4,22.1\n";
const fit="local_day,steps\n"+date+",1234\n";
const correctedEclear="measured_at,weight_kg,body_fat_pct\n"+date+"T07:45:00+09:00,75.8,22.6\n";
const correctedFit="local_day,steps\n"+date+",2010\n";
const ecHash=sha(eclear),fitHash=sha(fit);
const correctionEcHash=sha(correctedEclear),correctionFitHash=sha(correctedFit);
const job=(source,h)=>"owner:"+source+":"+h;
const importJobIds=[job("eclear",ecHash),job("fit",fitHash),
  job("eclear",correctionEcHash),job("fit",correctionFitHash)];
const jobSqlList=importJobIds.map(x=>"'"+x+"'").join(",");
const manualId="synthetic-"+sha(randomToken).slice(0,20);
const pre=snapshot();
let session=false,failed;
try{
 assert(pre.passkeys>=1,"Registered Owner passkey missing");
 const existing=one("SELECT "+
   "(SELECT COUNT(*) FROM body_measurements WHERE owner_id='owner' AND date(measured_at)= '"+date+"') AS w,"+
   "(SELECT COUNT(*) FROM activity_daily WHERE owner_id='owner' AND local_day='"+date+"') AS s");
 assert(existing.w===0&&existing.s===0,"Synthetic day has real records; abort");
 const now=Math.floor(Date.now()/1000);
 sql("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at)"+
   " VALUES('"+tokenHash+"','owner',"+(now+900)+","+now+");");
 session=true;
 sql("INSERT INTO owner_passkey_sessions(token_hash) VALUES('"+tokenHash+"');");
 // Preserve a synthetic manual observation as a second source, exactly like
 // the user's same-day manual data. Neither source may be removed by import.
 sql("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,body_fat_pct,source_id,source_row_key,source_kind)"+
   " VALUES('"+manualId+"-w','owner','"+date+"T07:45:00+09:00',88.1,NULL,'manual:weight','"+manualId+"-w','measured')");
 sql("INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key)"+
   " VALUES('"+manualId+"-s','owner','"+date+"',9100,'manual:steps','"+manualId+"-s')");
 expectStatus(await request("/api/import/confirm",
   {source:"fit",csv:fit,hash:fitHash,confirmed:true},false),403,"anonymous import");
 for(const [source,csv,h] of [["eclear",eclear,ecHash],["fit",fit,fitHash]]){
   expectStatus(await request("/api/import/preview",{source,csv}),200,"preview "+source);
   const first=await request("/api/import/confirm",{source,csv,hash:h,confirmed:true});
   expectStatus(first,200,"confirm "+source);
   assert(first.value.inserted===1,"Row not inserted "+source);
   const second=await request("/api/import/confirm",{source,csv,hash:h,confirmed:true});
   expectStatus(second,200,"idempotent replay "+source);
   assert(second.value.status==="already_imported","Duplicate status incorrect "+source);
 }
 // A DIFFERENT CSV whose calendar day or ECLEAR timestamp overlaps
 // must update the canonical value without replacing the manual record.
 for(const [source,csv,h] of [["eclear",correctedEclear,correctionEcHash],
                              ["fit",correctedFit,correctionFitHash]]){
   const changed=await request("/api/import/confirm",{source,csv,hash:h,confirmed:true});
   expectStatus(changed,200,"canonical correction "+source);
   assert(changed.value.inserted===0&&changed.value.updated===1&&changed.value.skipped===0,
     "Canonical CSV correction was not audited as updated "+source);
   const replay=await request("/api/import/confirm",{source,csv,hash:h,confirmed:true});
   expectStatus(replay,200,"canonical correction replay "+source);
   assert(replay.value.status==="already_imported"&&replay.value.updated===0&&replay.value.skipped===1,
     "Corrected CSV replay not idempotent "+source);
 }
 // A byte-identical OLD file may not silently revert a newer CSV correction.
 for(const [source,csv,h] of [["eclear",eclear,ecHash],["fit",fit,fitHash]]){
   const old=await request("/api/import/confirm",{source,csv,hash:h,confirmed:true});
   expectStatus(old,200,"original CSV replay "+source);
   assert(old.value.updated===0&&old.value.skipped===1,"Old CSV replay rewrote canonical value");
 }
 const corrected=one("SELECT"+
   " (SELECT COUNT(*) FROM body_measurements WHERE owner_id='owner' AND source_id='csv:eclear' AND weight_kg=75.8 AND body_fat_pct=22.6 AND import_job_id='"+job("eclear",ecHash)+"') AS ew,"+
   " (SELECT COUNT(*) FROM activity_daily WHERE owner_id='owner' AND source_id='fit' AND steps=2010 AND import_job_id='"+job("fit",fitHash)+"') AS fs,"+
   " (SELECT COUNT(*) FROM body_measurements WHERE id='"+manualId+"-w' AND weight_kg=88.1) AS mw,"+
   " (SELECT COUNT(*) FROM activity_daily WHERE id='"+manualId+"-s' AND steps=9100) AS ms,"+
   " (SELECT COUNT(*) FROM import_row_audit WHERE import_job_id IN ('"+job("eclear",correctionEcHash)+"','"+job("fit",correctionFitHash)+"') AND result='inserted' AND error_code='UPDATED') AS audited");
 assert(corrected.ew===1&&corrected.fs===1&&corrected.mw===1&&corrected.ms===1&&corrected.audited===2,
   "Canonical update or manual preservation mismatch");
 console.log("PASS: existing manual values preserved; differing Fit/ECLEAR CSV corrections updated canonical rows; exact replay skipped; updated audit preserved.");
 const inserted=one("SELECT "+
   "(SELECT COUNT(*) FROM body_measurements WHERE owner_id='owner' AND source_id='csv:eclear' AND import_job_id='"+job("eclear",ecHash)+"') AS w,"+
   "(SELECT COUNT(*) FROM activity_daily WHERE owner_id='owner' AND source_id='fit' AND import_job_id='"+job("fit",fitHash)+"') AS s,"+
   "(SELECT COUNT(*) FROM import_row_audit WHERE import_job_id IN ("+jobSqlList+")) AS a");
 assert(inserted.w===1&&inserted.s===1&&inserted.a===4,"D1 provenance/audit mismatch");
 console.log("PASS: existing UAT Owner authenticated original-source normalized preview/confirm/retry, ECLEAR weight and Fit steps persisted and source-audited.");
}catch(e){failed=e;console.error("FAIL: "+e.message);}
finally{
 try{
  // Each cleanup is strictly scoped to this one synthetic import job.
  sql("DELETE FROM import_row_audit WHERE import_job_id IN ("+jobSqlList+");");
  sql("DELETE FROM body_measurements WHERE owner_id='owner' AND import_job_id='"+job("eclear",ecHash)+"';");
  sql("DELETE FROM activity_daily WHERE owner_id='owner' AND import_job_id='"+job("fit",fitHash)+"';");
  sql("DELETE FROM body_measurements WHERE owner_id='owner' AND id='"+manualId+"-w';");
  sql("DELETE FROM activity_daily WHERE owner_id='owner' AND id='"+manualId+"-s';");
  sql("DELETE FROM import_jobs WHERE owner_id='owner' AND id IN ("+jobSqlList+");");
  if(session)sql("DELETE FROM owner_sessions WHERE owner_id='owner' AND token_hash='"+tokenHash+"';");
  const after=snapshot();
  for(const key of Object.keys(pre))assert(pre[key]===after[key],"Cleanup mismatch: "+key);
  console.log("PASS: synthetic rows, source import audit and temporary Owner session completely cleaned; personal data unchanged.");
 }catch(e){failed??=e;console.error("CLEANUP_FAILED: "+e.message);}
}
if(failed)process.exitCode=1;
