/**
 * One-shot real-UAT Owner manual-entry verification.
 * No Cloudflare Worker or D1 migrations; adds and ALWAYS cleans up synthetic
 * rows plus a synthetic short-lived Owner session. Does not alter passkeys.
 * Never log cookies, user records, session material, or Cloudflare secrets.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";

const ORIGIN = "https://life-log-uat.ha-rookie.workers.dev";
const OWNER = "owner";
const WEIGHT_SOURCE = "manual:weight";
const STEPS_SOURCE = "manual:steps";
const assert = (condition, reason) => { if (!condition) throw Error(reason); };
const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const wranglerSql = (sql) => {
  let parsed;
  try {
    const raw = execFileSync("npx",[
      "--no-install","wrangler","d1","execute","DB","--env","uat","--remote",
      "--json","--command",sql
    ],{encoding:"utf8",timeout:90000,stdio:["ignore","pipe","pipe"]});
    parsed=JSON.parse(raw);
  } catch(e) {
    // Do not log child_process Error.message/command: SQL carries an ephemeral token hash.
    throw Error("UAT D1 operation failed (exit status "+(Number.isInteger(e.status)?e.status:"unknown")+")");
  }
  const results = Array.isArray(parsed) ? parsed : [parsed];
  assert(results.length>0 && results.every(r=>r.success===true),"D1 query rejected");
  return results.flatMap(r=>r.results ?? []);
};
const one = (sql) => {
  const rows=wranglerSql(sql);
  assert(rows.length===1,"Unexpected number of D1 result rows");
  return rows[0];
};
const cookieToken = randomBytes(32).toString("hex");
const cookieHash = createHash("sha256").update(cookieToken).digest("hex");
const cookie = "__Host-life_log_session="+cookieToken;
const weightKey = randomUUID();
const testWeightId = "manual:weight:"+weightKey;
let day;
let sessionSeeded=false;
const preflight = () => {
  const counts=one("SELECT "+
    "(SELECT COUNT(*) FROM owner_passkey_credentials) AS passkeys,"+
    "(SELECT COUNT(*) FROM owners WHERE id='owner') AS owner_count,"+
    "(SELECT COUNT(*) FROM body_measurements) AS weights,"+
    "(SELECT COUNT(*) FROM activity_daily) AS activities,"+
    "(SELECT COUNT(*) FROM owner_sessions) AS sessions");
  assert(counts.passkeys>=1 && counts.owner_count===1, "Owner passkey or D1 owner missing");
  return counts;
};
const chooseEmptyDay = () => {
  const result=wranglerSql("WITH RECURSIVE candidate(day,n) AS ("+
    "SELECT date('now','+9 hours'),0 "+
    "UNION ALL SELECT date(day,'-1 day'),n+1 FROM candidate WHERE n<29) "+
    "SELECT c.day FROM candidate c WHERE "+
    "NOT EXISTS(SELECT 1 FROM body_measurements b WHERE b.owner_id='owner' "+
    "AND date(b.measured_at,'+9 hours')=c.day) AND "+
    "NOT EXISTS(SELECT 1 FROM activity_daily a WHERE a.owner_id='owner' "+
    "AND a.local_day=c.day) AND "+
    "NOT EXISTS(SELECT 1 FROM lifestyle_days l WHERE l.owner_id='owner' "+
    "AND l.local_day=c.day AND l.steps IS NOT NULL) "+
    "ORDER BY c.day DESC LIMIT 1");
  assert(result.length===1 && /^\d{4}-\d\d-\d\d$/.test(result[0].day),
    "No empty day in last 30 days; do not overwrite user data");
  return result[0].day;
};
const seedSession = () => {
  const now=Math.floor(Date.now()/1000);
  const changed=wranglerSql("INSERT INTO owner_sessions"+
    "(token_hash,owner_id,expires_at,created_at) VALUES('"+cookieHash+
    "','owner',"+(now+900)+","+now+");");
  sessionSeeded=true;
  wranglerSql("INSERT INTO owner_passkey_sessions(token_hash) VALUES('"+cookieHash+"');");
};
const fetchJson = async (path,method="GET",body=undefined,authenticated=true,headers={}) => {
  const init={method,redirect:"manual",signal:AbortSignal.timeout(20000),headers:{
    ...(authenticated?{"Cookie":cookie}:{}),
    ...(method!=="GET"?{"Origin":ORIGIN,"Sec-Fetch-Site":"same-origin",
       "Content-Type":"application/json","X-Life-Log-Intent":"manual-write-v1"}:{}),
    ...headers
  }};
  if(body!==undefined)init.body=JSON.stringify(body);
  const res=await fetch(ORIGIN+path,init);
  const text=await res.text();
  let value={};
  try{value=JSON.parse(text);}catch{/* e.g. authenticated HTML and anonymous 403 */}
  return {status:res.status,value};
};
const check = (r,expected,description) => assert(r.status===expected,
  description+" expected HTTP "+expected+", got "+r.status+" error="+(r.value.error??"none"));
