#!/usr/bin/env node
/**
 * Privileged workflow_run trust-boundary gate. Never execute PR code/artifacts.
 * No Cloudflare/Remote D1 calls and no token, API payload or user text output.
 */
const REPO="ha-rookie/life-log";
const OWNER="ha-rookie";
const SOURCE_WORKFLOW="Life-log local app and D1 CI";
const SOURCE_PATH=".github/workflows/life-log-ci.yml";
const DOWNSTREAM_WORKFLOW="life-log-uat-pr-ci-auto-preflight.yml";
const HEX=/^[a-f0-9]{40}$/;
function requireSafe(ok,reason){if(!ok)throw Error("PR preflight provenance denied: "+reason);}
function validInt(n){return Number.isSafeInteger(n)&&n>0;}
const risky=path=>
  typeof path!=="string" || path.length===0 ||
  path.startsWith(".github/") || path.startsWith("scripts/") ||
  path.startsWith("migrations/") || path.startsWith("src/worker/") ||
  ["wrangler.jsonc","package.json","package-lock.json"].includes(path);

/** Fully synthetic verification; no state mutation, no Cloudflare and no payload logs. */
export function evaluateEligibility(x){
  const {source,main,prs,prFiles,jobs,history,upstreamId,upstreamHeadSha,
    trustedSha,downstreamRunId,downstreamAttempt}=x;
  requireSafe(HEX.test(trustedSha||""),"untrusted main SHA");
  requireSafe(validInt(upstreamId)&&validInt(downstreamRunId)&&
    upstreamId!==downstreamRunId,"invalid workflow run identity");
  requireSafe(downstreamAttempt===1,"downstream rerun forbidden");
  requireSafe(source?.id===upstreamId && source.run_attempt===1 &&
    source.status==="completed" && source.conclusion==="success" &&
    source.event==="pull_request" && source.name===SOURCE_WORKFLOW &&
    source.path===SOURCE_PATH &&
    source.repository?.full_name===REPO &&
    source.head_repository?.full_name===REPO &&
    source.actor?.login===OWNER && source.head_sha===upstreamHeadSha &&
    HEX.test(source.head_sha||""),"upstream provenance not verified");
  requireSafe(main?.ref==="refs/heads/main"&&main.object?.sha===trustedSha,
    "main moved during CI");
  requireSafe(Array.isArray(prs)&&prs.length===1,"unverified PR association");
  const pr=prs[0];
  requireSafe(validInt(pr?.number) && pr.state==="open" && !pr.draft &&
    pr.merged_at===null && pr.user?.login===OWNER &&
    pr.head?.repo?.full_name===REPO && pr.base?.repo?.full_name===REPO &&
    pr.base?.ref==="main" && pr.base.sha===trustedSha &&
    pr.head?.sha===source.head_sha && pr.head.ref===source.head_branch,
    "stale/foreign/draft/untrusted PR");
  requireSafe(Array.isArray(prFiles)&&prFiles.length>0 && prFiles.length<=100 &&
    pr.changed_files===prFiles.length &&
    prFiles.every(f=>!risky(f.filename)&&(!f.previous_filename||!risky(f.previous_filename))),
    "PR alters security-sensitive paths or files not fully enumerated");
  requireSafe(jobs && jobs.total_count===3 && Array.isArray(jobs.jobs) &&
    jobs.jobs.length===3,"CI job inventory incomplete");
  const names=new Set();
  for(const j of jobs.jobs){
    requireSafe(j && ["validate","chromium-e2e","worker-browser-e2e"].includes(j.name)&&
      !names.has(j.name) && j.status==="completed" && j.conclusion==="success" &&
      j.run_id===upstreamId,"CI job failed, missing or not tied to upstream run");
    names.add(j.name);
  }
  requireSafe(names.size===3,"missing required CI job");
  requireSafe(Array.isArray(history)&&history.length>0 &&
    history.some(r=>r.id===downstreamRunId),"cannot verify downstream run identity");
  const title="UAT GET-only source-"+upstreamId;
  for(const run of history){
    requireSafe(validInt(run.id) && typeof run.display_title==="string" &&
      run.event==="workflow_run","ambiguous downstream execution history");
    requireSafe(!(run.id!==downstreamRunId && run.display_title===title),
      "duplicate source run has already been processed");
  }
  return {eligible:true,sourceRunId:upstreamId,sourceHeadSha:source.head_sha,
    prNumber:pr.number,mainSha:trustedSha};
}

