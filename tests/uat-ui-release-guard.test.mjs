import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {prepareConfig,snapshotBindings,assertSameBindings,
  DATABASE,ORIGIN} from "../scripts/uat-ui-release-guard.mjs";

const config={
 name:"life-log-dev",main:"src/worker/index.ts",workers_dev:false,
 d1_databases:[{binding:"DB",database_name:"life-log-dev",database_id:DATABASE}],
 env:{uat:{
  name:"life-log-uat",workers_dev:true,
  assets:{directory:"./dist",binding:"ASSETS",run_worker_first:true},
  d1_databases:[{binding:"DB",database_name:"life-log-dev",database_id:DATABASE}],
  unsafe:{bindings:[{name:"AUTH_RATE_LIMITER",type:"ratelimit",namespace_id:"1001"}]},
  vars:{MANUAL_REMOTE_WRITE_ENABLED:"false",MANUAL_REMOTE_TARGET:"uat",
    MANUAL_REMOTE_ORIGIN:ORIGIN}
 }}
};
const bindings=[
 {type:"assets",name:"ASSETS"},
 {type:"d1",name:"DB",id:DATABASE},
 {type:"ratelimit",name:"AUTH_RATE_LIMITER",namespace_id:"1001"},
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
