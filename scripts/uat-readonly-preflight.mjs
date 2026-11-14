#!/usr/bin/env node
/**
 * Independent UAT metadata inventory: GET only. No D1 requests and no deploy.
 * Never print Cloudflare payloads, variable values, token values, or assertion diffs.
 */
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {
  WORKER,DATABASE,COMPATIBILITY_DATE,ORIGIN,prepareConfig,
  chooseActiveVersion,normalizeWorkerState
} from "./uat-ui-release-guard.mjs";

const ROOT="https://api.cloudflare.com/client/v4/accounts/";
const HEX_ID=/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
function guard(test,label){if(!test)throw Error("Preflight refused: "+label);}

/**
 * Cloudflare documents run_worker_first as boolean OR path rules.
 * The ONLY pattern equivalent to unconditional Worker-first is ["/*"].
 * Reject other arrays, negative rules, missing values and unknown routing.
 */
export function canonicalizeLiveAssets(assets){
  const c=assets?.config;
  guard(c && typeof c==="object"&&!Array.isArray(c),"missing active assets");
  if(Array.isArray(c.run_worker_first)){
    guard(c.run_worker_first.length===1 && c.run_worker_first[0]==="/*",
      "selective asset routing is not unconditional Worker-first");
    return {...assets,config:{...c,run_worker_first:true}};
  }
  guard(c.run_worker_first===true,"Worker-first not confirmed");
  return assets;
}
export function checkPreflightPayloads({firstWorker,firstDeployments,version,settings,
  lastWorker,lastDeployments}){
  guard(firstWorker?.name===WORKER && HEX_ID.test(firstWorker.id||""),
    "unexpected UAT Worker name/id");
  guard(lastWorker?.id===firstWorker.id && lastWorker?.name===WORKER,
    "Worker changed during metadata check");
  guard(firstWorker.subdomain?.enabled!==false &&
    lastWorker.subdomain?.enabled!==false,"Worker subdomain disabled");
  const one=firstDeployments?.deployments,two=lastDeployments?.deployments;
  guard(Array.isArray(one)&&one.length===1 && Array.isArray(two)&&two.length===1,
    "missing or ambiguous active deployment");
  guard(HEX_ID.test(one[0]?.id||"") && one[0].id===two[0]?.id,
    "deployment changed during preflight");
  const active=chooseActiveVersion(one);
  guard(chooseActiveVersion(two)===active && version?.id===active,
    "active version changed or could not be verified");
  const normalizedVersion={...version,assets:canonicalizeLiveAssets(version?.assets)};
  // Strict guard verifies D1 ID, limiter 1001/5/60, runtime date/flags,
  // Worker-first SPA routing, binding names/types, and plaintext values.
  const checked=normalizeWorkerState(settings,normalizedVersion,firstWorker.id);
  guard(checked.runtime.date===COMPATIBILITY_DATE &&
    checked.assets.run_worker_first===true &&
    checked.assets.not_found_handling==="single-page-application",
    "unexpected runtime/assets state");
  // Passkey routes are gated by PASSWORD_ONLY_UAT in src/worker/index.ts.
  // Missing/hidden/misconfigured authentication mode is NOT treated as safe.
  const mode=checked.bindings.find(b=>b.name==="PASSWORD_ONLY_UAT");
  guard(mode?.type==="plain_text" && mode.text==="true",
    "passkey-only authentication gate not verifiable");
  const db=checked.bindings.find(b=>b.name==="DB");
  guard(db?.type==="d1" && db.id===DATABASE,"unexpected UAT database connection");
  return {verified:true,workerId:firstWorker.id,activeVersion:active,
    bindingCount:checked.bindings.length,
    secretBindingCount:checked.bindings.filter(b=>b.type==="secret_text").length,
    origin:ORIGIN};
}
export async function inspectRemoteUat({env=process.env,request=fetch,configText}={}){
  guard(typeof configText==="string" && configText.length>0,"missing local config");
  // Existing strict repository guard checks local target/bindings without writing.
  prepareConfig(configText);
  const token=env.CLOUDFLARE_API_TOKEN,account=env.CLOUDFLARE_ACCOUNT_ID;
  guard(typeof token==="string" && token.length>0 &&
    typeof account==="string"&&/^[a-f0-9]{32}$/i.test(account),
    "missing existing Cloudflare Actions credentials");
  const base=ROOT+account;
  const get=async path=>{
    guard(path.startsWith("/workers/")&&!path.includes("/d1/")&&!path.includes("/secrets/"),
      "unsupported metadata endpoint");
    let response,body;
    try{
      response=await request(base+path,{
        method:"GET",
        headers:{Authorization:"Bearer "+token,Accept:"application/json"},
        redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)
      });
      guard(response?.ok===true,"Cloudflare metadata GET unavailable or permission denied");
      body=await response.json();
    }catch{
      throw Error("Preflight refused: Cloudflare metadata GET unavailable or permission denied");
    }
    guard(body?.success===true && body.result!==null && body.result!==undefined,
      "Cloudflare metadata GET rejected or incomplete");
    return body;
  };
  const worker=(await get("/workers/workers/"+WORKER)).result;
  guard(worker?.name===WORKER && HEX_ID.test(worker.id||""),"unexpected Worker identity");
  const deploymentPath="/workers/scripts/"+WORKER+"/deployments?page=1&per_page=1";
  const deployment=(await get(deploymentPath)).result;
  guard(Array.isArray(deployment?.deployments)&&deployment.deployments.length===1,
    "unknown active deployment");
  const active=chooseActiveVersion(deployment.deployments);
  const version=(await get("/workers/workers/"+encodeURIComponent(worker.id)+
    "/versions/"+active)).result;
  const settings=(await get("/workers/scripts/"+WORKER+"/settings")).result;
  const secondWorker=(await get("/workers/workers/"+WORKER)).result;
  const secondDeployment=(await get(deploymentPath)).result;
  return checkPreflightPayloads({firstWorker:worker,firstDeployments:deployment,
    version,settings,lastWorker:secondWorker,lastDeployments:secondDeployment});
}
async function main(){
  const result=await inspectRemoteUat({configText:await readFile("wrangler.jsonc","utf8")});
  // Sanitized aggregate only. No Worker Secrets, plaintext vars or API token output.
  console.log("UAT GET-only metadata preflight PASS; Worker identity / active version /"+
    " passkey auth / limiter / assets / runtime / bindings / existing D1 verified.");
  console.log("Binding count: "+result.bindingCount+"; secret binding name count: "+
    result.secretBindingCount+". No deployment or D1 operation performed.");
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{
    console.error("UAT GET-only preflight FAIL (permission, missing metadata or safety mismatch)."+
      " No deployment was attempted.");
    process.exitCode=1;
  });
}
