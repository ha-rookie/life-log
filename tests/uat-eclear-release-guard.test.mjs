import {describe,it,expect} from "vitest";
import assert from "node:assert/strict";
import {assertUatBefore,assertUatAfter,verifyRemoteEclearSchema,EXPECTED_ADDITIONS} from
  "../scripts/uat-eclear-release-guard.mjs";
import {DATABASE,ORIGIN} from "../scripts/uat-ui-release-guard.mjs";
const src={
  workerId:"known-uat-worker",runtime:{date:"2026-11-04",flags:[]},
  assets:{run_worker_first:true,not_found_handling:"single-page-application",
    base_path:"/",html_handling:"auto-trailing-slash"},
  bindings:[
    {name:"ASSETS",type:"assets"},
    {name:"AUTH_RATE_LIMITER",type:"ratelimit",namespace_id:"1001",
      simple:{limit:5,period:60}},
    {name:"DB",type:"d1",id:DATABASE},
    {name:"MANUAL_REMOTE_ORIGIN",type:"plain_text",text:ORIGIN},
    {name:"MANUAL_REMOTE_TARGET",type:"plain_text",text:"uat"},
    {name:"MANUAL_REMOTE_WRITE_ENABLED",type:"plain_text",text:"true"},
    {name:"OWNER_SECRET",type:"secret_text"},
  ]
};
const clone=x=>structuredClone(x);
const compare=x=>[...x].sort((a,b)=>a.name.localeCompare(b.name,"en"));
describe("UAT ECLEAR seven-field Worker-only feature gate (synthetic)",()=>{
 it("allows only expected four additive bindings while preserving everything else",()=>{
   const old=clone(src),next=clone(src);
   next.bindings=compare([...old.bindings,...EXPECTED_ADDITIONS]);
   expect(assertUatBefore(old)).toBe(true);
   expect(assertUatAfter(old,next)).toBe(true);
   assert.deepEqual(old,src);
 });
 it("refuses preexisting keys, secret rotation, unknown identities and changes",()=>{
   for(const addition of EXPECTED_ADDITIONS){
     const existing=clone(src);existing.bindings.push(addition);
     assert.throws(()=>assertUatBefore(existing));
   }
   const next=clone(src);next.bindings=compare([...next.bindings,...EXPECTED_ADDITIONS]);
   for(const corrupt of [
     x=>x.workerId="another-worker",
     x=>x.runtime.date="2026-01-01",
     x=>x.assets.run_worker_first=false,
     x=>x.bindings.find(b=>b.name==="DB").id="different-db",
     x=>x.bindings.find(b=>b.name==="AUTH_RATE_LIMITER").simple.limit=6,
     x=>x.bindings.find(b=>b.name==="MANUAL_REMOTE_WRITE_ENABLED").text="false",
     x=>x.bindings.find(b=>b.name==="ECLEAR_ENRICHMENT_REMOTE_ENABLED").text="false",
     x=>x.bindings.find(b=>b.name==="ECLEAR_ENRICHMENT_REVIEW_KEY").type="plain_text",
     x=>x.bindings.push({name:"EXTRA_SECRET",type:"secret_text"})
   ]){
     const bad=clone(next);corrupt(bad);assert.throws(()=>assertUatAfter(clone(src),bad));
   }
 });
 it("inspects exactly fixed D1 schema and migration filename without data rows",async()=>{
   const requests=[];
   const get=async(url,opts)=>{
     requests.push({url,method:opts.method,sql:opts.body&&JSON.parse(opts.body).sql});
     if(opts.method==="GET")return {ok:true,json:async()=>({
       success:true,result:{uuid:DATABASE,name:"life-log-dev"}
     })};
     const sql=JSON.parse(opts.body).sql;
     const results=sql.includes("sqlite_schema")?
       ["eclear_enrichment_asserts","eclear_enrichment_cell_audit",
        "eclear_enrichment_jobs","eclear_enrichment_row_audit"].map(name=>({name})):
       [{name:"0005_eclear_enrichment_audit.sql"}];
     return {ok:true,json:async()=>({success:true,result:[{
       success:true,results,meta:{changes:0,changed_db:false}
     }]})};
   };
   await verifyRemoteEclearSchema({
     CLOUDFLARE_API_TOKEN:"synthetic-never-cloudflare-token",
     CLOUDFLARE_ACCOUNT_ID:"a".repeat(32)
   },get);
   assert.equal(requests.length,3);
   assert.equal(requests[0].method,"GET");
   assert(requests.slice(1).every(x=>x.method==="POST"&&
     /^(SELECT name FROM sqlite_schema|SELECT name FROM d1_migrations)/.test(x.sql)));
   assert(requests.every(x=>!/(?:body_measurements|owner_sessions|owner_passkey)/.test(x.sql??"")));
 });
});
