import {describe,it,expect} from "vitest";
import assert from "node:assert/strict";
import {inspectRemoteUat,checkPreflightPayloads,canonicalizeLiveAssets}
  from "../scripts/uat-readonly-preflight.mjs";
import {WORKER,DATABASE,ORIGIN,COMPATIBILITY_DATE}
  from "../scripts/uat-ui-release-guard.mjs";

const clone=value=>structuredClone(value);
const worker={name:WORKER,id:"e8f70fdbc8b1fb0b8ddb1af166186758",
  subdomain:{enabled:true}};
const active="023e105f-2a42-4f8b-a1c1-73f6a2a30c0f";
const deployments={deployments:[{id:"182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
  created_on:"2026-11-14T08:00:00Z",strategy:"percentage",
  versions:[{percentage:100,version_id:active}]}]};
const bindings=[
  {name:"ASSETS",type:"assets"},
  {name:"DB",type:"d1",database_id:DATABASE},
  {name:"AUTH_RATE_LIMITER",type:"ratelimit",namespace_id:"1001",
    simple:{limit:5,period:60}},
  {name:"MANUAL_REMOTE_WRITE_ENABLED",type:"plain_text",text:"true"},
  {name:"MANUAL_REMOTE_TARGET",type:"plain_text",text:"uat"},
  {name:"MANUAL_REMOTE_ORIGIN",type:"plain_text",text:ORIGIN},
  {name:"PASSWORD_ONLY_UAT",type:"plain_text",text:"true"},
  {name:"OWNER_SETUP_CODE",type:"secret_text"}
];
const settings={compatibility_date:COMPATIBILITY_DATE,bindings};
const version={id:active,compatibility_date:COMPATIBILITY_DATE,bindings,
  assets:{config:{run_worker_first:true,not_found_handling:"single-page-application",
    base_path:"/",html_handling:"auto-trailing-slash"}}};
const config={name:"life-log-dev",main:"src/worker/index.ts",compatibility_date:COMPATIBILITY_DATE,
  assets:{directory:"./dist",binding:"ASSETS",run_worker_first:true,
    not_found_handling:"single-page-application"},
  d1_databases:[{binding:"DB",database_id:DATABASE}],
  env:{uat:{name:WORKER,workers_dev:true,
    assets:{directory:"./dist",binding:"ASSETS",run_worker_first:true,
      not_found_handling:"single-page-application"},
    d1_databases:[{binding:"DB",database_id:DATABASE,database_name:"life-log-dev"}],
    unsafe:{bindings:[{name:"AUTH_RATE_LIMITER",type:"ratelimit",namespace_id:"1001",
      simple:{limit:5,period:60}}]},
    vars:{MANUAL_REMOTE_WRITE_ENABLED:"false",MANUAL_REMOTE_TARGET:"uat",
      MANUAL_REMOTE_ORIGIN:ORIGIN}
  }}};
const fixture=()=>({firstWorker:clone(worker),firstDeployments:clone(deployments),
  version:clone(version),settings:clone(settings),lastWorker:clone(worker),
  lastDeployments:clone(deployments)});
