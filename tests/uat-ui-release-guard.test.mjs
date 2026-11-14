import {describe,it} from "vitest";
import assert from "node:assert/strict";
import {prepareConfig,snapshotBindings,assertSameBindings,
  normalizeRuntime,normalizeAssets,chooseActiveVersion,normalizeWorkerState,readRemoteSettings,
  DATABASE,ORIGIN,COMPATIBILITY_DATE} from "../scripts/uat-ui-release-guard.mjs";

const config={
 name:"life-log-dev",main:"src/worker/index.ts",compatibility_date:COMPATIBILITY_DATE,
 assets:{directory:"./dist",binding:"ASSETS",run_worker_first:true,not_found_handling:"single-page-application"},
 d1_databases:[{binding:"DB",database_name:"life-log-dev",database_id:DATABASE}],
 env:{uat:{
  name:"life-log-uat",workers_dev:true,
  assets:{directory:"./dist",binding:"ASSETS",run_worker_first:true,not_found_handling:"single-page-application"},
  d1_databases:[{binding:"DB",database_name:"life-log-dev",database_id:DATABASE}],
  unsafe:{bindings:[{name:"AUTH_RATE_LIMITER",type:"ratelimit",namespace_id:"1001",simple:{limit:5,period:60}}]},
  vars:{MANUAL_REMOTE_WRITE_ENABLED:"false",MANUAL_REMOTE_TARGET:"uat",
    MANUAL_REMOTE_ORIGIN:ORIGIN}
 }}
};
const bindings=[
 {type:"assets",name:"ASSETS"},
 {type:"d1",name:"DB",id:DATABASE},
 {type:"ratelimit",name:"AUTH_RATE_LIMITER",namespace_id:"1001",simple:{limit:5,period:60}},
 {type:"plain_text",name:"MANUAL_REMOTE_WRITE_ENABLED",text:"true"},
 {type:"plain_text",name:"MANUAL_REMOTE_TARGET",text:"uat"},
 {type:"plain_text",name:"MANUAL_REMOTE_ORIGIN",text:ORIGIN},
 {type:"secret_text",name:"OWNER_SECRET"}
];
const clone=x=>structuredClone(x);
describe("UAT UI release security boundary (offline)",()=>{
 it("removes stale vars, sets keep_vars, retains D1, assets and rate limit",()=>{
  const out=JSON.parse(prepareConfig("// leading JSONC comment\n"+JSON.stringify(config)));
  assert.equal(out.keep_vars,true);
  assert.equal(Object.hasOwn(out.env.uat,"vars"),false);
  assert.deepEqual(out.env.uat.d1_databases,config.env.uat.d1_databases);
  assert.deepEqual(out.env.uat.assets,config.env.uat.assets);
  assert.deepEqual(out.env.uat.unsafe,config.env.uat.unsafe);
 });
 it("does not mutate the input config",()=>{
  prepareConfig(JSON.stringify(config));
  assert.equal(config.env.uat.vars.MANUAL_REMOTE_WRITE_ENABLED,"false");
 });
 it("rejects accidental retargeted Worker, D1, assets and write gate",()=>{
  for(const change of [
   x=>x.env.uat.name="another-app",
   x=>x.env.uat.d1_databases[0].database_id="wrong",
   x=>x.env.uat.assets.run_worker_first=false,
   x=>x.env.uat.vars.MANUAL_REMOTE_WRITE_ENABLED="true",
   x=>x.env.uat.unsafe.bindings[0].namespace_id="2",
   x=>x.env.uat.routes=["*"]
  ]){
   const x=clone(config);change(x);
   assert.throws(()=>prepareConfig(JSON.stringify(x)));
  }
 });
 it("snapshots active writable mode and secret name without secret values",()=>{
  const s=snapshotBindings(bindings);
  assert(s.some(x=>x.name==="MANUAL_REMOTE_WRITE_ENABLED"&&x.text==="true"));
  assert.deepEqual(s.find(x=>x.name==="OWNER_SECRET"),{name:"OWNER_SECRET",type:"secret_text"});
  assert.equal(JSON.stringify(s).includes("undefined"),false);
 });
 it("rejects changing or removing any existing variable or secret binding",()=>{
  const before=snapshotBindings(bindings);
  for(const change of [
   x=>x[3].text="false",
   x=>x[6].name="OTHER_SECRET",
   x=>x.splice(6,1),
   x=>x[1].id="different",
  ]){
   const b=clone(bindings);change(b);
   if(b[1].id==="different")assert.throws(()=>snapshotBindings(b));
   else assert.throws(()=>assertSameBindings(before,snapshotBindings(b)));
  }
 });
 it("rejects missing bindings, unknown binding types, duplicate names, D1 drift",()=>{
  for(const change of [
   x=>x.splice(0,1),
   x=>x[0].type="service",
   x=>x[0].name="DB",
   x=>x[1].id="other-db",
   x=>x.splice(4,1),
   x=>x[2].namespace_id="bad"
  ]){
   const b=clone(bindings);change(b);
   assert.throws(()=>snapshotBindings(b));
  }
 });
 it("does not claim release when the original and final snapshots differ",()=>{
  const before=snapshotBindings(bindings);
  assert.doesNotThrow(()=>assertSameBindings(before,snapshotBindings(clone(bindings))));
  const after=clone(before);after[0].type="other";
  assert.throws(()=>assertSameBindings(before,after));
 });
});


