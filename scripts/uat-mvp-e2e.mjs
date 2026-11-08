/**
 * Runs after exact-SHA-gated deployment of life-log-uat.
 * A short-lived synthetic Owner passkey session is created in the existing
 * UAT D1. Synthetic drinks and one experiment are removed in finally.
 * Does not read or log the user's health values. Never prints SQL, cookie,
 * token hash or personal record values.
 */
import {execFileSync} from "node:child_process";
import {randomBytes,randomUUID,createHash} from "node:crypto";
const origin="https://life-log-uat.ha-rookie.workers.dev";
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const sql=(query)=>{
  let payload;
  try {
    payload=execFileSync("npx",["--no-install","wrangler","d1","execute","DB",
      "--env","uat","--remote","--json","--command",query],
      {encoding:"utf8",timeout:90000,stdio:["ignore","pipe","pipe"]});
  }catch(error){throw Error("D1 operation failed (exit="+(Number.isInteger(error.status)?error.status:"unknown")+")");}
  const parsed=JSON.parse(payload);
  const result=Array.isArray(parsed)?parsed:[parsed];
  assert(result.length>0&&result.every(x=>x.success===true),"D1 response was not successful");
  return result.flatMap(x=>x.results??[]);
};
const count=()=>sql("SELECT "+
  "(SELECT COUNT(*) FROM owners WHERE id='owner') AS owners,"+
  "(SELECT COUNT(*) FROM owner_passkey_credentials) AS passkeys,"+
  "(SELECT COUNT(*) FROM owner_sessions) AS sessions,"+
  "(SELECT COUNT(*) FROM body_measurements) AS weights,"+
  "(SELECT COUNT(*) FROM activity_daily) AS steps,"+
  "(SELECT COUNT(*) FROM drink_entries) AS drinks,"+
  "(SELECT COUNT(*) FROM behavior_hypotheses) AS hypotheses,"+
  "(SELECT COUNT(*) FROM behavior_experiments) AS experiments")[0];