describe("GET-only UAT live metadata check (synthetic, never contacts Cloudflare)",()=>{
  it("accepts unconditional worker-first true and exactly equivalent wildcard array",()=>{
    for(const shape of [true,["/*"]]){
      const x=fixture();x.version.assets.config.run_worker_first=shape;
      const verified=checkPreflightPayloads(x);
      expect(verified).toMatchObject({verified:true,workerId:worker.id,
        activeVersion:active,secretBindingCount:1});
      expect(JSON.stringify(verified)).not.toContain("OWNER_SETUP_CODE");
    }
  });
  it("rejects selective/negative/empty and unknown assets routing",()=>{
    for(const shape of [false,["/api/*"],["/*","!/private/*"],[],
      ["*"],null,undefined]){
      const x=fixture();x.version.assets.config.run_worker_first=shape;
      assert.throws(()=>checkPreflightPayloads(x));
    }
    for(const change of [
      x=>x.version.assets.config.not_found_handling="404-page",
      x=>x.version.assets.config.base_path="/private",
      x=>x.version.assets.config.html_handling="none",
      x=>delete x.version.assets,
    ]){const x=fixture();change(x);assert.throws(()=>checkPreflightPayloads(x));}
    assert.deepEqual(canonicalizeLiveAssets({
      config:{run_worker_first:["/*"],not_found_handling:"single-page-application"}
    }).config.run_worker_first,true);
  });
  it("refuses worker ID/name/subdomain and active deployment/version drift",()=>{
    for(const change of [
      x=>x.firstWorker.id="not-id",
      x=>x.lastWorker.id="e8f70fdbc8b1fb0b8ddb1af166186759",
      x=>x.firstWorker.name="other-worker",
      x=>x.lastWorker.subdomain.enabled=false,
      x=>x.firstDeployments.deployments[0].versions[0].percentage=50,
      x=>x.firstDeployments.deployments[0].versions.push({
        percentage:50,version_id:active}),
      x=>x.lastDeployments.deployments[0].id="c71e2963-7ca1-46b6-9220-a1789ce84ae3",
      x=>x.version.id="c71e2963-7ca1-46b6-9220-a1789ce84ae3",
      x=>x.firstDeployments.deployments=[],
      x=>x.firstDeployments.deployments.push(clone(x.firstDeployments.deployments[0]))
    ]){const x=fixture();change(x);assert.throws(()=>checkPreflightPayloads(x));}
  });
  it("rejects missing/renamed auth or secret bindings and passkey mode loss",()=>{
    for(const change of [
      x=>x.settings.bindings.find(b=>b.name==="PASSWORD_ONLY_UAT").text="false",
      x=>x.version.bindings.find(b=>b.name==="PASSWORD_ONLY_UAT").text="false",
      x=>x.version.bindings.find(b=>b.name==="OWNER_SETUP_CODE").name="NEW_SECRET",
      x=>x.settings.bindings.pop(),
      x=>x.version.bindings.find(b=>b.name==="OWNER_SETUP_CODE").type="plain_text",
      x=>x.settings.bindings.find(b=>b.name==="PASSWORD_ONLY_UAT").type="secret_text",
      x=>delete x.version.bindings
    ]){const x=fixture();change(x);assert.throws(()=>checkPreflightPayloads(x));}
  });
  it("rejects rate limiter, D1, runtime, assets and any plaintext drift",()=>{
    for(const change of [
      x=>x.settings.bindings.find(b=>b.name==="AUTH_RATE_LIMITER").simple.period=30,
      x=>x.version.bindings.find(b=>b.name==="AUTH_RATE_LIMITER").simple.limit=10,
      x=>delete x.version.bindings.find(b=>b.name==="AUTH_RATE_LIMITER").simple,
      x=>x.version.bindings.find(b=>b.name==="DB").database_id="other",
      x=>x.version.compatibility_date="2026-10-01",
      x=>x.settings.compatibility_flags=["nodejs_compat"],
      x=>x.settings.bindings.find(b=>b.name==="MANUAL_REMOTE_ORIGIN").text="other",
      x=>x.version.bindings.find(b=>b.name==="ASSETS").name="OTHER_ASSETS"
    ]){const x=fixture();change(x);assert.throws(()=>checkPreflightPayloads(x));}
  });
  it("calls only six fixed GET metadata routes, without D1/Secrets endpoints",async()=>{
    const paths=[];
    const fake=async(url,opts)=>{
      paths.push({url,opts});
      const result=url.endsWith("/workers/workers/"+WORKER)?worker:
        url.includes("/deployments?")?deployments:
        url.includes("/versions/")?version:
        url.endsWith("/settings")?settings:null;
      return {ok:true,json:async()=>({success:true,result})};
    };
    const good=await inspectRemoteUat({configText:JSON.stringify(config),
      env:{CLOUDFLARE_API_TOKEN:"synthetic-token",
        CLOUDFLARE_ACCOUNT_ID:"a".repeat(32)},request:fake});
    assert.equal(good.verified,true);
    assert.equal(paths.length,6);
    for(const item of paths){
      assert.equal(item.opts.method,"GET");
      assert.equal(item.opts.redirect,"error");
      assert(item.url.startsWith("https://api.cloudflare.com/client/v4/accounts/"));
      assert(!/\/d1\/|\/secrets\//.test(item.url));
    }
    assert(!JSON.stringify(good).includes("synthetic-token"));
  });
  it("rejects malformed config and missing credentials before any network call",async()=>{
    let requests=0;
    const request=async()=>{requests++;throw Error("should never execute");};
    await assert.rejects(inspectRemoteUat({configText:JSON.stringify({...config,
      compatibility_date:"2026-01-01"}),env:{CLOUDFLARE_API_TOKEN:"x",
      CLOUDFLARE_ACCOUNT_ID:"a".repeat(32)},request}));
    await assert.rejects(inspectRemoteUat({configText:JSON.stringify(config),
      env:{CLOUDFLARE_ACCOUNT_ID:"a".repeat(32)},request}));
    assert.equal(requests,0);
  });
  it("fails closed on 403/500, missing result, and malformed JSON",async()=>{
    for(const response of [
      {ok:false,status:403,json:async()=>({success:false})},
      {ok:false,status:500,json:async()=>({success:false})},
      {ok:true,json:async()=>({success:true,result:null})},
      {ok:true,json:async()=>{throw Error("invalid JSON");}}
    ])await assert.rejects(inspectRemoteUat({
      configText:JSON.stringify(config),env:{CLOUDFLARE_API_TOKEN:"x",
        CLOUDFLARE_ACCOUNT_ID:"a".repeat(32)},request:async()=>response
    }));
  });
});