const ensureFound = (rows,key,field,expected) =>
  assert(rows.some(row=>row[key]===expected),"Saved "+field+" not found on remote readback");
let originalCounts;
let failed;
try {
  originalCounts=preflight();
  day=chooseEmptyDay();
  seedSession();
  const until=jstToday();
  const interval="?from="+day+"&to="+until;
  const at=day+"T00:01:00+09:00";
  const weight=123.4,correctedWeight=123.5;

  check(await fetchJson("/api/manual/records"),200,"Owner read");
  check(await fetchJson("/api/summary"),200,"Owner summary");
  check(await fetchJson("/"),200,"Private app shell");
  check(await fetchJson("/api/manual/records","GET",undefined,false),403,"Anonymous read");
  check(await fetchJson("/api/manual/weight","POST",
    {key:weightKey,measuredAt:at,weightKg:weight},false),403,"Anonymous write");
  check(await fetchJson("/api/manual/weight","POST",
    {key:weightKey,measuredAt:at,weightKg:weight},true,{Origin:"https://invalid.example"}),403,"CSRF write");

  const addWeight=await fetchJson("/api/manual/weight","POST",
    {key:weightKey,measuredAt:at,weightKg:weight});
  check(addWeight,200,"Create real-UAT synthetic weight");
  const duplicate=await fetchJson("/api/manual/weight","POST",
    {key:weightKey,measuredAt:at,weightKg:weight});
  check(duplicate,200,"Idempotent weight retry");
  const patch=await fetchJson("/api/manual/weight","PATCH",
    {key:weightKey,measuredAt:at,weightKg:correctedWeight,
     expectedMeasuredAt:at,expectedWeightKg:weight});
  check(patch,200,"Correct weight");

  const addSteps=await fetchJson("/api/manual/steps","POST",{day,steps:0});
  check(addSteps,200,"Record zero steps (not missing)");
  const fixSteps=await fetchJson("/api/manual/steps","PUT",
    {day,steps:1234,expectedSteps:0});
  check(fixSteps,200,"Correct steps");

  const read=await fetchJson("/api/manual/records"+interval);
  check(read,200,"Read both records");
  ensureFound(read.value.weights,"key","weight",weightKey);
  assert(read.value.weights.some(x=>x.key===weightKey && x.weightKg===correctedWeight),"Weight correction not visible");
  assert(read.value.steps.some(x=>x.day===day && x.steps===1234),"Steps correction not visible");

  const trend=await fetchJson("/api/weight/trend"+interval);
  check(trend,200,"Read chart after weight correction");
  assert(Array.isArray(trend.value.days)&&
    trend.value.days.some(x=>x.day===day && x.weightKg===correctedWeight),
    "Corrected weight did not reach day chart");
  check(await fetchJson("/api/summary"),200,"Read summary after write");

  check(await fetchJson("/api/manual/weight","DELETE",
    {key:weightKey,expectedMeasuredAt:at,expectedWeightKg:correctedWeight}),
    200,"Cancel weight");
  check(await fetchJson("/api/manual/steps","DELETE",{day,expectedSteps:1234}),
    200,"Cancel steps");
  const after=await fetchJson("/api/manual/records"+interval);
  check(after,200,"Read after cancel");
  assert(!after.value.weights.some(x=>x.key===weightKey),"Cancelled synthetic weight remains");
  assert(!after.value.steps.some(x=>x.day===day),"Cancelled synthetic steps remain");
  console.log("PASS: real UAT cookie Owner GET 200, anonymous 403, CSRF 403, weight/steps create-edit-read-cancel 200, zero steps distinct, retry idempotence, chart refresh");
} catch(e) {
  failed=e;
  console.error("FAIL: "+e.message);
} finally {
  try {
    // Guard every delete with source, Owner and one random key/day; no other data touched.
    wranglerSql("DELETE FROM body_measurements WHERE owner_id='owner' AND source_id='"+
      WEIGHT_SOURCE+"' AND source_row_key='"+weightKey+"' AND id='"+testWeightId+"';");
    if(day)wranglerSql("DELETE FROM activity_daily WHERE owner_id='owner' AND source_id='"+
      STEPS_SOURCE+"' AND source_row_key='"+day+"' AND id='manual:steps:owner:"+day+"';");
    if(sessionSeeded){
      wranglerSql("DELETE FROM owner_sessions WHERE token_hash='"+cookieHash+
        "' AND owner_id='owner';");
    }
    if(originalCounts){
      const after=preflight();
      assert(after.weights===originalCounts.weights &&
             after.activities===originalCounts.activities &&
             after.passkeys===originalCounts.passkeys &&
             after.sessions===originalCounts.sessions,
         "User data/session counts changed after cleanup");
    }
    console.log("PASS: all synthetic entries and short-lived session cleaned; existing D1 Owner records/passkeys unchanged");
  }catch(e){
    failed ??=e;
    console.error("CLEANUP_VERIFICATION_FAILED: "+e.message);
  }
}
if(failed)process.exitCode=1;