describe("strict pre-deploy Worker metadata and config protection",()=>{
 const versionId="023e105f-2a42-4f8b-a1c1-73f6a2a30c0f";
 const serverSettings={compatibility_date:COMPATIBILITY_DATE,
   compatibility_flags:[],bindings};
 const serverVersion={id:versionId,compatibility_date:COMPATIBILITY_DATE,
   compatibility_flags:[],bindings,assets:{config:{
     run_worker_first:true,not_found_handling:"single-page-application",
     base_path:"/",html_handling:"auto-trailing-slash"}}};
 const deployment={created_on:"2026-11-10T00:00:00Z",
   versions:[{version_id:versionId,percentage:100}]};
 it("checks checked-in config compatibility, explicit rate limit/period, SPA routing and deny config drift",()=>{
   for(const mutate of [
     x=>x.compatibility_date="2026-11-10",
     x=>x.compatibility_flags=["nodejs_compat"],
     x=>x.assets.run_worker_first=false,
     x=>x.assets.not_found_handling="404-page",
     x=>x.assets.directory="./public",
     x=>x.env.uat.assets.not_found_handling="none",
     x=>x.env.uat.unsafe.bindings[0].simple.limit=999,
     x=>x.env.uat.unsafe.bindings[0].simple.period=30,
     x=>x.env.uat.unsafe.bindings[0].simple.mitigation_timeout=10,
     x=>x.env.uat.compatibility_date="2026-11-11",
     x=>x.env.uat.vars.OWNER_SECRET="leak",
     x=>x.keep_vars=true
   ]){const x=clone(config);mutate(x);assert.throws(()=>prepareConfig(JSON.stringify(x)));}
 });
 it("requires ratelimit simple limit and period, rejects missing/changed params",()=>{
   for(const mutate of [
     x=>x[2].simple.limit=3,
     x=>x[2].simple.period=30,
     x=>delete x[2].simple,
     x=>x[2].simple.mitigation_timeout=60,
     x=>x[2].namespace_id="2"
   ]){const b=clone(bindings);mutate(b);assert.throws(()=>snapshotBindings(b));}
 });
 it("accepts exact runtime/assets metadata, including documented midnight date",()=>{
   assert.deepEqual(normalizeRuntime({compatibility_date:COMPATIBILITY_DATE+"T00:00:00Z"}),
     {date:COMPATIBILITY_DATE,flags:[]});
   assert.equal(normalizeAssets(serverVersion.assets).run_worker_first,true);
   const state=normalizeWorkerState(serverSettings,serverVersion,"worker-id");
   assert.equal(state.bindings.length,bindings.length);
   assert.equal(state.assets.not_found_handling,"single-page-application");
   assert.doesNotThrow(()=>assertSameBindings(state,clone(state)));
 });
 it("rejects runtime date/flags or assets routing drift before deployment",()=>{
   for(const mutate of [
     x=>x.compatibility_date="2026-11-01",
     x=>x.compatibility_flags=["nodejs_compat"],
     x=>delete x.compatibility_date,
     x=>x.assets.config.run_worker_first=false,
     x=>x.assets.config.run_worker_first=["/api/*"],
     x=>x.assets.config.not_found_handling="none",
     x=>x.assets.config.base_path="/private",
     x=>x.assets.config.html_handling="none",
     x=>delete x.assets.config
   ]){const v=clone(serverVersion);mutate(v);
     assert.throws(()=>normalizeWorkerState(serverSettings,v,"worker-id"));}
 });
 it("rejects incomplete or mismatched settings-version auth bindings",()=>{
   for(const mutate of [
     x=>x.bindings[6].name="RENAMED_OWNER_SECRET",
     x=>x.bindings[6].type="plain_text",
     x=>x.bindings[3].text="false",
     x=>x.bindings.splice(6,1),
     x=>delete x.bindings,
     x=>x.bindings[2].simple.limit=6
   ]){const v=clone(serverVersion);mutate(v);assert.throws(()=>
     normalizeWorkerState(serverSettings,v,"worker-id"));}
 });
 it("rejects multi-version, unverified and ambiguous deployed traffic",()=>{
   assert.equal(chooseActiveVersion([deployment]),versionId);
   for(const ds of [
     [],[{...deployment,versions:[{version_id:versionId,percentage:50}]}],
     [{...deployment,versions:[{version_id:versionId,percentage:50},{version_id:versionId,percentage:50}]}],
     [{...deployment,created_on:"not-a-date"}],
     [deployment,clone(deployment)],
     [{...deployment,versions:[{version_id:"unverified",percentage:100}]}]
   ])assert.throws(()=>chooseActiveVersion(ds));
 });
 it("performs only GET metadata requests and rejects unavailable API shape",async()=>{
   const root="/workers/";
   const answer=(url)=>url.includes("workers/workers/life-log-uat")?{name:"life-log-uat",id:"worker-id"}:
     url.includes("deployments")?{deployments:[deployment]}:
     url.includes("/versions/")?serverVersion:
     url.endsWith("/settings")?serverSettings:null;
   let called=[];
   const read=async(url,opts)=>{called.push({url,opts});return{
     ok:true,json:async()=>({success:true,result:answer(url),result_info:{total_pages:1}})};};
   const state=await readRemoteSettings({CLOUDFLARE_API_TOKEN:"test",CLOUDFLARE_ACCOUNT_ID:"a".repeat(32)},read);
   assert.equal(called.length,4);
   assert(called.every(r=>r.opts.headers.Authorization==="Bearer test"));
   assert.deepEqual(state,normalizeWorkerState(serverSettings,serverVersion,"worker-id"));
   assert(!JSON.stringify(state).includes("secret-value"));
   await assert.rejects(readRemoteSettings({CLOUDFLARE_API_TOKEN:"test",CLOUDFLARE_ACCOUNT_ID:"a".repeat(32)},
     async(url)=>({ok:true,json:async()=>({success:true,result:url.includes("deployments")?{deployments:[deployment]}:
       url.endsWith("/settings")?serverSettings:url.includes("/versions/")?{...serverVersion,assets:{}}:
       {name:"life-log-uat",id:"worker-id"}})})));
 });
 it("detects postdeploy metadata drift without requiring the version ID to match",()=>{
   const before=normalizeWorkerState(serverSettings,serverVersion,"worker-id");
   for(const mutate of [
     x=>x.bindings.find(b=>b.name==="AUTH_RATE_LIMITER").simple.limit=6,
     x=>x.bindings[6].name="REMOVED",
     x=>x.assets.run_worker_first=false,
     x=>x.runtime.date="2026-11-03"
   ]){const after=clone(before);mutate(after);assert.throws(()=>assertSameBindings(before,after));}
 });
});
