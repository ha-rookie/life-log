import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  DATABASE_ID,DATABASE_NAME,REPO,CONFIRMATION,MIGRATION_0005,TABLES,SQL,
  assertAllowedSql,assertManualContext,assertOneShotContext,assertReadContext,ONE_SHOT_SUBJECT,ONE_SHOT_APPROVAL,validateLocalConfig,sanitizeRows,
  readMetadata,queryOnly,renderSummary
} from "./d1-schema-readonly.mjs";

const SHA="a".repeat(40);
const env=()=>({
  GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_REF:"refs/heads/main",
  GITHUB_REPOSITORY:REPO,GITHUB_SHA:SHA,TARGET_SHA:SHA,
  CONFIRMATION,GH_TOKEN:"synthetic-gh-token-only",
  CLOUDFLARE_ACCOUNT_ID:"b".repeat(32),
  CLOUDFLARE_API_TOKEN:"synthetic-cloudflare-token-only"
});
const config=()=>JSON.stringify({
  d1_databases:[{binding:"DB",database_id:DATABASE_ID,
    database_name:DATABASE_NAME,migrations_dir:"migrations"}],
  env:{uat:{name:"life-log-uat",d1_databases:[{
    binding:"DB",database_id:DATABASE_ID,
    database_name:DATABASE_NAME,migrations_dir:"migrations"
  }]}}
});
const response=body=>({ok:true,json:async()=>body});
const queryResponse=rows=>response({success:true,result:[{
  success:true,results:rows,meta:{changes:0,changed_db:false}
}]});
const ddlRows=(present=false,ledger=true)=>[
  ...(ledger?[{type:"table",name:"d1_migrations",tbl_name:"d1_migrations",
    sql:"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TIMESTAMP)"}]:[]),
  {type:"table",name:"body_measurements",tbl_name:"body_measurements",
    sql:"CREATE TABLE body_measurements(id TEXT PRIMARY KEY, weight_kg REAL)"},
  ...(present?TABLES.filter(n=>n.startsWith("eclear_enrichment_")).map(n=>({
    type:"table",name:n,tbl_name:n,sql:"CREATE TABLE "+n+"(id TEXT PRIMARY KEY)"
  })):[])
];
function stub({hasEclear=false,hasMigration=false,hasLedger=true,wrongId=false,
              changedDb=false,leak=false}={}){
  const requests=[];
  const fetchFn=async(url,opts)=>{
    requests.push({url,method:opts.method,body:opts.body});
    if(url==="https://api.github.com/repos/"+REPO+"/git/ref/heads/main")
      return response({object:{sha:SHA}});
    if(!url.includes("/query"))return response({
      success:true,result:{uuid:wrongId?"deadbeef":DATABASE_ID,name:DATABASE_NAME}
    });
    const payload=JSON.parse(opts.body);
    assert.equal(payload.params.length,0);
    assertAllowedSql(payload.sql);
    let rows=[];
    if(payload.sql===SQL.schema)rows=ddlRows(hasEclear,hasLedger);
    else if(payload.sql===SQL.migrations){
      rows=[{name:"0003_owner_passkey.sql",applied_at:"2026-11-08 00:00:00"}];
      if(hasMigration)rows.push({name:MIGRATION_0005,applied_at:"2026-11-12 00:00:00"});
    }
    else if(payload.sql===SQL["columns:body_measurements"]){
      rows=[{cid:0,name:"id",type:"TEXT",notnull:1,dflt_value:null,pk:1}];
      if(leak)rows[0].secret_cookie="NO_VALUE_MAY_ESCAPE";
    }
    return response({success:true,result:[{
      success:true,results:rows,meta:{changes:0,changed_db:changedDb}
    }]});
  };
  return {fetchFn,requests};
}
test("config and Owner-independent target identity locked to the one existing UAT D1",()=>{
  assert.equal(validateLocalConfig(config()),true);
  const wrong=JSON.parse(config());
  wrong.env.uat.d1_databases[0].database_id="c".repeat(36);
  assert.throws(()=>validateLocalConfig(JSON.stringify(wrong)));
  const other=JSON.parse(config());
  other.d1_databases.push(other.d1_databases[0]);
  assert.throws(()=>validateLocalConfig(JSON.stringify(other)));
  assert.equal(validateLocalConfig(readFileSync("wrangler.jsonc","utf8")),true);
});
test("manual event, exact main SHA and explicit confirmation fail closed",()=>{
  assertManualContext(env());
  for(const change of [
    {GITHUB_EVENT_NAME:"push"},{GITHUB_EVENT_NAME:"pull_request"},
    {GITHUB_REF:"refs/heads/feature"},{GITHUB_REPOSITORY:"someone/else"},
    {CONFIRMATION:"READ LIFELOG D1 METADATA"},
    {GITHUB_SHA:"c".repeat(40)},{TARGET_SHA:"bad"}
  ])assert.throws(()=>assertManualContext({...env(),...change}));
});
test("SQL allowlist exactly excludes row reads, secrets, writes and arbitrary PRAGMA",()=>{
  assert(SQL.schema.startsWith("SELECT type,name,tbl_name,sql FROM sqlite_schema"));
  assert(SQL.migrations.startsWith("SELECT name,applied_at FROM d1_migrations"));
  for(const sql of Object.values(SQL)){
    assertAllowedSql(sql);
    assert(!sql.includes(";"));
  }
  for(const disallowed of [
    "SELECT * FROM body_measurements",
    "SELECT weight_kg FROM body_measurements",
    "SELECT * FROM owner_sessions",
    "SELECT new_value FROM eclear_enrichment_cell_audit",
    "SELECT count(*) FROM body_measurements",
    "PRAGMA table_info('owner_passkey_credentials')",
    "PRAGMA writable_schema=ON",
    SQL.migrations+"; DELETE FROM body_measurements",
    "UPDATE body_measurements SET weight_kg=0",
    "DROP TABLE body_measurements",
    "SELECT name FROM sqlite_schema"
  ])assert.throws(()=>assertAllowedSql(disallowed));
  assert.equal(TABLES.filter(n=>n.startsWith("eclear_enrichment_")).length,4);
});
test("read-only metadata returns no measured, credential, session or audit row values",async()=>{
  const s=stub(),result=await readMetadata(s.fetchFn,env(),config());
  assert.equal(result.applied0005,false);
  assert.equal(result.eclearTablePresence,"0/4");
  assert(result.migrations.some(m=>m.name==="0003_owner_passkey.sql"));
  assert(!result.schema.some(s=>s.name==="owner_sessions"));
  assert.equal(s.requests[0].method,"GET");
  assert.equal(s.requests[1].method,"GET");
  assert(s.requests.slice(2).every(r=>r.method==="POST"));
  assert(s.requests.slice(2).every(r=>assertAllowedSql(JSON.parse(r.body).sql)));
  for(const r of s.requests.slice(2)){
    const sql=JSON.parse(r.body).sql;
    assert(!/\bFROM\s+(?:body_measurements|eclear_enrichment_cell_audit|owner_sessions|owner_passkey_credentials)\b/i.test(sql));
  }
  const summary=renderSummary(result);
  assert(summary.includes("Migration 0005 applied: false"));
  assert(!summary.includes("synthetic-cloudflare-token-only"));
  assert(!summary.includes("NO_VALUE_MAY_ESCAPE"));
});
test("missing migration ledger is UNKNOWN, not a claim 0005 is unapplied",async()=>{
  const s=stub({hasLedger:false});
  const result=await readMetadata(s.fetchFn,env(),config());
  assert.equal(result.migrationLedgerPresent,false);
  assert.equal(result.applied0005,null);
  assert(!s.requests.some(r=>r.body&&JSON.parse(r.body).sql===SQL.migrations));
  assert(renderSummary(result).includes("Migration 0005 applied: null"));
});
test("positive metadata-only 0005 and four tables are detected without row SQL",async()=>{
  const s=stub({hasEclear:true,hasMigration:true});
  const result=await readMetadata(s.fetchFn,env(),config());
  assert.equal(result.applied0005,true);
  assert.equal(result.eclearTablePresence,"4/4");
  assert(result.tables.eclear_enrichment_jobs.present);
  assert(renderSummary(result).includes(MIGRATION_0005));
  assert(renderSummary(result).includes("CREATE TABLE eclear_enrichment_jobs"));
  assert(s.requests.length>10);
});
test("identity mismatch blocks all D1 POSTs",async()=>{
  const s=stub({wrongId:true});
  await assert.rejects(()=>readMetadata(s.fetchFn,env(),config()),/REMOTE_D1_UUID_NAME_MISMATCH/);
  assert(s.requests.every(r=>r.method==="GET"));
});
test("preflight rejects credentials and unapproved events before network",async()=>{
  for(const change of [
    {CLOUDFLARE_API_TOKEN:""},
    {CLOUDFLARE_ACCOUNT_ID:"x"},
    {GH_TOKEN:""},
    {GITHUB_REF:"refs/heads/main2"},
    {GITHUB_EVENT_NAME:"push"},
    {CONFIRMATION:"WRONG"}
  ]){
    const s=stub();
    await assert.rejects(()=>readMetadata(s.fetchFn,{...env(),...change},config()));
    assert.equal(s.requests.length,0);
  }
});
test("unexpected private-data columns or write metadata reject the response",async()=>{
  const s=stub({leak:true});
  await assert.rejects(()=>readMetadata(s.fetchFn,env(),config()),/UNEXPECTED_RESULT_COLUMN/);
  const w=stub({changedDb:true});
  await assert.rejects(()=>readMetadata(w.fetchFn,env(),config()),/QUERY_REPORTED_DB_CHANGE/);
  assert.throws(()=>sanitizeRows([{name:"x",password_hash:"private"}],"migrations"));
});
test("arbitrary SQL cannot be passed through queryOnly even with valid transport",async()=>{
  const s=stub();
  await assert.rejects(()=>queryOnly(s.fetchFn,env(),"DELETE FROM owners","schema"));
  await assert.rejects(()=>queryOnly(s.fetchFn,env(),SQL.migrations,"schema"));
  assert.equal(s.requests.length,0);
});
test("new workflow remains manual-only and secrets occur after exact-SHA guard",()=>{
  const workflow=readFileSync(".github/workflows/life-log-d1-schema-readonly-manual.yml","utf8");
  const eventSection=workflow.slice(workflow.indexOf("\non:\n"),workflow.indexOf("\npermissions:"));
  assert.match(eventSection,/\n  workflow_dispatch:\n/);
  assert.doesNotMatch(eventSection,/\n  (?:push|pull_request|workflow_run|schedule|repository_dispatch):/);
  assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow,/github\.repository == 'ha-rookie\/life-log'/);
  assert.match(workflow,/READ LIFELOG D1 SCHEMA ONLY/);
  const auth=workflow.indexOf("- name: Enforce manual event, current exact main SHA and fixed UAT D1");
  const remote=workflow.indexOf("- name: Inspect D1 schema metadata ONLY (separately approved dispatch)");
  assert(auth>0&&remote>auth);
  assert.doesNotMatch(workflow.slice(0,remote),/secrets\.CLOUDFLARE_/);
  assert.match(workflow,/scripts\/d1-schema-readonly\.mjs --remote/);
  assert.doesNotMatch(workflow,/(?:wrangler\s+d1|wrangler deploy|migrations apply|workflow_run:)/i);
  const ci=readFileSync(".github/workflows/life-log-ci.yml","utf8");
  assert(ci.includes("node --test scripts/d1-schema-readonly.check.mjs"));
});


