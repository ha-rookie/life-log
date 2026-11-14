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

function requireValue(condition,label){
  if(!condition)throw Error("UAT guard rejected: "+label);
}
export function prepareConfig(text){
  // This repository's JSONC has full-line comments only.
  const cfg=JSON.parse(text.split(/\r?\n/).filter(line=>!line.trimStart().startsWith("//")).join("\n"));
  const uat=cfg.env?.uat;
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
    }
    // Secret values are never requested/stored/printed. Only binding names.
    // Assets metadata may contain content hashes that change on UI deploy.
    return v;
  }).sort((a,b)=>a.name.localeCompare(b.name,"en"));
  const get=name=>normalized.find(b=>b.name===name);
  requireValue(get("DB")?.type==="d1"&&get("DB").id===DATABASE,"remote D1 mismatch");
  requireValue(get("ASSETS")?.type==="assets","remote assets missing");
  requireValue(get("AUTH_RATE_LIMITER")?.type==="ratelimit"&&
    get("AUTH_RATE_LIMITER").namespace_id==="1001","remote limiter mismatch");
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
export async function readRemoteSettings(env=process.env){
  const token=env.CLOUDFLARE_API_TOKEN,account=env.CLOUDFLARE_ACCOUNT_ID;
  requireValue(typeof token==="string"&&token.length>0&&
    typeof account==="string"&&/^[a-f0-9]{32}$/.test(account),
    "missing Cloudflare credentials");
  const url="https://api.cloudflare.com/client/v4/accounts/"+account+
    "/workers/scripts/"+WORKER+"/settings";
  const res=await fetch(url,{headers:{Authorization:"Bearer "+token},
    signal:AbortSignal.timeout(15000)});
  requireValue(res.ok,"Worker metadata request failed (HTTP "+res.status+")");
  const body=await res.json();
  requireValue(body?.success===true,"Worker metadata API rejected request");
  return snapshotBindings(body.result?.bindings);
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