/** GitHub GET-only metadata; fixed repository paths, no untrusted URL input. */
export async function verifyFromGitHub({env=process.env,request=fetch}={}){
  const token=env.GH_TOKEN;
  const upstreamId=Number(env.UPSTREAM_RUN_ID),downstreamRunId=Number(env.GITHUB_RUN_ID);
  const downstreamAttempt=Number(env.GITHUB_RUN_ATTEMPT);
  const trustedSha=env.TRUSTED_MAIN_SHA,upstreamHeadSha=env.UPSTREAM_HEAD_SHA;
  requireSafe(typeof token==="string"&&token.length>0,"missing GitHub metadata token");
  requireSafe(HEX.test(trustedSha||"")&&HEX.test(upstreamHeadSha||"")&&
    validInt(upstreamId)&&validInt(downstreamRunId),"invalid workflow metadata");
  // GitHub Actions workflow_run always uses default-branch code; recheck main by API.
  const origin="https://api.github.com/repos/"+REPO;
  const get=async path=>{
    requireSafe(path.startsWith("/") && !path.includes(".."),"invalid API path");
    try{
      const response=await request(origin+path,{
        method:"GET",redirect:"error",
        headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json",
          "X-GitHub-Api-Version":"2022-11-28"},signal:AbortSignal.timeout(15000)
      });
      requireSafe(response?.ok===true,"GitHub metadata access unavailable");
      return await response.json();
    }catch{throw Error("PR preflight provenance denied: GitHub API unavailable");}
  };
  const source=await get("/actions/runs/"+upstreamId);
  const main=await get("/git/ref/heads/main");
  requireSafe(source?.head_sha===upstreamHeadSha,"upstream head drift");
  const prs=await get("/commits/"+upstreamHeadSha+"/pulls?per_page=100");
  requireSafe(Array.isArray(prs)&&prs.length===1,"PR association missing/ambiguous");
  const pr=prs[0];
  // No query of arbitrary PR number; only ID returned from GitHub's source-commit association.
  requireSafe(validInt(pr.number),"invalid PR number");
  const files=await get("/pulls/"+pr.number+"/files?per_page=100");
  const jobs=await get("/actions/runs/"+upstreamId+"/jobs?per_page=100");
  // A duplicate delivery is serialized by concurrency. Detect any earlier downstream
  // run for this SAME upstream source before injecting Cloudflare credentials.
  const history=[];
  const route="/actions/workflows/"+DOWNSTREAM_WORKFLOW+"/runs?event=workflow_run&per_page=100&page=";
  let total=null;
  for(let page=1;page<=20;page++){
    const response=await get(route+page);
    requireSafe(validInt(response?.total_count)&&response.total_count<=2000 &&
      Array.isArray(response.workflow_runs),"unverifiable preflight replay history");
    if(total===null)total=response.total_count;
    requireSafe(total===response.total_count,"preflight history changed during pagination");
    history.push(...response.workflow_runs);
    if(history.length>=total)break;
  }
  requireSafe(history.length===total,"preflight replay history incomplete");
  const eligible=evaluateEligibility({source,main,prs,prFiles:files,jobs,history,
    upstreamId,upstreamHeadSha,trustedSha,downstreamRunId,downstreamAttempt});
  // Recheck immediately before returning; the secret-bearing job independently
  // runs the same gate again before its only Cloudflare GET step.
  const latest=await get("/git/ref/heads/main");
  requireSafe(latest?.object?.sha===trustedSha,"main advanced during gate");
  return eligible;
}
async function main(){
  await verifyFromGitHub();
  console.log("Trusted-main PR CI provenance PASS (no PR code or artifacts executed).");
}
import {pathToFileURL} from "node:url";
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{
    console.error("Trusted-main PR CI provenance FAIL; no Cloudflare metadata GET executed.");
    process.exitCode=1;
  });
}
