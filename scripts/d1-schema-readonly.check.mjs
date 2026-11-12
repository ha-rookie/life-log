import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  DATABASE_ID,DATABASE_NAME,REPO,CONFIRMATION,MIGRATION_0005,TABLES,SQL,
  assertAllowedSql,assertManualContext,validateLocalConfig,sanitizeRows,
  readMetadata,queryOnly,renderSummary,assertOnceContext,
  ONCE_TITLE,ONCE_PARENT_SHA,ONCE_SOURCE_WORKFLOW
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

const onceEnv=()=>({
  ...env(),
  GITHUB_EVENT_NAME:"workflow_run",
  SOURCE_WORKFLOW:ONCE_SOURCE_WORKFLOW,
  SOURCE_EVENT:"push",SOURCE_BRANCH:"main",SOURCE_CONCLUSION:"success",
  SOURCE_RUN_ID:"123456789",SOURCE_RUN_ATTEMPT:"2",
  GITHUB_RUN_ATTEMPT:"1",
  SOURCE_SHA:SHA,
  ONCE_COMMIT_TITLE:ONCE_TITLE,
  ONCE_PARENT_SHA
});
test("authorized synthetic one-shot has exact main/DB and metadata-only SQL",async()=>{
  const e=onceEnv(),s=stub({hasEclear:true,hasMigration:true});
  assertOnceContext(e);
  const data=await readMetadata(s.fetchFn,e,config(),"once");
  assert.equal(data.readMode,"once");
  assert.equal(data.applied0005,true);
  assert.equal(data.eclearTablePresence,"4/4");
  assert(renderSummary(data).includes("one-shot CI-success-gated"));
  assert(s.requests.slice(2).every(r=>assertAllowedSql(JSON.parse(r.body).sql)));
});
test("any wrong event/branch/title/parent/SHA/re-run fails before Cloudflare",async()=>{
  const invalid=[
    {GITHUB_EVENT_NAME:"workflow_dispatch"},
    {GITHUB_REPOSITORY:"fake/life-log"},
    {GITHUB_REF:"refs/heads/something"},
    {SOURCE_WORKFLOW:"Other CI"},
    {SOURCE_EVENT:"pull_request"},
    {SOURCE_BRANCH:"feature"},
    {SOURCE_CONCLUSION:"failure"},
    {SOURCE_RUN_ID:""},
    {SOURCE_RUN_ATTEMPT:"0"},
    {SOURCE_SHA:"c".repeat(40)},
    {GITHUB_SHA:"c".repeat(40)},
    {TARGET_SHA:"short"},
    {GITHUB_RUN_ATTEMPT:"2"},
    {ONCE_COMMIT_TITLE:ONCE_TITLE+" extra"},
    {ONCE_PARENT_SHA:"c".repeat(40)}
  ];
  for(const bad of invalid){
    const s=stub(),altered={...onceEnv(),...bad};
    assert.throws(()=>assertOnceContext(altered));
    await assert.rejects(()=>readMetadata(s.fetchFn,altered,config(),"once"));
    assert.equal(s.requests.length,0,JSON.stringify(bad));
  }
});
test("manual mode is never implicitly authorized by one-shot context",async()=>{
  const s=stub();
  await assert.rejects(()=>readMetadata(s.fetchFn,onceEnv(),config()));
  await assert.rejects(()=>readMetadata(s.fetchFn,env(),config(),"once"));
  await assert.rejects(()=>readMetadata(s.fetchFn,env(),config(),"something-else"));
  assert.equal(s.requests.length,0);
});
test("one-shot workflow only follows successful main CI, rejects replay and scopes credentials",()=>{
  const workflow=readFileSync(".github/workflows/life-log-d1-schema-once.yml","utf8");
  const trigger=workflow.slice(workflow.indexOf("\non:\n"),workflow.indexOf("\npermissions:"));
  assert.match(trigger,/\n  workflow_run:\n/);
  assert.match(trigger,/workflows: \["Life-log local app and D1 CI"\]/);
  assert.match(trigger,/types: \[completed\]/);
  assert.match(trigger,/branches: \[main\]/);
  assert.doesNotMatch(trigger,/\n  (?:push|pull_request|workflow_dispatch|schedule|repository_dispatch):/);
  assert.match(workflow,/github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow,/github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow,/github\.run_attempt == 1/);
  assert(workflow.includes(ONCE_TITLE));
  assert(workflow.includes(ONCE_PARENT_SHA));
  assert.match(workflow,/git rev-parse HEAD\^/);
  assert.match(workflow,/git diff-tree --no-commit-id --name-only -r HEAD/);
  assert.match(workflow,/actions\/runs\/\$SOURCE_RUN_ID\/jobs/);
  assert.match(workflow,/prior.*gh api|prior="\$\(gh api/);
  assert.match(workflow,/test "\$prior" = 0/);
  assert(workflow.includes("validate")&&workflow.includes("chromium-e2e")&&
    workflow.includes("worker-browser-e2e"));
  const beforeRemote=workflow.slice(0,workflow.indexOf("- name: One-time Remote D1 metadata read"));
  assert(!beforeRemote.includes("secrets.CLOUDFLARE_"));
  assert(workflow.includes("node scripts/d1-schema-readonly.mjs --once"));
  assert.doesNotMatch(workflow,/wrangler d1|wrangler deploy|migrations apply|--remote\b/);
  const manual=readFileSync(".github/workflows/life-log-d1-schema-readonly-manual.yml","utf8");
  assert(manual.includes("  workflow_dispatch:"));
  assert(!manual.includes("  workflow_run:"));
  assert(manual.includes("node scripts/d1-schema-readonly.mjs --remote"));
});
