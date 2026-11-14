#!/usr/bin/env node
/** UAT-only ECLEAR rollout guard. Cloudflare GET + schema-only queries, no user rows. */
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {readRemoteSettings,prepareConfig,DATABASE,ORIGIN} from "./uat-ui-release-guard.mjs";

const NEW_BINDINGS=[
  {name:"ECLEAR_ENRICHMENT_REMOTE_ENABLED",type:"plain_text",text:"true"},
  {name:"ECLEAR_ENRICHMENT_REMOTE_TARGET",type:"plain_text",text:"uat"},
  {name:"ECLEAR_ENRICHMENT_REMOTE_ORIGIN",type:"plain_text",text:ORIGIN},
  {name:"ECLEAR_ENRICHMENT_REVIEW_KEY",type:"secret_text"}
];
export const EXPECTED_ADDITIONS=Object.freeze(NEW_BINDINGS);
const sort=items=>[...items].sort((a,b)=>a.name.localeCompare(b.name,"en"));
const newNames=new Set(NEW_BINDINGS.map(b=>b.name));
export function assertUatBefore(before){
  assert(before&&typeof before==="object"&&!Array.isArray(before));
  assert(Array.isArray(before.bindings)&&before.bindings.length>0);
  const names=before.bindings.map(b=>b.name);
  assert.equal(new Set(names).size,names.length,"duplicate Worker binding");
  for(const name of newNames)assert(!names.includes(name),"ECLEAR binding already exists; refuse overwrite");
  const db=before.bindings.find(b=>b.name==="DB");
  assert.deepEqual(db,{name:"DB",type:"d1",id:DATABASE});
  assert.equal(before.runtime.date,"2026-11-04");
  assert.equal(before.assets.run_worker_first,true);
  return true;
}
export function assertUatAfter(before,after){
  assertUatBefore(before);
  assert.equal(after.workerId,before.workerId,"Worker identity changed");
  assert.deepEqual(after.runtime,before.runtime,"runtime compatibility drift");
  assert.deepEqual(after.assets,before.assets,"Worker asset routing drift");
  assert.deepEqual(after.bindings,sort([...before.bindings,...NEW_BINDINGS]),
    "Unexpected Worker binding, secret, auth, rate-limit or D1 drift");
  return true;
}
export async function verifyRemoteEclearSchema(env,request=fetch){
  const token=env.CLOUDFLARE_API_TOKEN,acct=env.CLOUDFLARE_ACCOUNT_ID;
  assert(typeof token==="string"&&token.length>=12);
  assert(/^[a-f0-9]{32}$/i.test(acct||""));
  const base="https://api.cloudflare.com/client/v4/accounts/"+acct+"/d1/database/"+DATABASE;
  const api=async(method,path,body)=>{
    const response=await request(base+path,{
      method,headers:{Authorization:"Bearer "+token,...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{})
    });
    assert(response.ok,"D1 metadata unavailable");
    const data=await response.json();
    assert.equal(data.success,true,"D1 metadata response invalid");
    return data.result;
  };
  const target=await api("GET","");
  assert.equal(target.uuid,DATABASE,"D1 identity mismatch");
  assert.equal(target.name,"life-log-dev","D1 name mismatch");
  const query=async(sql)=>{
    const result=await api("POST","/query",{sql,params:[]});
    assert(Array.isArray(result)&&result.length===1&&result[0].success===true);
    assert(!result[0].meta?.changes&&!result[0].meta?.changed_db);
    assert(Array.isArray(result[0].results));
    return result[0].results;
  };
  const names=(await query("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('eclear_enrichment_jobs','eclear_enrichment_row_audit','eclear_enrichment_cell_audit','eclear_enrichment_asserts') ORDER BY name")).map(x=>x.name);
  assert.deepEqual(names,[
    "eclear_enrichment_asserts","eclear_enrichment_cell_audit",
    "eclear_enrichment_jobs","eclear_enrichment_row_audit"
  ],"ECLEAR 0005 audit tables incomplete");
  const ledger=await query("SELECT name FROM d1_migrations WHERE name='0005_eclear_enrichment_audit.sql' LIMIT 1");
  assert.deepEqual(ledger,[{name:"0005_eclear_enrichment_audit.sql"}],"ECLEAR 0005 migration ledger missing");
  console.log("PASS: exact remote UAT D1 0005 metadata present, no personal rows read");
  return true;
}
async function main(){
  const [mode,path]=process.argv.slice(2);
  if(mode==="config"){
    prepareConfig(await readFile("wrangler.jsonc","utf8"));
    console.log("PASS: guarded UAT config");
  }else if(mode==="before"&&path){
    await verifyRemoteEclearSchema(process.env);
    const before=await readRemoteSettings();
    assertUatBefore(before);
    await writeFile(path,JSON.stringify(before),{mode:0o600,flag:"wx"});
    console.log("PASS: UAT Worker preflight, ECLEAR bindings absent, all existing bindings retained");
  }else if(mode==="after"&&path){
    const before=JSON.parse(await readFile(path,"utf8"));
    await verifyRemoteEclearSchema(process.env);
    const after=await readRemoteSettings();
    assertUatAfter(before,after);
    console.log("PASS: UAT Worker ECLEAR enabled with one secret and three flags, existing bindings preserved");
  }else throw Error("Usage: config | before <private-snapshot> | after <private-snapshot>");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.error("UAT ECLEAR release guard failed closed");process.exitCode=1;});
}
