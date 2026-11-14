#!/usr/bin/env node
/**
 * Life-log UAT UI release guard. No writes to Cloudflare and no D1 access.
 * The future manual workflow alone calls snapshot/compare around Wrangler deploy.
 */
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

export const BASELINE="54f2b4732baafbeb143ac2943867535e5a6f3b99";
export const WORKER="life-log-uat";
export const DATABASE="421d0116-5c33-4782-a2b6-28f9684d3956";
export const ORIGIN="https://life-log-uat.ha-rookie.workers.dev";
export const COMPATIBILITY_DATE="2026-11-04";
export const LIMIT=5;
export const PERIOD=60;

function requireValue(condition,label){
  if(!condition)throw Error("UAT guard rejected: "+label);
}
export function prepareConfig(text){
  // This repository's JSONC has full-line comments only.
  const cfg=JSON.parse(text.split(/\r?\n/).filter(line=>!line.trimStart().startsWith("//")).join("\n"));
  const uat=cfg.env?.uat;
  requireValue(cfg.compatibility_date===COMPATIBILITY_DATE &&
    (!cfg.compatibility_flags || (Array.isArray(cfg.compatibility_flags) && cfg.compatibility_flags.length===0)) &&
    !uat?.compatibility_date && !uat?.compatibility_flags,
    "unexpected Worker compatibility");
  for(const key of Object.keys(cfg)){
    requireValue(["name","main","compatibility_date","compatibility_flags","assets","d1_databases","env"].includes(key),
      "unexpected root configuration key "+key);
  }
  requireValue(Object.keys(cfg.env??{}).length===1,"unexpected environment");
  for(const assets of [cfg.assets,uat?.assets]){
    requireValue(assets && Object.keys(assets).sort().join(",")==="binding,directory,not_found_handling,run_worker_first" &&
      assets.binding==="ASSETS"&&assets.directory==="./dist"&&assets.run_worker_first===true&&
      assets.not_found_handling==="single-page-application","unexpected assets routing config");
  }
  requireValue(uat && Object.keys(uat).sort().join(",")==="assets,d1_databases,name,unsafe,vars,workers_dev",
    "unexpected UAT configuration");
  requireValue(uat.unsafe?.bindings?.length===1 &&
    Object.keys(uat.unsafe.bindings[0]).sort().join(",")==="name,namespace_id,simple,type" &&
    uat.unsafe.bindings[0].simple?.limit===LIMIT &&
    uat.unsafe.bindings[0].simple?.period===PERIOD &&
    Object.keys(uat.unsafe.bindings[0].simple).sort().join(",")==="limit,period",
    "unexpected rate limiter limits or period");
  requireValue(cfg.name==="life-log-dev"&&cfg.main==="src/worker/index.ts","unexpected base Worker");
  requireValue(uat?.name===WORKER&&uat.workers_dev===true,"unexpected UAT Worker");
  requireValue(cfg.d1_databases?.length===1&&
    cfg.d1_databases[0].binding==="DB"&&cfg.d1_databases[0].database_id===DATABASE,
    "unexpected base D1");
  requireValue(uat.d1_databases?.length===1&&
    uat.d1_databases[0].binding==="DB"&&
    uat.d1_databases[0].database_name==="life-log-dev"&&
    uat.d1_databases[0].database_id===DATABASE,"unexpected UAT D1");
  requireValue(uat.assets?.binding==="ASSETS"&&uat.assets?.run_worker_first===true&&
    uat.assets?.directory==="./dist","unexpected UAT assets");
  requireValue(uat.unsafe?.bindings?.length===1&&
    uat.unsafe.bindings[0].name==="AUTH_RATE_LIMITER"&&
    uat.unsafe.bindings[0].type==="ratelimit"&&
    String(uat.unsafe.bindings[0].namespace_id)==="1001","unexpected rate limit");
  requireValue(uat.vars?.MANUAL_REMOTE_WRITE_ENABLED==="false"&&
    uat.vars?.MANUAL_REMOTE_TARGET==="uat"&&
    uat.vars?.MANUAL_REMOTE_ORIGIN===ORIGIN,"unexpected repository UAT vars");
  requireValue(!cfg.routes&&!uat.routes&&!cfg.triggers&&!uat.triggers,"unexpected routes/triggers");
  // Crucial: never send the stale repository vars (write_enabled=false)
  // over a working UAT deployment. Wrangler --keep-vars retains live vars.
  delete uat.vars;
  cfg.keep_vars=true;
  requireValue(!Object.hasOwn(uat,"vars"),"UAT vars must be omitted");
  return JSON.stringify(cfg,null,2)+"\n";
}