const token=randomBytes(32).toString("hex");
const tokenHash=createHash("sha256").update(token).digest("hex");
const cookie="__Host-life_log_session="+token;
const drinkKey1=randomUUID(),drinkKey2=randomUUID(),planId=randomUUID();
const current=new Date().toISOString();
const day=(ago)=>new Date(Date.now()+9*3600000-ago*86400000).toISOString().slice(0,10);
const before=count();
assert(before&&before.owners===1&&before.passkeys>=1,"Owner/passkey precondition missing");
let sessionCreated=false,failed;
const request=async(path,method="GET",data=undefined,authenticated=true,forgedOrigin=false)=>{
  const options={method,redirect:"manual",signal:AbortSignal.timeout(20000),headers:{
    ...(authenticated?{Cookie:cookie}:{}),
    ...(method==="GET"?{}:{"Origin":forgedOrigin?"https://evil.invalid":origin,
      "Sec-Fetch-Site":"same-origin","Content-Type":"application/json",
      "X-Life-Log-Intent":"manual-write-v1"})
  }};
  if(data!==undefined)options.body=JSON.stringify(data);
  const response=await fetch(origin+path,options);
  const raw=await response.text();
  let json={};
  try{json=JSON.parse(raw);}catch{/* response can be HTML/CSV */}
  return {status:response.status,json,raw};
};
const check=(answer,status,what)=>assert(answer.status===status,what+": expected "+status+" got "+answer.status);
try{
  const now=Math.floor(Date.now()/1000);
  sql("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES('"+
    tokenHash+"','owner',"+(now+900)+","+now+")");
  sessionCreated=true;
  sql("INSERT INTO owner_passkey_sessions(token_hash) VALUES('"+tokenHash+"')");
  check(await request("/api/summary"),200,"Owner summary");
  check(await request("/api/mvp/drinks", "GET", undefined,false),403,"Anonymous drinks list");
  check(await request("/api/mvp/export?from="+day(29)+"&to="+day(0),"GET",undefined,false),403,"Anonymous export");
  check(await request("/api/mvp/drinks","POST",{key:drinkKey1,kind:"highball",observedAt:current},false),
    403,"Anonymous drink write");
  check(await request("/api/mvp/drinks","POST",{key:drinkKey1,kind:"highball",observedAt:current},true,true),
    403,"Forged Origin");

  const one={key:drinkKey1,kind:"highball",observedAt:current};
  const two={key:drinkKey2,kind:"non_alcohol",observedAt:current};
  for(const payload of [one,one,two])check(await request("/api/mvp/drinks","POST",payload),
    200,"Drink create/retry");
  const p1=await request("/api/mvp/drinks");
  check(p1,200,"Drink list");
  assert(p1.json.entries?.some(x=>x.key===drinkKey1&&x.alcohol===1)&&
    p1.json.entries?.some(x=>x.key===drinkKey2&&x.alcohol===0),"Drink kinds not separated");
  check(await request("/api/mvp/drinks","PATCH",{
    ...one,kind:"green_tea_high",expectedObservedAt:current,expectedKind:"highball"
  }),200,"Drink correction");
  const compare=await request("/api/mvp/compare?"+
    new URLSearchParams({aFrom:day(29),aTo:day(15),bFrom:day(14),bTo:day(0)}));
  check(compare,200,"Comparison");
  assert(compare.json?.a?.weight&&compare.json?.b?.drinking&&
    compare.json?.a?.steps?.missingDays!==undefined,"Comparison contract missing");

  const exported=await request("/api/mvp/export?"+new URLSearchParams({from:day(29),to:day(0)}));
  check(exported,200,"Export CSV");
  assert(exported.raw.startsWith("\uFEFF")&&exported.raw.includes('"drink"')&&
    exported.raw.includes('"green_tea_high"'),"CSV did not export synthetic drink with kind");

  // Do not overwrite or interfere with an already active real Owner experiment.
  const active=sql("SELECT COUNT(*) AS n FROM behavior_experiments WHERE owner_id='owner' AND user_decision IS NULL")[0];
  if(active.n===0){
    const plan={id:planId,statement:"Synthetic walking and recording hypothesis",
      supportText:"synthetic",counterText:"none observed",unknownText:"missing coverage",
      targetAction:"Record the synthetic observation",startsOn:day(0),endsOn:day(-14)};
    check(await request("/api/mvp/experiments","POST",plan),200,"Experiment create");
    check(await request("/api/mvp/experiments","POST",plan),200,"Experiment idempotent retry");
    const list=await request("/api/mvp/experiments");
    check(list,200,"Experiment list");
    assert(list.json.experiments?.some(x=>x.id===planId),"Experiment not listed");
    check(await request("/api/mvp/experiments","PATCH",{
      id:planId,decision:"unknown",outcomeText:"Synthetic data insufficient"
    }),200,"Experiment outcome decision");
  }else{
    console.log("SKIP: no synthetic experiment creation because real Owner already has active plan");
  }
  check(await request("/api/mvp/drinks","DELETE",{
    key:drinkKey1,expectedObservedAt:current,expectedKind:"green_tea_high"}),200,"Cancel drink 1");
  check(await request("/api/mvp/drinks","DELETE",{
    key:drinkKey2,expectedObservedAt:current,expectedKind:"non_alcohol"}),200,"Cancel drink 2");
  console.log("PASS: real UAT drinks +1/duplicate/correct/cancel, private export, comparison, experiments conditional, auth and forged Origin");
}catch(e){failed=e;console.error("FAIL: "+e.message);}
finally{
  try{
    sql("DELETE FROM drink_entries WHERE owner_id='owner' AND source_id='manual:drink'"+
      " AND source_row_key IN ('"+drinkKey1+"','"+drinkKey2+"')");
    sql("DELETE FROM behavior_experiments WHERE owner_id='owner' AND id='"+planId+"'");
    sql("DELETE FROM behavior_hypotheses WHERE owner_id='owner' AND id='h:"+planId+"'");
    if(sessionCreated)sql("DELETE FROM owner_sessions WHERE owner_id='owner' AND token_hash='"+tokenHash+"'");
    const after=count();
    for(const key of Object.keys(before)){
      assert(before[key]===after[key],"Post-cleanup record-count mismatch in "+key);
    }
    console.log("PASS: all synthetic rows and temporary session cleaned; Owner passkey, weight, steps and existing records preserved");
  }catch(e){failed??=e;console.error("CLEANUP_VERIFICATION_FAILED: "+e.message);}
}
if(failed)process.exitCode=1;
