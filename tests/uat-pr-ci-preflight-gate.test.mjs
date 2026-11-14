import {it} from "vitest";
import assert from "node:assert/strict";
import {evaluateEligibility,verifyFromGitHub} from "../scripts/uat-pr-ci-preflight-gate.mjs";

const MAIN="39a7d2ab3a30356bdb902ce206dcb30a0fdb84ec";
const HEAD="f1c2649627d2480582ee9e3f316fcd1043e6db77";
const REPO="ha-rookie/life-log";
const clone=x=>structuredClone(x);
function fixture(){
  const source={id:900,run_attempt:1,status:"completed",conclusion:"success",
    event:"pull_request",name:"Life-log local app and D1 CI",
    path:".github/workflows/life-log-ci.yml",head_sha:HEAD,head_branch:"feat/ui",
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    actor:{login:"ha-rookie"},pull_requests:[]};
  const main={ref:"refs/heads/main",object:{sha:MAIN}};
  const pr={number:172,state:"open",draft:false,merged_at:null,
    user:{login:"ha-rookie"},changed_files:1,
    head:{sha:HEAD,ref:"feat/ui",repo:{full_name:REPO}},
    base:{sha:MAIN,ref:"main",repo:{full_name:REPO}}};
  const prFiles=[{filename:"src/client/view.tsx"}];
  const jobs={total_count:3,jobs:["validate","chromium-e2e","worker-browser-e2e"]
    .map(name=>({name,run_id:900,status:"completed",conclusion:"success"}))};
  const history=[{id:1000,display_title:"UAT GET-only source-900",
    event:"workflow_run",status:"in_progress"}];
  return {source,main,prs:[pr],prFiles,jobs,history,upstreamId:900,
    upstreamHeadSha:HEAD,trustedSha:MAIN,downstreamRunId:1000,downstreamAttempt:1};
}
it("owner PR complete CI -> trusted-main metadata eligible (no PR artifacts)",()=>{
  assert.deepEqual(evaluateEligibility(fixture()),{eligible:true,sourceRunId:900,
    sourceHeadSha:HEAD,prNumber:172,mainSha:MAIN});
});
it("fail closed on untrusted upstream event, workflow, actor, fork, or rerun",()=>{
  const cases=[
    x=>x.source.event="push",
    x=>x.source.name="Another workflow",
    x=>x.source.path=".github/workflows/attacker.yml",
    x=>x.source.run_attempt=2,
    x=>x.source.status="in_progress",
    x=>x.source.conclusion="failure",
    x=>x.source.actor.login="other",
    x=>x.source.head_repository.full_name="other/repo",
    x=>x.source.repository.full_name="other/repo",
    x=>x.source.head_sha="a".repeat(40),
    x=>x.source.head_branch="other"
  ];
  for(const change of cases){const x=fixture();change(x);
    assert.throws(()=>evaluateEligibility(x));}
});
it("fail closed on PR HEAD/base/main race or external/closed/draft PR",()=>{
  const cases=[
    x=>x.main.object.sha="a".repeat(40),
    x=>x.main.ref="refs/heads/feature",
    x=>x.prs[0].head.sha="a".repeat(40),
    x=>x.prs[0].base.sha="a".repeat(40),
    x=>x.prs[0].head.ref="new-branch",
    x=>x.prs[0].base.ref="other",
    x=>x.prs[0].head.repo.full_name="attacker/fork",
    x=>x.prs[0].base.repo.full_name="attacker/fork",
    x=>x.prs[0].user.login="other",
    x=>x.prs[0].draft=true,
    x=>x.prs[0].state="closed",
    x=>x.prs[0].merged_at="2026-11-14T09:00:00Z",
    x=>x.prs=[],
    x=>x.prs.push(clone(x.prs[0]))
  ];
  for(const change of cases){const x=fixture();change(x);
    assert.throws(()=>evaluateEligibility(x));}
});
it("deny PR changes to CI, guard, secrets/config/schema and truncated pagination",()=>{
  for(const name of [".github/workflows/life-log-ci.yml",
    ".github/workflows/evil.yml","scripts/uat-readonly-preflight.mjs",
    "migrations/0005.sql","src/worker/index.ts","wrangler.jsonc",
    "package.json","package-lock.json"]){
    const x=fixture();x.prFiles[0].filename=name;
    assert.throws(()=>evaluateEligibility(x));
  }
  for(const change of [
    x=>x.prs[0].changed_files=101,
    x=>x.prFiles[0].previous_filename=".github/workflows/old.yml",
    x=>x.prFiles=[],
    x=>x.prFiles[0].filename=""
  ]){const x=fixture();try{change(x);}catch{continue;}
    assert.throws(()=>evaluateEligibility(x));}
});
it("CI must have exact three successful jobs from original upstream run",()=>{
  for(const change of [
    x=>x.jobs.total_count=4,
    x=>x.jobs.total_count=2,
    x=>x.jobs.jobs.pop(),
    x=>x.jobs.jobs[0].conclusion="failure",
    x=>x.jobs.jobs[1].status="in_progress",
    x=>x.jobs.jobs[2].run_id=999,
    x=>x.jobs.jobs[2].name="validate",
    x=>x.jobs.jobs[1].name="untrusted"
  ]){const x=fixture();change(x);assert.throws(()=>evaluateEligibility(x));}
});
it("run-attempt and duplicate source IDs cannot cause a second metadata GET",()=>{
  for(const change of [
    x=>x.downstreamAttempt=2,
    x=>x.history.push({id:999,display_title:"UAT GET-only source-900",
      event:"workflow_run",conclusion:"failure"}),
    x=>x.history=[],
    x=>x.history[0].id=1002,
    x=>x.history[0].event="pull_request",
    x=>x.downstreamRunId=900
  ]){const x=fixture();change(x);assert.throws(()=>evaluateEligibility(x));}
});
it("GitHub fetches fixed GET endpoints only and does not need PR-run pull_requests array",async()=>{
  const x=fixture(),visited=[];
  const responses={
    "/actions/runs/900":x.source,
    "/git/ref/heads/main":x.main,
    ["/commits/"+HEAD+"/pulls?per_page=100"]:x.prs,
    "/pulls/172/files?per_page=100":x.prFiles,
    "/actions/runs/900/jobs?per_page=100":x.jobs,
    "/actions/workflows/life-log-uat-pr-ci-auto-preflight.yml/runs?event=workflow_run&per_page=100&page=1":
      {total_count:1,workflow_runs:x.history}
  };
  const mocked=async(url,opts)=>{
    const path=url.replace("https://api.github.com/repos/"+REPO,"");
    visited.push({url,path,opts});
    assert(path in responses,"Unknown route "+path);
    return {ok:true,json:async()=>clone(responses[path])};
  };
  const result=await verifyFromGitHub({env:{GH_TOKEN:"TEST-SECRET",
    UPSTREAM_RUN_ID:"900",UPSTREAM_HEAD_SHA:HEAD,TRUSTED_MAIN_SHA:MAIN,
    GITHUB_RUN_ID:"1000",GITHUB_RUN_ATTEMPT:"1"},request:mocked});
  assert.equal(result.eligible,true);
  assert.equal(visited.length,7); // main checked twice
  assert(visited.every(({url,opts})=>url.startsWith("https://api.github.com/repos/"+
    REPO+"/") && opts.method==="GET" && opts.redirect==="error"));
  assert(visited.some(r=>r.path.includes("/commits/"+HEAD+"/pulls")));
  assert(!JSON.stringify(result).includes("TEST-SECRET"));
});
it("denies missing token and invalid IDs without making an API request",async()=>{
  let count=0;
  const request=async()=>{count++;throw Error("must not GET");};
  for(const env of [
    {UPSTREAM_RUN_ID:"900",GITHUB_RUN_ID:"1000",TRUSTED_MAIN_SHA:MAIN,
      UPSTREAM_HEAD_SHA:HEAD,GITHUB_RUN_ATTEMPT:"1"},
    {GH_TOKEN:"x",UPSTREAM_RUN_ID:"not-a-number",GITHUB_RUN_ID:"1000",
      TRUSTED_MAIN_SHA:MAIN,UPSTREAM_HEAD_SHA:HEAD,GITHUB_RUN_ATTEMPT:"1"}
  ])await assert.rejects(verifyFromGitHub({env,request}));
  assert.equal(count,0);
});
it("403/404/malformed JSON or inaccessible history is denied without leakage",async()=>{
  const env={GH_TOKEN:"x",UPSTREAM_RUN_ID:"900",UPSTREAM_HEAD_SHA:HEAD,
    TRUSTED_MAIN_SHA:MAIN,GITHUB_RUN_ID:"1000",GITHUB_RUN_ATTEMPT:"1"};
  for(const response of [
    {ok:false,status:403,json:async()=>({})},
    {ok:false,status:404,json:async()=>({})},
    {ok:true,json:async()=>{throw Error("bad token");}}
  ])await assert.rejects(verifyFromGitHub({env,request:async()=>response}));
});
