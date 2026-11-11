#!/usr/bin/env node
/** No network access. Static CI gate for combining the two local ECLEAR browser suites
 * and for keeping main-push workflows from silently reading Remote D1.
 * Issue #142 (Android/UAT/real data) must NOT be closed by test-only PRs.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const load=path=>readFileSync(path,"utf8");

function closingIssues(body){
  return [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([0-9]+)/gi)]
    .map(x=>Number(x[1]));
}
function testClosing(body,issue){
  const found=closingIssues(body);
  assert.deepEqual(found,[issue],
    "Scope Guard must close only the test-infrastructure issue, not acceptance #142");
}
function requireManualOnly(workflow){
  const start=workflow.indexOf("\non:\n");
  assert(start>=0,"workflow must declare explicit 'on:'");
  const end=workflow.indexOf("\npermissions:",start);
  assert(end>start,"workflow triggers have an expected delimiter");
  const triggers=workflow.slice(start,end);
  assert.match(triggers,/\n  workflow_dispatch:\n/);
  assert.doesNotMatch(triggers,/\n  (?:push|pull_request|workflow_run|schedule|repository_dispatch):/);
  assert.match(triggers,/\n      target_sha:\n/);
  assert.match(triggers,/\n      confirmation:\n/);
  assert.match(workflow,/github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/inputs\.confirmation == 'READ LIFELOG D1 METADATA'/);
  assert.match(workflow,/test "\$GITHUB_SHA" = "\$TARGET_SHA"/);
  assert.match(workflow,/test "\$current_main" = "\$TARGET_SHA"/);
  assert.match(workflow,/\[\[ "\$TARGET_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/);
  const firstStep=workflow.indexOf("    steps:");
  assert(firstStep>0,"manual job has steps");
  assert.doesNotMatch(workflow.slice(0,firstStep),/secrets\.CLOUDFLARE_/,
    "do not expose Cloudflare Secrets at the job level before the SHA gate");
  const auth=workflow.indexOf("- name: Require exact explicitly approved current main SHA");
  const token=workflow.indexOf("- name: Verify token status (GET only)");
  const d1=workflow.indexOf("- name: Check development D1 metadata (GET only)");
  assert(auth>=0 && token>auth && d1>token,
    "GH main-SHA + explicit authorization must precede BOTH remote GET steps");
}

function verify(){
  const ci=load(".github/workflows/life-log-ci.yml");
  for(const name of ["validate","chromium-e2e","worker-browser-e2e"]){
    const occurrences=ci.split("  "+name+":").length-1;
    assert.equal(occurrences,1,"one distinct CI job: "+name);
  }
  for(const command of ["scripts/eclear-390-chromium-e2e.mjs",
    "scripts/eclear-worker-browser-local.sh","scripts/verify-integration-gates.mjs"]){
    assert(ci.includes(command),"CI must execute "+command);
  }
  assert.match(ci,/node scripts\/verify-integration-gates\.mjs/);
  assert.match(ci,/bash scripts\/verify-password-uat-local\.sh/);
  assert.match(ci,/npm run db:migrate:local/);
  assert.match(ci,/CHROME_BIN: \/usr\/bin\/google-chrome/);

  const remote=load(".github/workflows/cloudflare-d1-readonly-check.yml");
  requireManualOnly(remote);

  const workerScript=load("scripts/eclear-worker-browser-local.sh");
  const chromiumScript=load("scripts/eclear-390-chromium-e2e.mjs");
  const checkedWorkerLines=workerScript.split("\n")
    .filter(s=>!s.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(checkedWorkerLines,/(?:wrangler|npx).*--remote\b/);
  assert.doesNotMatch(checkedWorkerLines,/api\.cloudflare\.com/i);
  assert.match(workerScript,/--local --persist-to/);
  assert.match(workerScript,/cp "\$auth_original" "\$auth_source"/);
  assert.match(chromiumScript,/Fetch\.failRequest/);
  assert.match(chromiumScript,/url\.origin!=="http:\/\/127\.0\.0\.1:5187"/);
  const production=load("src/worker/passkey-auth.ts");
  assert.match(production,/const ORIGIN="https:\/\/life-log-uat\.ha-rookie\.workers\.dev"/);
  assert.doesNotMatch(production,/PASSKEY_LOCAL_E2E_ONLY/);
  const testedBody=process.env.PR_BODY??"";
  if(process.env.GITHUB_EVENT_NAME==="pull_request")testClosing(testedBody,147);
  console.log("PASS offline: both browser jobs, local-only D1, fixed production passkey, manual-only Remote D1 GET, single non-acceptance closing Issue");
}

if(process.argv.includes("--self-test")){
  testClosing("Closes #147. Refs #142; Refs #124.",147);
  assert.throws(()=>testClosing("Closes #142",147));
  assert.throws(()=>testClosing("Closes #147\nFixes #142",147));
  assert.throws(()=>requireManualOnly("name: accidental read\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\n"));
  console.log("PASS: unsafe close references and automatic push triggers rejected");
}else{verify();}
