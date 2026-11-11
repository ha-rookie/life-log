#!/usr/bin/env node
/**
 * D1 schema-only, opt-in inspection. No SQL is accepted from CLI, environment
 * inputs, GitHub Actions inputs, request bodies or callers.
 * Running this module in CI tests never makes a network request.
 */
import assert from "node:assert/strict";
import {appendFileSync,readFileSync} from "node:fs";

export const DATABASE_ID="421d0116-5c33-4782-a2b6-28f9684d3956";
export const DATABASE_NAME="life-log-dev";
export const UAT_NAME="life-log-uat";
export const REPO="ha-rookie/life-log";
export const CONFIRMATION="READ LIFELOG D1 SCHEMA ONLY";
export const MIGRATION_0005="0005_eclear_enrichment_audit.sql";
export const TABLES=Object.freeze([
  "d1_migrations","body_measurements",
  "eclear_enrichment_jobs","eclear_enrichment_row_audit",
  "eclear_enrichment_cell_audit","eclear_enrichment_asserts"
]);

const quoted=TABLES.map(t=>"'"+t+"'").join(",");
export const SQL=Object.freeze({
  schema:"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index') AND (name IN ("+quoted+") OR tbl_name IN ("+quoted+")) ORDER BY type,name LIMIT 80",
  migrations:"SELECT name,applied_at FROM d1_migrations ORDER BY id LIMIT 100",
  ...Object.fromEntries(TABLES.flatMap(table=>[
    ["columns:"+table,"PRAGMA table_info('"+table+"')"],
    ["indexes:"+table,"PRAGMA index_list('"+table+"')"],
    ["foreignKeys:"+table,"PRAGMA foreign_key_list('"+table+"')"]
  ]))
});
const SAFE_SQL=new Set(Object.values(SQL));
const KEYS=Object.freeze({
  schema:["type","name","tbl_name","sql"],
  migrations:["name","applied_at"],
  columns:["cid","name","type","notnull","dflt_value","pk"],
  indexes:["seq","name","unique","origin","partial"],
  foreignKeys:["id","seq","table","from","to","on_update","on_delete","match"]
});
const identifier=v=>typeof v==="string"&&/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(v);
const safeString=(v,max=160)=>typeof v==="string"&&v.length<=max&&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const isInteger=v=>Number.isSafeInteger(v)&&v>=0;
export function assertAllowedSql(sql){
  assert.equal(typeof sql,"string");
  assert(SAFE_SQL.has(sql),"SQL_NOT_IN_EXACT_READ_ONLY_ALLOWLIST");
  assert(!sql.includes(";"),"MULTI_STATEMENT_FORBIDDEN");
  assert(/^(SELECT |PRAGMA (?:table_info|index_list|foreign_key_list)\()/i.test(sql));
  return true;
}
export function validateLocalConfig(configText){
  const cfg=JSON.parse(configText.split(/\r?\n/).filter(x=>!x.trimStart().startsWith("//")).join("\n"));
  const check=(list)=>Array.isArray(list)&&list.length===1&&list[0].binding==="DB"&&
    list[0].database_id===DATABASE_ID&&list[0].database_name===DATABASE_NAME&&
    list[0].migrations_dir==="migrations"&&!list[0].migrations_table;
  assert(check(cfg.d1_databases),"ROOT_D1_BINDING_MISMATCH");
  assert.equal(cfg.env?.uat?.name,UAT_NAME,"UAT_WORKER_MISMATCH");
  assert(check(cfg.env?.uat?.d1_databases),"UAT_D1_BINDING_MISMATCH");
  return true;
}
export function assertManualContext(env){
  assert.equal(env.GITHUB_EVENT_NAME,"workflow_dispatch","MANUAL_EVENT_REQUIRED");
  assert.equal(env.GITHUB_REF,"refs/heads/main","MAIN_REF_REQUIRED");
  assert.equal(env.GITHUB_REPOSITORY,REPO,"EXACT_REPOSITORY_REQUIRED");
  assert.equal(env.CONFIRMATION,CONFIRMATION,"EXPLICIT_CONFIRMATION_REQUIRED");
  assert(/^[a-f0-9]{40}$/.test(env.TARGET_SHA??""),"EXACT_SHA_REQUIRED");
  assert.equal(env.GITHUB_SHA,env.TARGET_SHA,"DISPATCH_SHA_MISMATCH");
  return true;
}

const allowedRow=(row,kind)=>{
  assert(row&&typeof row==="object"&&!Array.isArray(row),"UNEXPECTED_RESULT_ROW");
  const permitted=KEYS[kind]??[];
  assert(Object.keys(row).every(key=>permitted.includes(key)),"UNEXPECTED_RESULT_COLUMN");
  if(kind==="schema"){
    assert(["table","index"].includes(row.type));
    assert(identifier(row.name)&&identifier(row.tbl_name));
    assert(TABLES.includes(row.name)||TABLES.includes(row.tbl_name),"OUT_OF_SCOPE_SCHEMA");
    assert(row.sql===null||safeString(row.sql,22000),"INVALID_DDL");
    if(row.sql!==null)assert(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX)\b/i.test(row.sql.trim()),"NON_DDL_SCHEMA");
  }else if(kind==="migrations"){
    assert(safeString(row.name)&&/^[a-zA-Z0-9_.\/-]{1,160}$/.test(row.name));
    assert(row.applied_at===null||
      safeString(row.applied_at,64)&&/^[0-9A-Za-z :+\-TZ.]{1,64}$/.test(row.applied_at));
  }else if(kind==="columns"){
    assert(isInteger(row.cid)&&identifier(row.name)&&safeString(row.type,120));
    assert([0,1].includes(row.notnull)&&isInteger(row.pk));
    assert(row.dflt_value===null||safeString(row.dflt_value,240));
  }else if(kind==="indexes"){
    assert(isInteger(row.seq)&&identifier(row.name)&&[0,1].includes(row.unique));
    assert(["c","u","pk"].includes(row.origin)&&[0,1].includes(row.partial));
  }else if(kind==="foreignKeys"){
    assert(isInteger(row.id)&&isInteger(row.seq)&&identifier(row.table)&&identifier(row.from));
    assert(row.to===null||identifier(row.to));
    for(const key of ["on_update","on_delete","match"])
      assert(safeString(row[key],24)&&/^[A-Z ]+$/.test(row[key]),"BAD_FOREIGN_KEY_POLICY");
  }
  return Object.fromEntries(permitted.filter(x=>Object.hasOwn(row,x)).map(x=>[x,row[x]]));
};
export function sanitizeRows(rows,kind){
  assert(Array.isArray(rows)&&rows.length<=100,"RESULT_SIZE_LIMIT");
  return rows.map(row=>allowedRow(row,kind));
}
async function callJson(fetchFn,url,opts){
  let response;
  try{response=await fetchFn(url,{...opts,signal:AbortSignal.timeout(20_000)});}
  catch{throw Error("REMOTE_TRANSPORT_FAILED");}
  if(!response.ok)throw Error("REMOTE_HTTP_ERROR");
  try{return await response.json();}
  catch{throw Error("REMOTE_JSON_INVALID");}
}
export async function checkGithubMainSha(fetchFn,env){
  const data=await callJson(fetchFn,
    "https://api.github.com/repos/"+REPO+"/git/ref/heads/main",{
      method:"GET",
      headers:{Authorization:"Bearer "+env.GH_TOKEN,Accept:"application/vnd.github+json"}
    });
  assert.equal(data.object?.sha,env.TARGET_SHA,"MAIN_SHA_CHANGED");
}
export async function checkDatabaseIdentity(fetchFn,env){
  const url="https://api.cloudflare.com/client/v4/accounts/"+
    env.CLOUDFLARE_ACCOUNT_ID+"/d1/database/"+DATABASE_ID;
  const data=await callJson(fetchFn,url,{
    method:"GET",headers:{Authorization:"Bearer "+env.CLOUDFLARE_API_TOKEN}
  });
  assert(data.success===true&&data.result?.uuid===DATABASE_ID&&
    data.result?.name===DATABASE_NAME,"REMOTE_D1_UUID_NAME_MISMATCH");
  return true;
}
export async function queryOnly(fetchFn,env,sql,id){
  assertAllowedSql(sql);
  assert.equal(SQL[id],sql,"UNREGISTERED_QUERY_ID");
  const data=await callJson(fetchFn,
    "https://api.cloudflare.com/client/v4/accounts/"+
      env.CLOUDFLARE_ACCOUNT_ID+"/d1/database/"+DATABASE_ID+"/query",{
      method:"POST",
      headers:{
        Authorization:"Bearer "+env.CLOUDFLARE_API_TOKEN,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({sql,params:[]})
    });
  const result=data.result;
  assert(data.success===true&&Array.isArray(result)&&result.length===1&&
    result[0].success===true,"READ_ONLY_QUERY_FAILED");
  const meta=result[0].meta??{};
  assert(meta.changes===undefined||meta.changes===0,"QUERY_REPORTED_WRITES");
  assert(meta.changed_db===undefined||meta.changed_db===false,"QUERY_REPORTED_DB_CHANGE");
  return sanitizeRows(result[0].results,id.split(":")[0]);
}
export async function readMetadata(fetchFn,env,configText){
  assertManualContext(env);
  validateLocalConfig(configText);
  assert(/^[0-9a-fA-F]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??""),"ACCOUNT_ID_INVALID");
  assert(typeof env.CLOUDFLARE_API_TOKEN==="string"&&env.CLOUDFLARE_API_TOKEN.length>=12,
    "CLOUDFLARE_READ_TOKEN_MISSING");
  assert(typeof env.GH_TOKEN==="string"&&env.GH_TOKEN.length>=12,"GITHUB_TOKEN_MISSING");
  // Exact live main ref is rechecked immediately before any Cloudflare API.
  await checkGithubMainSha(fetchFn,env);
  await checkDatabaseIdentity(fetchFn,env);
  const schema=await queryOnly(fetchFn,env,SQL.schema,"schema");
  const migrationTableExists=schema.some(r=>r.type==="table"&&r.name==="d1_migrations");
  const migrations=migrationTableExists?
    await queryOnly(fetchFn,env,SQL.migrations,"migrations"):[];
  assert(migrations.length<100,"MIGRATION_HISTORY_TRUNCATED");
  const tables={};
  for(const name of TABLES){
    const present=schema.some(r=>r.type==="table"&&r.name===name);
    const details={present,columns:[],indexes:[],foreignKeys:[]};
    if(present){
      details.columns=await queryOnly(fetchFn,env,SQL["columns:"+name],"columns:"+name);
      details.indexes=await queryOnly(fetchFn,env,SQL["indexes:"+name],"indexes:"+name);
      details.foreignKeys=await queryOnly(fetchFn,env,SQL["foreignKeys:"+name],"foreignKeys:"+name);
    }
    tables[name]=details;
  }
  // An absent migration ledger means UNKNOWN, never "not yet applied".
  const applied0005=migrationTableExists?
    migrations.some(m=>m.name===MIGRATION_0005):null;
  const eclearNames=TABLES.filter(n=>n.startsWith("eclear_enrichment_"));
  const eclearPresent=eclearNames.filter(name=>tables[name].present);
  return {
    mainSha:env.TARGET_SHA,databaseName:DATABASE_NAME,databaseId:DATABASE_ID,
    migrationLedgerPresent:migrationTableExists,migrations,applied0005,
    eclearTablePresence:eclearPresent.length+"/"+eclearNames.length,
    // DDL and constraints only, never a table's actual data rows.
    schema: schema.filter(r=>r.sql!==null),
    tables
  };
}
export function renderSummary(data){
  const lines=[
    "### Remote D1 metadata-only preflight",
    "- Read mode: manual, exact main SHA, fixed allowlist",
    "- Target: "+data.databaseName+" ("+data.databaseId+")",
    "- Approved main SHA: "+data.mainSha,
    "- Migration ledger present: "+String(data.migrationLedgerPresent),
    "- Migration 0005 applied: "+String(data.applied0005),
    "- ECLEAR tables found: "+data.eclearTablePresence,
    "",
    "#### Applied migrations (filenames and timestamps ONLY)",
    "| Filename | Applied at |","| --- | --- |"
  ];
  for(const m of data.migrations)lines.push("| "+m.name+" | "+(m.applied_at??"unknown")+" |");
  if(!data.migrations.length)lines.push("| (none or ledger missing) | - |");
  lines.push("","#### Allowed table / index DDL (schema text, no data rows)");
  for(const entry of data.schema){
    lines.push("**"+entry.type+": "+entry.name+"**");
    // Prefix every line with four spaces so SQL cannot escape Markdown code
    // blocks, execute commands or inject workflow-control syntax.
    lines.push(...entry.sql.replace(/\r/g,"").split("\n").map(x=>"    "+x));
  }
  for(const [name,details] of Object.entries(data.tables)){
    lines.push("","#### PRAGMA metadata: "+name,
      "- Present: "+String(details.present),
      "- Columns: "+JSON.stringify(details.columns),
      "- Indexes: "+JSON.stringify(details.indexes),
      "- Foreign keys: "+JSON.stringify(details.foreignKeys)
    );
  }
  lines.push("","No measurement/session/credential/audit data rows or values were queried.",
    "This is **not** authorization to apply Migration 0005.");
  return lines.join("\n")+"\n";
}
export async function runRemote(env=process.env,fetchFn=fetch){
  const config=readFileSync("wrangler.jsonc","utf8");
  const result=await readMetadata(fetchFn,env,config);
  if(env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY,renderSummary(result),{encoding:"utf8",flag:"a"});
  console.log("PASS D1 metadata only: migration 0005 present="+result.applied0005+
    "; ECLEAR tables="+result.eclearTablePresence+"; no row values emitted");
  return result;
}
if(process.argv[1]&&new URL("file://"+process.argv[1]).href===import.meta.url){
  if(process.argv.length!==3||process.argv[2]!=="--remote")
    throw Error("MANUAL_REMOTE_INVOCATION_ONLY; offline tests use node --test");
  try{await runRemote();}
  catch{console.error("D1_METADATA_INSPECTION_FAILED (reason intentionally redacted)");process.exitCode=1;}
}
