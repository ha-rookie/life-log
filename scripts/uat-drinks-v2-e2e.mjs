/**
 * Post-release UAT synthetic-only beer/mega acceptance on existing Owner session API.
 * No personal rows, tokens, SQL responses, or Secrets printed; synthetic rows
 * and temporary short-lived passkey-scoped session always removed in finally.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
const origin="https://life-log-uat.ha-rookie.workers.dev";
const assert=(ok,why)=>{if(!ok)throw Error(why);};
const execSql=(query)=>{
  let data;
  try{
    data=execFileSync("npx",["--no-install","wrangler","d1","execute","DB","--env","uat","--remote","--json","--command",query],
      {encoding:"utf8",timeout:90000,stdio:["ignore","pipe","pipe"]});
  }catch(e){throw Error("UAT D1 synthetic operation failed (exit="+(e.status??"unknown")+")");}
  const parsed=JSON.parse(data);
  const items=Array.isArray(parsed)?parsed:[parsed];
  assert(items.length>0&&items.every(x=>x.success===true),"UAT D1 rejected synthetic operation");
  return items.flatMap(x=>x.results??[]);
};
const stats=()=>execSql("SELECT "+
  "(SELECT COUNT(*) FROM owners WHERE id='owner') owners,"+
  "(SELECT COUNT(*) FROM owner_passkey_credentials) passkeys,"+
  "(SELECT COUNT(*) FROM owner_sessions) sessions,"+
  "(SELECT COUNT(*) FROM owner_passkey_sessions) passkey_sessions,"+
  "(SELECT COUNT(*) FROM body_measurements) weights,"+
  "(SELECT COUNT(*) FROM activity_daily) steps,"+
  "(SELECT COUNT(*) FROM lifestyle_days) lifestyle,"+
  "(SELECT COUNT(*) FROM drink_entries) drinks,"+
  "(SELECT COALESCE(SUM(cups),0) FROM drink_entries) drink_cups")[0];
const before=stats();
assert(before&&before.owners===1&&before.passkeys>=1,"Owner passkey absent; no mutation");
const token=randomBytes(32).toString("hex");
const hash=createHash("sha256").update(token).digest("hex");
const cookie="__Host-life_log_session="+token;
const key=randomUUID(), legacyKey=randomUUID();
const at=new Date().toISOString();
const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
let sessionCreated=false,error;
async function call(path,method="GET",body,auth=true,spoof=false){
  const headers={
    ...(auth?{Cookie:cookie}:{}),
    ...(method==="GET"?{}:{"Origin":spoof?"https://evil.invalid":origin,
      "Sec-Fetch-Site":"same-origin","Content-Type":"application/json",
      "X-Life-Log-Intent":"manual-write-v1"})
  };
  const res=await fetch(origin+path,{method,headers,redirect:"manual",signal:AbortSignal.timeout(20000),
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=await res.text();let json={};
  try{json=JSON.parse(raw);}catch{/* UI or CSV response */}
  return {status:res.status,json,raw};
}
const expectStatus=(r,s,context)=>assert(r.status===s,context+" returned "+r.status+" (expected "+s+")");
try{
  const now=Math.floor(Date.now()/1000);
  execSql("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES('"+
    hash+"','owner',"+(now+600)+","+now+")");
  sessionCreated=true;
  execSql("INSERT INTO owner_passkey_sessions(token_hash) VALUES('"+hash+"')");
  expectStatus(await call("/api/mvp/drinks"),200,"Owner drink list");
  expectStatus(await call("/api/mvp/drinks","GET",undefined,false),403,"Anonymous list");
  expectStatus(await call("/api/mvp/drinks","POST",{key,kind:"beer",observedAt:at},false),403,"Anonymous write");
  expectStatus(await call("/api/mvp/drinks","POST",{key,kind:"beer",observedAt:at},true,true),403,"Cross-origin write");
  const beer={key,kind:"beer",observedAt:at,cups:2,size:"large",volumeMl:500,abvPct:5};
  expectStatus(await call("/api/mvp/drinks","POST",beer),200,"Beer creation");
  expectStatus(await call("/api/mvp/drinks","POST",beer),200,"Idempotent repeat");
  expectStatus(await call("/api/mvp/drinks","POST",{...beer,cups:3}),409,"Conflicting repeat");
  let own=await call("/api/mvp/drinks");
  expectStatus(own,200,"Read after beer creation");
  assert(own.json.entries?.some(x=>x.key===key&&x.kind==="beer"&&x.cups===2&&
    x.size==="large"&&x.volumeMl===500&&x.abvPct===5),"Beer result lacks size/cups");
  const modified={...beer,cups:2,size:"mega",volumeMl:700,
    expectedObservedAt:at,expectedKind:"beer",
    expectedCups:2,expectedSize:"large",expectedVolumeMl:500,expectedAbvPct:5};
  expectStatus(await call("/api/mvp/drinks","PATCH",modified),200,"Mega correction");
  own=await call("/api/mvp/drinks");
  assert(own.json.entries?.some(x=>x.key===key&&x.size==="mega"&&x.volumeMl===700),
    "Mega correction not visible");
  const unknown={key:legacyKey,kind:"highball",observedAt:at};
  expectStatus(await call("/api/mvp/drinks","POST",unknown),200,"Legacy highball entry");
  own=await call("/api/mvp/drinks");
  assert(own.json.entries?.some(x=>x.key===legacyKey&&x.cups===1&&x.size===null&&
    x.volumeMl===null&&x.abvPct===null),"Unknown alcohol amount was invented");
  const exported=await call("/api/mvp/export?from="+day+"&to="+day);
  expectStatus(exported,200,"Detailed owner CSV");
  assert(exported.raw.includes(',"ordered_cups","manual:drink","beer"')&&
    exported.raw.includes(',"g","manual:drink","beer"')&&
    exported.raw.includes('"56","g","manual:drink","beer"'),
    "CSV beer volume or pure alcohol differs from expected");
  const comparison=await call("/api/mvp/compare?"+
    new URLSearchParams({aFrom:day,aTo:day,bFrom:new Date(Date.now()+9*3600000-172800000).toISOString().slice(0,10),
    bTo:new Date(Date.now()+9*3600000-86400000).toISOString().slice(0,10)}));
  expectStatus(comparison,200,"Period comparison");
  assert(comparison.json.a?.drinking?.recordedAlcoholCups>=3,
    "Missing recorded ordered alcohol cups in period comparison");
  expectStatus(await call("/api/mvp/drinks","DELETE",{
    key,expectedObservedAt:at,expectedKind:"beer"}),200,"Delete mega beer");
  expectStatus(await call("/api/mvp/drinks","DELETE",{
    key:legacyKey,expectedObservedAt:at,expectedKind:"highball"}),200,"Delete legacy highball");
  console.log("PASS: Owner beer/mega and legacy drinks CRUD/retry, 56g CSV, comparisons, negative auth");
}catch(e){error=e;console.error("FAIL: "+e.message);}
finally{
  try{
    execSql("DELETE FROM drink_entries WHERE owner_id='owner' AND source_id='manual:drink'"+
      " AND source_row_key IN ('"+key+"','"+legacyKey+"')");
    if(sessionCreated)execSql("DELETE FROM owner_sessions WHERE owner_id='owner' AND token_hash='"+hash+"'");
    const after=stats();
    assert(Object.keys(before).every(k=>before[k]===after[k]),
      "Original UAT Owner record-count invariant changed during synthetic acceptance");
    console.log("PASS: synthetic records and temporary session removed; original data and passkey counts preserved");
  }catch(e){error??=e;console.error("CLEANUP_FAILED: "+e.message);}
}
if(error)process.exitCode=1;