const oneShotEnv=()=>({
  ...env(),GITHUB_EVENT_NAME:"workflow_run",
  ONE_SHOT_APPROVAL,WORKFLOW_RUN_EVENT:"push",WORKFLOW_RUN_CONCLUSION:"success",
  WORKFLOW_RUN_HEAD_BRANCH:"main",WORKFLOW_RUN_REPOSITORY:REPO,
  WORKFLOW_RUN_HEAD_SHA:SHA,WORKFLOW_RUN_HEAD_SUBJECT:ONE_SHOT_SUBJECT+"\n\nCloses #155"
});
test("one-shot only accepts exact approved main push CI, SHA and commit subject",()=>{
  assertOneShotContext(oneShotEnv());
  assertReadContext(oneShotEnv());
  assertReadContext(env());
  for(const change of [
    {GITHUB_EVENT_NAME:"push"},{GITHUB_REF:"refs/heads/feature"},
    {GITHUB_REPOSITORY:"evil/repo"},{ONE_SHOT_APPROVAL:""},
    {WORKFLOW_RUN_EVENT:"pull_request"},{WORKFLOW_RUN_CONCLUSION:"failure"},
    {WORKFLOW_RUN_HEAD_BRANCH:"dev"},{WORKFLOW_RUN_REPOSITORY:"other/repo"},
    {WORKFLOW_RUN_HEAD_SHA:"c".repeat(40)},{TARGET_SHA:"d".repeat(40)},
    {GITHUB_SHA:"e".repeat(40)},
    {WORKFLOW_RUN_HEAD_SUBJECT:"ci(d1): other action (#155)"}
  ])assert.throws(()=>assertReadContext({...oneShotEnv(),...change}));
});
test("one-shot synthetic remote metadata read requires no actual network",async()=>{
  const s=stub();
  const result=await readMetadata(s.fetchFn,oneShotEnv(),config());
  assert.equal(result.databaseId,DATABASE_ID);
  assert.equal(result.applied0005,false);
  assert(s.requests.slice(2).every(r=>assertAllowedSql(JSON.parse(r.body).sql)));
});
test("new one-shot workflow has only workflow_run and cannot trigger on PR or arbitrary main commits",()=>{
  const y=readFileSync(".github/workflows/life-log-d1-schema-readonly-once.yml","utf8");
  const trigger=y.slice(y.indexOf("\non:\n"),y.indexOf("\npermissions:"));
  assert.match(trigger,/\n  workflow_run:\n/);
  assert.match(trigger,/workflows: \["Life-log local app and D1 CI"\]/);
  assert.doesNotMatch(trigger,/\n  (?:push|pull_request|workflow_dispatch|schedule|repository_dispatch):/);
  assert(y.includes("github.event.workflow_run.event == 'push'"));
  assert(y.includes("github.event.workflow_run.conclusion == 'success'"));
  assert(y.includes("github.event.workflow_run.run_attempt == 1"));
  assert(y.includes("github.run_attempt == 1"));
  assert(y.includes("startsWith(github.event.workflow_run.head_commit.message"));
  assert(y.includes(ONE_SHOT_SUBJECT));
  assert(y.includes('test "$TARGET_SHA" = "$GITHUB_SHA"'));
  assert(y.includes('git diff-tree --no-commit-id --name-only -r HEAD'));
  assert(y.includes("expected-files.txt"));
  assert(y.includes('test "$(gh api'));
  assert(y.includes("validateLocalConfig"));
  const preflight=y.indexOf("- name: Verify exact approved squash commit");
  const remote=y.indexOf("- name: Read only D1 schema and migration ledger");
  assert(preflight>0&&remote>preflight);
  assert(!y.slice(0,remote).includes("secrets.CLOUDFLARE_"));
  assert(y.slice(remote).includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert(!/wrangler deploy|wrangler d1|migrations apply|UPDATE body_measurements|DELETE FROM/i.test(y));
  assert(y.includes("node scripts/d1-schema-readonly.mjs --remote"));
});