const allowed=new Set(["plain_text","secret_text","d1","assets","ratelimit"]);
export function snapshotBindings(bindings){
  requireValue(Array.isArray(bindings)&&bindings.length>0,"missing remote Worker settings");
  const names=new Set();
  const normalized=bindings.map(b=>{
    requireValue(b&&typeof b.name==="string"&&b.name.length>0&&!names.has(b.name),
      "invalid/duplicate Worker binding");
    names.add(b.name);
    requireValue(allowed.has(b.type),"unsupported live binding type");
    const v={name:b.name,type:b.type};
    if(b.type==="plain_text"){
      requireValue(typeof b.text==="string","opaque plaintext binding");
      v.text=b.text;
    }else if(b.type==="d1"){
      const id=b.id??b.database_id;
      requireValue(typeof id==="string"&&id.length>0,"unknown D1 target");
      v.id=id;
    }else if(b.type==="ratelimit"){
      const id=b.namespace_id;
      requireValue(id!==undefined,"unknown rate limiter");
      v.namespace_id=String(id);
      requireValue(b.simple && Number.isInteger(b.simple.limit) && b.simple.limit>0 &&
        Number.isInteger(b.simple.period) && b.simple.period>0,
        "remote rate limit/period missing");
      v.simple={limit:b.simple.limit,period:b.simple.period};
      if(b.simple.mitigation_timeout!==undefined){
        requireValue(Number.isInteger(b.simple.mitigation_timeout)&&b.simple.mitigation_timeout>=0,
          "invalid rate mitigation timeout");
        v.simple.mitigation_timeout=b.simple.mitigation_timeout;
      }
    }
    // Secret values are never requested/stored/printed. Only binding names.
    // Assets metadata may contain content hashes that change on UI deploy.
    return v;
  }).sort((a,b)=>a.name.localeCompare(b.name,"en"));
  const get=name=>normalized.find(b=>b.name===name);
  requireValue(get("DB")?.type==="d1"&&get("DB").id===DATABASE,"remote D1 mismatch");
  requireValue(get("ASSETS")?.type==="assets","remote assets missing");
  requireValue(get("AUTH_RATE_LIMITER")?.type==="ratelimit"&&
    get("AUTH_RATE_LIMITER").namespace_id==="1001"&&
    get("AUTH_RATE_LIMITER").simple.limit===LIMIT&&
    get("AUTH_RATE_LIMITER").simple.period===PERIOD&&
    get("AUTH_RATE_LIMITER").simple.mitigation_timeout===undefined,
    "remote limiter mismatch");
  for(const [name,value] of [["MANUAL_REMOTE_TARGET","uat"],
    ["MANUAL_REMOTE_ORIGIN",ORIGIN]]){
    requireValue(get(name)?.type==="plain_text"&&get(name).text===value,"remote UAT identity mismatch");
  }
  requireValue(get("MANUAL_REMOTE_WRITE_ENABLED")?.type==="plain_text"&&
    ["true","false"].includes(get("MANUAL_REMOTE_WRITE_ENABLED").text),
    "remote write mode must be retained");
  return normalized;
}
export function assertSameBindings(before,after){
  assert.deepStrictEqual(after,before,"deployed UAT bindings changed; release NOT VERIFIED");
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonicalDate(value){
  requireValue(typeof value==="string" && /^\d{4}-\d{2}-\d{2}(T00:00:00(?:\.000)?Z)?$/.test(value),
    "runtime compatibility date missing/invalid");
  return value.slice(0,10);
}
function canonicalFlags(value){
  requireValue(value===undefined || Array.isArray(value),"unknown compatibility flags");
  const flags=value??[];
  requireValue(flags.every(x=>typeof x==="string") && new Set(flags).size===flags.length,
    "invalid compatibility flags");
  return [...flags].sort();
}
export function normalizeRuntime(runtime){
  requireValue(runtime && typeof runtime==="object" && !Array.isArray(runtime),"missing Worker runtime");
  const date=canonicalDate(runtime.compatibility_date);
  const flags=canonicalFlags(runtime.compatibility_flags);
  requireValue(date===COMPATIBILITY_DATE && flags.length===0,"runtime compatibility mismatch");
  return {date,flags};
}
export function normalizeAssets(assets){
  const c=assets?.config;
  requireValue(c && typeof c==="object" && !Array.isArray(c),"active assets routing unavailable");
  requireValue(c.run_worker_first===true && c.not_found_handling==="single-page-application",
    "active assets must run Worker first and preserve SPA handling");
  requireValue(c.base_path===undefined||c.base_path===null||c.base_path==="/",
    "unexpected assets base path");
  requireValue(c.html_handling===undefined||c.html_handling==="auto-trailing-slash",
    "unexpected assets HTML routing");
  for(const key of Object.keys(c))
    requireValue(["run_worker_first","not_found_handling","base_path","html_handling"].includes(key),
      "unknown active assets routing key");
  return {run_worker_first:true,not_found_handling:"single-page-application",base_path:"/",
    html_handling:"auto-trailing-slash"};
}
export function chooseActiveVersion(deployments){
  requireValue(Array.isArray(deployments)&&deployments.length>0,"no active Worker deployments");
  const sorted=[...deployments].sort((a,b)=>
    Date.parse(b.created_on)-Date.parse(a.created_on));
  const latest=sorted[0];
  requireValue(Number.isFinite(Date.parse(latest.created_on)) &&
    (sorted.length===1 || Date.parse(latest.created_on)>Date.parse(sorted[1].created_on)),
    "ambiguous latest Worker deployment");
  requireValue(latest.versions?.length===1 && latest.versions[0].percentage===100 &&
    UUID.test(latest.versions[0].version_id),"Worker must have single 100% deployed version");
  return latest.versions[0].version_id;
}
export function normalizeWorkerState(settings,version,workerId){
  requireValue(typeof workerId==="string"&&workerId.length>0,"unknown Worker identity");
  const settingsRuntime=normalizeRuntime(settings);
  const versionRuntime=normalizeRuntime(version);
  assert.deepStrictEqual(versionRuntime,settingsRuntime,"Worker settings/version compatibility disagreement");
  const versionBindings=snapshotBindings(version?.bindings);
  const settingBindings=snapshotBindings(settings?.bindings);
  // This detects secret/variable binding-name/type drift while never using secret values.
  assert.deepStrictEqual(versionBindings,settingBindings,
    "Worker settings and deployed version bindings disagree");
  return {workerId,bindings:settingBindings,runtime:settingsRuntime,
    assets:normalizeAssets(version?.assets)};
}
export async function readRemoteSettings(env=process.env,request=fetch){
  const token=env.CLOUDFLARE_API_TOKEN,account=env.CLOUDFLARE_ACCOUNT_ID;
  requireValue(typeof token==="string"&&token.length>0&&
    typeof account==="string"&&/^[a-f0-9]{32}$/.test(account),
    "missing Cloudflare credentials");
  const root="https://api.cloudflare.com/client/v4/accounts/"+account;
  async function get(path){
    const response=await request(root+path,{headers:{Authorization:"Bearer "+token},
      signal:AbortSignal.timeout(15000)});
    requireValue(response?.ok===true,"Worker metadata GET failed");
    const body=await response.json();
    requireValue(body?.success===true,"Worker metadata API rejected request");
    return body;
  }
  const worker=(await get("/workers/workers/"+WORKER)).result;
  requireValue(worker?.name===WORKER && typeof worker.id==="string" && worker.id.length>0,
    "unexpected remote Worker identity");
  const deployments=await get("/workers/scripts/"+WORKER+"/deployments?page=1&per_page=100");
  requireValue(!deployments.result_info || deployments.result_info.total_pages<=1,
    "unverified paginated deployment history");
  const activeId=chooseActiveVersion(deployments.result?.deployments);
  const version=(await get("/workers/workers/"+encodeURIComponent(worker.id)+
    "/versions/"+activeId)).result;
  requireValue(version?.id===activeId,"active Worker version mismatch");
  const settings=(await get("/workers/scripts/"+WORKER+"/settings")).result;
  return normalizeWorkerState(settings,version,worker.id);
}
async function main(){
  const [mode,arg]=process.argv.slice(2);
  if(mode==="prepare"){
    requireValue(typeof arg==="string"&&arg.length>0,"missing output path");
    const config=await readFile("wrangler.jsonc","utf8");
    await writeFile(arg,prepareConfig(config),{mode:0o600,flag:"wx"});
    console.log("UAT release config generated without plaintext vars.");
  }else if(mode==="snapshot"){
    requireValue(typeof arg==="string"&&arg.length>0,"missing snapshot path");
    const bindings=await readRemoteSettings();
    await writeFile(arg,JSON.stringify(bindings),{mode:0o600,flag:"wx"});
    console.log("UAT Worker binding metadata preflight PASS (values not logged).");
  }else if(mode==="compare"){
    requireValue(typeof arg==="string"&&arg.length>0,"missing snapshot path");
    const before=JSON.parse(await readFile(arg,"utf8"));
    const after=await readRemoteSettings();
    assertSameBindings(before,after);
    console.log("UAT Worker binding identity and variable preservation PASS.");
  }else{
    throw Error("Usage: prepare <new-config> | snapshot <new-private-path> | compare <snapshot>");
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.error("UAT release guard failed closed; inspect configuration and CI gate.");process.exitCode=1;});
}
