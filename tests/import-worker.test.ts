import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import v3Sql from "../migrations/0006_csv_target_audit_v3.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { handleImport, type ImportDb, type Statement } from "../src/worker/import";
import { hash } from "../src/shared/csv-import";
import { normalizeOfficialCsv, originalUtf8Proof } from "../src/shared/source-adapter";

interface LocalStatement extends Statement {
  bind(...values: unknown[]): LocalStatement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}
interface LocalDb extends ImportDb { prepare(sql: string): LocalStatement; }
type Audit = { source_row_number:number;source_row_key:string;result:string;error_code:string|null };
type Reply = { status?:string;error?:string;inserted?:number;updated?:number;skipped?:number;conflicted?:number;
  reviewToken?:string;conflicts?:{day:string;fields:string[]}[];
  original?:{inserted:number;updated?:number;skipped:number;conflicted:number} };
const hdr = "local_day,drinking_presence,drink_cups,steps\n";
const life = hdr+"2026-01-02,1,,\n2026-01-03,0,0,0\n2026-01-04,,,\n";
const ec = "measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,72.2,22.5\n";
async function send(db:ImportDb,csv:string,opts:{
  source?:"lifestyle"|"lifestyle_weight"|"eclear"|"fit"|"weight_day";owner?:string;confirmed?:boolean;
  resolution?:{mode:"keep_existing";token:string}
}={}){
  const source=opts.source??"lifestyle",confirmed=opts.confirmed??true;
  const req=new Request("https://example.invalid/api/import/"+(confirmed?"confirm":"preview"),{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({source,csv,hash:await hash(csv),confirmed,
      ...(opts.resolution?{resolution:opts.resolution}:{})}),
  });
  const r=await handleImport(req,db,opts.owner??"owner");
  return {code:r.status,data:await r.json() as Reply};
}
const keep=(token:string)=>({mode:"keep_existing" as const,token});
async function count(db:LocalDb,t:"owners"|"lifestyle_days"|"body_measurements"|"import_jobs"|"import_row_audit"){
  return (await db.prepare("SELECT COUNT(*) AS n FROM "+t).first<{n:number}>())?.n;
}
async function audit(db:LocalDb,source:"eclear"|"lifestyle",csv:string,owner="owner"){
  const job=owner+":"+source+":"+await hash(csv);
  const r=await db.prepare("SELECT source_row_number,source_row_key,result,error_code FROM import_row_audit WHERE import_job_id=? ORDER BY source_row_number")
    .bind(job).all<Audit>();
  return r.results;
}
describe("CSV Worker signed-identity boundary",()=>{
  it("rejects unauthenticated owner and spoofed identity on preview/confirm before any DB call",async()=>{
    const dbSpy={prepare:vi.fn(),batch:vi.fn()};
    const env={DB:dbSpy,ASSETS:{fetch:vi.fn()}} as unknown as Env;
    for(const path of ["/api/import/preview","/api/import/confirm"]){
      const r=await createHandler(async()=>null).fetch(new Request("https://example.invalid"+path,{
        method:"POST",headers:{"Content-Type":"application/json","Cf-Access-Authenticated-User-Email":"owner@example.invalid"},
        body:JSON.stringify({resolution:keep("0".repeat(64))}),
      }),env);
      expect(r.status).toBe(403);
    }
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(dbSpy.batch).not.toHaveBeenCalled();
  });
});
describe("real ephemeral local D1 audited import",()=>{
  let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:LocalDb}>>>;
  let db:LocalDb;
  beforeAll(async()=>{
    platform=await getPlatformProxy<{DB:LocalDb}>({
      configPath:"wrangler.jsonc",remoteBindings:false,persist:false,
    });
    db=platform.env.DB;
    const schema=schemaSql.split("\n").filter((line:string)=>!line.trimStart().startsWith("--")).join("\n");
    for(const sql of schema.split(";").map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
    for(const sql of v3Sql.split("\n").filter(line=>!line.trimStart().startsWith("--"))
      .join("\n").split(";").map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  },100_000);
  afterAll(async()=>{await platform?.dispose();},60_000);
  beforeEach(async()=>{
    await db.batch(["DELETE FROM import_row_audit","DELETE FROM body_measurements",
      "DELETE FROM lifestyle_days","DELETE FROM activity_daily","DELETE FROM import_jobs","DELETE FROM owners"]
      .map(sql=>db.prepare(sql)));
    await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?)")
      .bind("owner","2026-01-01T00:00:00Z").run();
  });

  it("persists only the first verified original-byte SHA while canonical replay remains deduplicated",async()=>{
    const original="\uFEFF日付,飲酒,歩数\r\n2026/02/04,1,0\r\n2026/02/05,0,\r\n";
    const canonical=normalizeOfficialCsv("lifestyle",original).parts[0];
    const raw=await originalUtf8Proof(new TextEncoder().encode(original));
    const sendRaw=async(text:string)=>{
      const evidence=await originalUtf8Proof(new TextEncoder().encode(text));
      const res=await handleImport(new Request("https://example.invalid/api/import/confirm",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({source:"lifestyle",csv:canonical,hash:await hash(canonical),
          confirmed:true,...evidence})
      }),db,"owner");
      return {status:res.status,body:await res.json() as {inserted:number;
        originalByteEvidence:string}};
    };
    expect(await sendRaw(original)).toMatchObject({status:200,
      body:{inserted:2,originalByteEvidence:"recorded_first_import"}});
    const first=await db.prepare(
      "SELECT source_id,file_sha256 FROM import_jobs WHERE owner_id=? AND source_type=?"
    ).bind("owner","lifestyle").first<{source_id:string;file_sha256:string}>();
    expect(first).toEqual({source_id:"csv:audited-v2:lifestyle:raw-utf8-sha256:"+raw.originalSha256,
      file_sha256:await hash(canonical)});
    expect(await sendRaw(original)).toMatchObject({status:200,
      body:{inserted:0,originalByteEvidence:"matches_first_import"}});
    const different=original.replace("\uFEFF","").replaceAll("\r\n","\n");
    expect(normalizeOfficialCsv("lifestyle",different).parts[0]).toBe(canonical);
    expect(await sendRaw(different)).toMatchObject({status:200,
      body:{inserted:0,originalByteEvidence:"different_original_same_canonical"}});
    const again=await db.prepare("SELECT source_id FROM import_jobs WHERE owner_id='owner'")
      .first<{source_id:string}>();
    expect(again?.source_id).toBe(first?.source_id);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(2);
    expect(await count(db,"lifestyle_days")).toBe(2);
    expect(await count(db,"body_measurements")).toBe(0);
  },100_000);

  it("v3 schema migration contains additive DDL only and does not modify seeded measurement rows",async()=>{
    const statements=v3Sql.split("\n").filter(line=>!line.trimStart().startsWith("--"))
      .join("\n").split(";").map(x=>x.trim()).filter(Boolean);
    expect(statements).toHaveLength(3);
    expect(statements.every(sql=>/^CREATE (?:TABLE|INDEX) IF NOT EXISTS /i.test(sql))).toBe(true);
    await db.prepare(
      "INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind)"+
      " VALUES(?,?,?,?,?,?,'measured')"
    ).bind("prior","owner","2026-02-01T09:00:00+09:00",72.5,"csv:eclear","prior-row").run();
    const before=await db.prepare(
      "SELECT id,measured_at,weight_kg,source_id FROM body_measurements"
    ).all<{id:string;measured_at:string;weight_kg:number;source_id:string}>();
    for(const sql of statements)await db.prepare(sql).run();
    const after=await db.prepare(
      "SELECT id,measured_at,weight_kg,source_id FROM body_measurements"
    ).all<{id:string;measured_at:string;weight_kg:number;source_id:string}>();
    expect(after.results).toEqual(before.results);
  },100_000);
  it("v3: one source row writes two independently audited destinations atomically, other row just lifestyle",async()=>{
    const original="\uFEFF日付,飲酒,歩数,体重_kg\r\n2026/02/08,1,0,75.2\r\n"+
      "2026/02/09,0,,\r\n";
    const canonical=normalizeOfficialCsv("lifestyle_weight",original).parts[0];
    const proof=await originalUtf8Proof(new TextEncoder().encode(original));
    const req=new Request("https://example.invalid/api/import/confirm",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({source:"lifestyle_weight",csv:canonical,hash:await hash(canonical),
        confirmed:true,...proof})
    });
    const replayReq=req.clone();
    const confirmed=await handleImport(req,db,"owner");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({status:"confirmed",inserted:2,
      targetCounts:{inserted:3,skipped:0,conflicted:0},expectedTargets:3,
      originalByteEvidence:"recorded_first_import"});
    const manifest=await db.prepare(
      "SELECT expected_source_rows AS sourceRows, expected_target_rows AS targets FROM import_job_target_manifest"
    ).first<{sourceRows:number;targets:number}>();
    expect(manifest).toEqual({sourceRows:2,targets:3});
    const targets=await db.prepare(
      "SELECT source_row_number,target_type,result FROM import_target_audit ORDER BY source_row_number,target_type"
    ).all<{source_row_number:number;target_type:string;result:string}>();
    expect(targets.results.map(x=>[x.source_row_number,x.target_type,x.result])).toEqual([
      [2,"lifestyle","inserted"],[2,"weight_day","inserted"],[3,"lifestyle","inserted"]
    ]);
    const body=await db.prepare(
      "SELECT measured_at,source_kind,source_timezone,source_id,weight_kg FROM body_measurements WHERE owner_id='owner'"
    ).all<{measured_at:string;source_kind:string;source_timezone:string;source_id:string;weight_kg:number}>();
    expect(body.results).toEqual([{measured_at:"2026-02-08",source_kind:"reported",
      source_timezone:"Asia/Tokyo",source_id:"csv:lifestyle_weight",weight_kg:75.2}]);
    const lifestyle=await db.prepare(
      "SELECT local_day,drinking_presence,drink_cups,steps FROM lifestyle_days ORDER BY local_day"
    ).all<{local_day:string;drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(lifestyle.results).toEqual([
      {local_day:"2026-02-08",drinking_presence:1,drink_cups:null,steps:0},
      {local_day:"2026-02-09",drinking_presence:0,drink_cups:0,steps:null}
    ]);
    const replay=await handleImport(replayReq,db,"owner");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status:"already_imported",inserted:0,targetCounts:{inserted:3},
      originalByteEvidence:"matches_first_import"
    });
    expect(await count(db,"body_measurements")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(2);
    expect(await count(db,"import_jobs")).toBe(1);
  },100_000);
  it("v3: existing ECLEAR weight stays authoritative and the weight target is a genuine skip",async()=>{
    const ecSource="measured_at,weight_kg,body_fat_pct\n2026-03-02T07:23:00+09:00,72.3,22\n";
    expect((await send(db,ecSource,{source:"eclear"})).data.inserted).toBe(1);
    const csv="local_day,drinking_presence,drink_cups,steps,weight_kg\n2026-03-02,1,,0,99.9\n";
    const confirmed=await send(db,csv,{source:"lifestyle_weight"});
    expect(confirmed).toMatchObject({code:200,data:{inserted:1,conflicted:0,
      targetCounts:{inserted:1,skipped:1}}});
    const body=await db.prepare(
      "SELECT measured_at,source_id,weight_kg FROM body_measurements WHERE owner_id='owner'"
    ).all<{measured_at:string;source_id:string;weight_kg:number}>();
    expect(body.results).toEqual([{measured_at:"2026-03-02T07:23:00+09:00",
      source_id:"csv:eclear",weight_kg:72.3}]);
    const target=await db.prepare(
      "SELECT target_type,result FROM import_target_audit ORDER BY target_type"
    ).all<{target_type:string;result:string}>();
    expect(target.results).toEqual([
      {target_type:"lifestyle",result:"inserted"},{target_type:"weight_day",result:"skipped"}
    ]);
  },100_000);
  it("v3: conflict requires review and keep-existing also skips the conflicted row's weight",async()=>{
    const original="local_day,drinking_presence,drink_cups,steps\n2026-04-02,0,0,0\n";
    expect((await send(db,original)).code).toBe(200);
    const combined="local_day,drinking_presence,drink_cups,steps,weight_kg\n"+
      "2026-04-02,1,,0,75\n2026-04-03,0,0,0,74.5\n";
    const blocked=await send(db,combined,{source:"lifestyle_weight"});
    expect(blocked).toMatchObject({code:409,data:{error:"LIFESTYLE_CONFLICT"}});
    expect(await count(db,"body_measurements")).toBe(0);
    const confirmed=await send(db,combined,{source:"lifestyle_weight",
      resolution:keep(blocked.data.reviewToken!)});
    expect(confirmed).toMatchObject({code:200,data:{status:"partial",conflicted:1,
      inserted:1,targetCounts:{inserted:2,skipped:1,conflicted:1}}});
    const targets=await db.prepare("SELECT source_row_number,target_type,result FROM import_target_audit"+
      " ORDER BY source_row_number,target_type")
      .all<{source_row_number:number;target_type:string;result:string}>();
    expect(targets.results.map(x=>[x.source_row_number,x.target_type,x.result])).toEqual([
      [2,"lifestyle","conflict"],[2,"weight_day","skipped"],
      [3,"lifestyle","inserted"],[3,"weight_day","inserted"]
    ]);
    const body=await db.prepare("SELECT measured_at,weight_kg FROM body_measurements")
      .all<{measured_at:string;weight_kg:number}>();
    expect(body.results).toEqual([{measured_at:"2026-04-03",weight_kg:74.5}]);
  },100_000);
  it("v3: injected target-audit SQL failure rolls back all source/target/job rows",async()=>{
    const combined="local_day,drinking_presence,drink_cups,steps,weight_kg\n"+
      "2026-05-02,0,0,0,74.1\n";
    await db.prepare("CREATE TRIGGER v3_abort BEFORE INSERT ON import_target_audit "+
      "WHEN NEW.target_type='weight_day' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAIL'); END").run();
    const failed=await send(db,combined,{source:"lifestyle_weight"});
    expect(failed.code).toBe(503);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"lifestyle_days")).toBe(0);
    expect(await count(db,"body_measurements")).toBe(0);
    expect(await count(db,"import_row_audit")).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM import_target_audit")
      .first<{n:number}>())?.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM import_job_target_manifest")
      .first<{n:number}>())?.n).toBe(0);
    await db.prepare("DROP TRIGGER v3_abort").run();
    expect((await send(db,combined,{source:"lifestyle_weight"})).data).toMatchObject({
      inserted:1,targetCounts:{inserted:2}
    });
  },100_000);

  it("weight_day: inserts only missing calendar days and preserves actual ECLEAR time",async()=>{
    const original="measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,72.2,22.5\n";
    expect((await send(db,original,{source:"eclear"})).data.inserted).toBe(1);
    const historical="local_day,weight_kg\n2026-01-01,73.40\n2026-01-02,88.00\n2026-01-03,73.80\n";
    const first=await send(db,historical,{source:"weight_day"});
    expect(first).toMatchObject({code:200,data:{inserted:2,skipped:1,updated:0}});
    const rows=await db.prepare(
      "SELECT measured_at,weight_kg,source_kind,source_id FROM body_measurements WHERE owner_id='owner' ORDER BY measured_at"
    ).all<{measured_at:string;weight_kg:number;source_kind:string;source_id:string}>();
    expect(rows.results).toEqual([
      {measured_at:"2026-01-01",weight_kg:73.4,source_kind:"reported",source_id:"csv:weight_day"},
      {measured_at:"2026-01-02T07:00:00+09:00",weight_kg:72.2,
        source_kind:"measured",source_id:"csv:eclear"},
      {measured_at:"2026-01-03",weight_kg:73.8,source_kind:"reported",source_id:"csv:weight_day"}
    ]);
    expect(await send(db,historical,{source:"weight_day"})).toMatchObject({
      code:200,data:{status:"already_imported",inserted:0,skipped:3}
    });
    const overlap="local_day,weight_kg\n2026-01-02,89.00\n2026-01-03,99.00\n2026-01-04,74.20\n";
    expect(await send(db,overlap,{source:"weight_day"})).toMatchObject({
      code:200,data:{inserted:1,skipped:2}
    });
    const dateOnly=await db.prepare(
      "SELECT local_day,weight_kg FROM (SELECT substr(measured_at,1,10) AS local_day,weight_kg FROM body_measurements WHERE source_id='csv:weight_day') ORDER BY local_day"
    ).all<{local_day:string;weight_kg:number}>();
    expect(dateOnly.results).toEqual([
      {local_day:"2026-01-01",weight_kg:73.4},
      {local_day:"2026-01-03",weight_kg:73.8},
      {local_day:"2026-01-04",weight_kg:74.2}
    ]);
    const aud=await db.prepare(
      "SELECT result,COUNT(*) AS n FROM import_row_audit WHERE import_job_id=? GROUP BY result ORDER BY result"
    ).bind("owner:weight_day:"+await hash(historical)).all<{result:string;n:number}>();
    expect(aud.results).toEqual([{result:"inserted",n:2},{result:"skipped",n:1}]);
  },100_000);

  it("Fit: manual entry remains, overlapping CSV updates only canonical Fit rows and reports updated/skip/insert",async()=>{
    await db.prepare("INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) VALUES (?,?,?,?,?,?)")
      .bind("manual-steps","owner","2026-01-02",9100,"manual:steps","owner-step-1").run();
    const firstCsv="local_day,steps\n2026-01-02,4000\n2026-01-03,\n";
    const secondCsv="local_day,steps\n2026-01-02,4200\n2026-01-03,0\n2026-01-04,3800\n";
    const thirdCsv="local_day,steps\n2026-01-02,4200\n2026-01-05,2700\n";
    expect(await send(db,firstCsv,{source:"fit"})).toMatchObject({
      code:200,data:{inserted:2,updated:0,skipped:0}});
    expect(await send(db,secondCsv,{source:"fit"})).toMatchObject({
      code:200,data:{inserted:1,updated:2,skipped:0}});
    expect(await send(db,thirdCsv,{source:"fit"})).toMatchObject({
      code:200,data:{inserted:1,updated:0,skipped:1}});
    expect(await send(db,secondCsv,{source:"fit"})).toMatchObject({
      code:200,data:{status:"already_imported",inserted:0,updated:0,skipped:3}});
    // An older identical file is never allowed to revert a newer correction.
    expect(await send(db,firstCsv,{source:"fit"})).toMatchObject({
      code:200,data:{status:"already_imported",inserted:0,updated:0,skipped:2}});
    const rows=await db.prepare("SELECT local_day,steps,source_id,import_job_id FROM activity_daily WHERE owner_id=? ORDER BY local_day,source_id")
      .bind("owner").all<{local_day:string;steps:number|null;source_id:string;import_job_id:string|null}>();
    expect(rows.results.map(r=>[r.local_day,r.steps,r.source_id])).toEqual([
      ["2026-01-02",4200,"fit"],["2026-01-02",9100,"manual:steps"],
      ["2026-01-03",0,"fit"],["2026-01-04",3800,"fit"],["2026-01-05",2700,"fit"]
    ]);
    expect(rows.results[0].import_job_id).toBe("owner:fit:"+await hash(firstCsv));
    const audit=await db.prepare(
      "SELECT source_row_number,result,error_code FROM import_row_audit WHERE import_job_id=? ORDER BY source_row_number"
    ).bind("owner:fit:"+await hash(secondCsv)).all<{source_row_number:number;result:string;error_code:string|null}>();
    expect(audit.results.map(r=>[r.result,r.error_code])).toEqual([
      ["inserted","UPDATED"],["inserted","UPDATED"],["inserted",null]
    ]);
    const activityCount=await db.prepare("SELECT COUNT(*) AS n FROM activity_daily WHERE owner_id='owner'").first<{n:number}>();
    expect(activityCount?.n).toBe(5);
  },100_000);
  it("Fit: value corrected from explicit zero back to missing without becoming zero",async()=>{
    const a="local_day,steps\n2026-01-03,0\n",b="local_day,steps\n2026-01-03,\n";
    expect((await send(db,a,{source:"fit"})).data.inserted).toBe(1);
    expect((await send(db,b,{source:"fit"})).data.updated).toBe(1);
    const current=await db.prepare("SELECT steps FROM activity_daily WHERE owner_id='owner' AND source_id='fit'")
      .first<{steps:number|null}>();
    expect(current?.steps).toBeNull();
  },100_000);

  it("ECLEAR: same timestamp different weight/body fat replaces canonical value, leaving manual intact",async()=>{
    await db.prepare(
      "INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,body_fat_pct,source_id,source_row_key,source_kind) VALUES(?,?,?,?,?,?,?,'measured')"
    ).bind("manual-weight","owner","2026-01-02T07:00:00+09:00",90.1,null,"manual:weight","manual-key").run();
    const original="measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,72.2,22.5\n";
    const corrected="measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,73.1,22.7\n";
    const overlap="measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,73.1,22.7\n2026-01-02T21:00:00+09:00,72.9,22.4\n";
    expect(await send(db,original,{source:"eclear"})).toMatchObject({code:200,data:{inserted:1,updated:0,skipped:0}});
    expect(await send(db,corrected,{source:"eclear"})).toMatchObject({code:200,data:{inserted:0,updated:1,skipped:0}});
    expect(await send(db,overlap,{source:"eclear"})).toMatchObject({code:200,data:{inserted:1,updated:0,skipped:1}});
    expect(await send(db,corrected,{source:"eclear"})).toMatchObject({code:200,data:{status:"already_imported",updated:0,skipped:1}});
    const rows=await db.prepare("SELECT measured_at,weight_kg,body_fat_pct,source_id,import_job_id FROM body_measurements WHERE owner_id='owner' ORDER BY source_id,measured_at")
      .all<{measured_at:string;weight_kg:number;body_fat_pct:number|null;source_id:string;import_job_id:string|null}>();
    expect(rows.results.map(r=>[r.weight_kg,r.body_fat_pct,r.source_id])).toEqual([
      [73.1,22.7,"csv:eclear"],[72.9,22.4,"csv:eclear"],[90.1,null,"manual:weight"]
    ]);
    expect(rows.results[0].import_job_id).toBe("owner:eclear:"+await hash(original));
    const correction=await audit(db,"eclear",corrected);
    expect(correction.map(a=>[a.result,a.error_code])).toEqual([["inserted","UPDATED"]]);
  },100_000);

  it("imports Fit canonical steps, preserves missing versus zero and source-scoped retry",async()=>{
    const payload="local_day,steps\n2026-01-02,4000\n2026-01-03,0\n2026-01-04,\n";
    const first=await send(db,payload,{source:"fit"});
    expect(first).toMatchObject({code:200,data:{inserted:3,skipped:0,conflicted:0}});
    expect((await send(db,payload,{source:"fit"})).data.status).toBe("already_imported");
    const records=await db.prepare(
      "SELECT local_day,steps,source_id FROM activity_daily WHERE owner_id='owner' ORDER BY local_day"
    ).all<{local_day:string;steps:number|null;source_id:string}>();
    expect(records.results).toEqual([
      {local_day:"2026-01-02",steps:4000,source_id:"fit"},
      {local_day:"2026-01-03",steps:0,source_id:"fit"},
      {local_day:"2026-01-04",steps:null,source_id:"fit"},
    ]);
    const jobs=await db.prepare(
      "SELECT result,COUNT(*) AS n FROM import_row_audit WHERE import_job_id=? GROUP BY result"
    ).bind("owner:fit:"+await hash(payload)).all<{result:string;n:number}>();
    expect(jobs.results).toEqual([{result:"inserted",n:3}]);
  },100_000);

  it("previews without D1 mutation; confirms all rows with actual NULL and explicit zero plus audit",async()=>{
    expect((await send(db,life,{confirmed:false})).code).toBe(200);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"import_row_audit")).toBe(0);
    expect(await count(db,"lifestyle_days")).toBe(0);
    expect(await send(db,life)).toMatchObject({code:200,data:{
      status:"confirmed",inserted:3,skipped:0,conflicted:0,
    }});
    const rows=await db.prepare("SELECT local_day,drinking_presence,drink_cups,steps FROM lifestyle_days ORDER BY local_day")
      .all<{local_day:string;drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(rows.results).toEqual([
      {local_day:"2026-01-02",drinking_presence:1,drink_cups:null,steps:null},
      {local_day:"2026-01-03",drinking_presence:0,drink_cups:0,steps:0},
      {local_day:"2026-01-04",drinking_presence:null,drink_cups:null,steps:null},
    ]);
    const a=await audit(db,"lifestyle",life);
    expect(a.map(x=>[x.source_row_number,x.result,x.error_code])).toEqual([
      [2,"inserted",null],[3,"inserted",null],[4,"inserted",null],
    ]);
    expect(a.every(x=>x.source_row_key.length>60)).toBe(true);
  },100_000);

  it("same-file confirmed replay is idempotent; original audit is preserved unchanged",async()=>{
    expect((await send(db,life)).data.inserted).toBe(3);
    expect(await send(db,life)).toMatchObject({code:200,data:{
      status:"already_imported",inserted:0,skipped:3,
      original:{inserted:3,skipped:0,conflicted:0},
    }});
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(3);
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);

  it("identical lifestyle row from another file is skipped/audited, not double-counted",async()=>{
    const a=hdr+"2026-01-03,0,0,0\n",b=a+"2026-01-05,1,,2500\n";
    expect((await send(db,a)).data.inserted).toBe(1);
    expect(await send(db,b)).toMatchObject({code:200,data:{inserted:1,skipped:1,conflicted:0}});
    expect((await audit(db,"lifestyle",b)).map(x=>[x.result,x.error_code]))
      .toEqual([["skipped",null],["inserted",null]]);
    expect(await count(db,"lifestyle_days")).toBe(2);
  },100_000);

  it("a conflicting day blocks all writes until explicit keep-existing; partial job and all audits persist atomically",async()=>{
    const base=hdr+"2026-01-03,0,0,0\n";
    const candidate=hdr+"2026-01-03,1,,0\n2026-01-06,0,0,5000\n";
    expect((await send(db,base)).code).toBe(200);
    const blocked=await send(db,candidate);
    expect(blocked).toMatchObject({code:409,data:{error:"LIFESTYLE_CONFLICT",conflicts:[{
      day:"2026-01-03",fields:["drinking_presence","drink_cups"],
    }]}});
    expect(blocked.data.reviewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(1);
    const ok=await send(db,candidate,{resolution:keep(blocked.data.reviewToken!)});
    expect(ok).toMatchObject({code:200,data:{status:"partial",inserted:1,skipped:0,conflicted:1}});
    expect((await audit(db,"lifestyle",candidate)).map(x=>[x.result,x.error_code]))
      .toEqual([["conflict","LIFESTYLE_CONFLICT_KEPT"],["inserted",null]]);
    const saved=await db.prepare("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day=?")
      .bind("2026-01-03").first<{drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(saved).toEqual({drinking_presence:0,drink_cups:0,steps:0});
    expect(await count(db,"lifestyle_days")).toBe(2);
    expect(await send(db,candidate)).toMatchObject({code:200,data:{
      status:"already_imported",original:{inserted:1,skipped:0,conflicted:1},
    }});
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);

  it("NULL to zero produces three-field conflict, keeps original unknown values and audits a skip decision",async()=>{
    const base=hdr+"2026-01-04,,,\n",candidate=hdr+"2026-01-04,0,0,0\n";
    expect((await send(db,base)).code).toBe(200);
    const blocked=await send(db,candidate);
    expect(blocked.data.conflicts).toEqual([{
      day:"2026-01-04",fields:["drinking_presence","drink_cups","steps"],
    }]);
    const accepted=await send(db,candidate,{resolution:keep(blocked.data.reviewToken!)});
    expect(accepted).toMatchObject({code:200,data:{
      status:"partial",inserted:0,skipped:0,conflicted:1,
    }});
    const saved=await db.prepare("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day=?")
      .bind("2026-01-04").first<{drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(saved).toEqual({drinking_presence:null,drink_cups:null,steps:null});
    expect((await audit(db,"lifestyle",candidate))[0].result).toBe("conflict");
    expect(await count(db,"lifestyle_days")).toBe(1);
  },100_000);

  it("stale conflict decision requires fresh review and does not create an audit/job",async()=>{
    const base=hdr+"2026-01-03,0,0,0\n",candidate=hdr+"2026-01-03,1,,0\n";
    await send(db,base);
    const first=await send(db,candidate);
    await db.prepare("UPDATE lifestyle_days SET steps=9 WHERE owner_id=? AND local_day=?")
      .bind("owner","2026-01-03").run();
    const stale=await send(db,candidate,{resolution:keep(first.data.reviewToken!)});
    expect(stale).toMatchObject({code:409,data:{error:"REVIEW_STALE"}});
    expect(stale.data.reviewToken).not.toBe(first.data.reviewToken);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(1);
    const accepted=await send(db,candidate,{resolution:keep(stale.data.reviewToken!)});
    expect(accepted).toMatchObject({code:200,data:{status:"partial",conflicted:1}});
  },100_000);

  it("preflight-to-batch race is rejected inside real D1 transaction: no orphan job/audit",async()=>{
    const candidate=hdr+"2026-01-03,0,0,0\n2026-01-06,1,,6000\n";
    let injected=false;
    const raced:ImportDb={
      prepare:sql=>db.prepare(sql),
      batch:async ops=>{
        if(!injected){
          injected=true;
          await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key) VALUES (?,?,?,?,?,?,?)")
            .bind("owner","2026-01-03",1,null,null,"test-concurrent","race").run();
        }
        return db.batch(ops);
      },
    };
    expect(await send(raced,candidate)).toMatchObject({code:409,data:{error:"LIFESTYLE_CONFLICT"}});
    expect(injected).toBe(true);
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"import_row_audit")).toBe(0);
  },100_000);

  it("approved conflict cannot bypass a concurrent change before D1 batch",async()=>{
    const base=hdr+"2026-01-03,0,0,0\n",candidate=hdr+"2026-01-03,1,,0\n2026-01-06,1,,6000\n";
    await send(db,base);
    const review=await send(db,candidate);
    const raced:ImportDb={
      prepare:sql=>db.prepare(sql),
      batch:async ops=>{
        await db.prepare("UPDATE lifestyle_days SET steps=10 WHERE owner_id=? AND local_day=?")
          .bind("owner","2026-01-03").run();
        return db.batch(ops);
      },
    };
    expect(await send(raced,candidate,{resolution:keep(review.data.reviewToken!)}))
      .toMatchObject({code:409,data:{error:"REVIEW_STALE"}});
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(1);
  },100_000);

  it("mid-batch SQL error after an audit insert rolls back job/data/audit; retry succeeds",async()=>{
    let failedInside=false;
    const faultDb:ImportDb={
      prepare:sql=>db.prepare(sql),
      batch:ops=>{
        failedInside=true;
        const invalid=db.prepare(
          "INSERT INTO import_row_audit(id,import_job_id,source_row_number,source_row_key,result)"
          +" VALUES ('fault','missing-job',1,'fault','ILLEGAL')"
        );
        return db.batch([...ops.slice(0,4),invalid,...ops.slice(4)]);
      },
    };
    const res=await send(faultDb,life);
    expect(failedInside).toBe(true);
    expect(res.code).toBe(503);
    expect(await count(db,"lifestyle_days")).toBe(0);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"import_row_audit")).toBe(0);
    expect(await send(db,life)).toMatchObject({code:200,data:{status:"confirmed",inserted:3}});
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);

  it("ECLEAR cross-file identical fingerprint is skipped, new same-day reading is inserted and both audited",async()=>{
    const bigger=ec+"2026-01-02T20:00:00+09:00,72.8,23.1\n";
    expect(await send(db,ec,{source:"eclear"})).toMatchObject({code:200,data:{inserted:1}});
    expect(await send(db,bigger,{source:"eclear"})).toMatchObject({code:200,data:{
      inserted:1,skipped:1,conflicted:0,
    }});
    expect((await audit(db,"eclear",bigger)).map(x=>x.result)).toEqual(["skipped","inserted"]);
    expect(await count(db,"body_measurements")).toBe(2);
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);


  it("replays a confirmed pre-audit job with zero audit, preserving historical rows and reporting unavailable audit",async()=>{
    const csv=hdr+"2026-01-03,0,0,0\n2026-01-04,,,\n";
    const digest=await hash(csv),job="owner:lifestyle:"+digest;
    await db.prepare("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(job,"owner","lifestyle","csv:lifestyle",digest,"confirmed","2026-01-01Z","2026-01-01Z").run();
    for(const [line,day,presence,cups,steps] of [
      [2,"2026-01-03",0,0,0],
      [3,"2026-01-04",null,null,null],
    ] as const){
      await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id) VALUES (?,?,?,?,?,?,?,?)")
        .bind("owner",day,presence,cups,steps,"csv:lifestyle",digest+":"+line,job).run();
    }
    const first=await send(db,csv);
    const second=await send(db,csv);
    for(const result of [first,second]){
      expect(result).toMatchObject({code:200,data:{
        status:"already_imported",inserted:0,skipped:2,conflicted:0,
        auditStatus:"legacy_unavailable",original:null,
      }});
    }
    const stored=await db.prepare("SELECT source_id,drinking_presence,drink_cups,steps,import_job_id FROM lifestyle_days ORDER BY local_day")
      .all<{source_id:string;drinking_presence:number|null;drink_cups:number|null;steps:number|null;import_job_id:string}>();
    expect(stored.results).toEqual([
      {source_id:"csv:lifestyle",drinking_presence:0,drink_cups:0,steps:0,import_job_id:job},
      {source_id:"csv:lifestyle",drinking_presence:null,drink_cups:null,steps:null,import_job_id:job},
    ]);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(2);
    expect(await count(db,"import_row_audit")).toBe(0);
  },100_000);

  it("recognizes a pre-audit completed ECLEAR job with no row audits even if every row was skipped",async()=>{
    const csv=ec,digest=await hash(csv),job="owner:eclear:"+digest;
    await db.prepare("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(job,"owner","eclear","csv:eclear",digest,"confirmed","2026-01-01Z","2026-01-01Z").run();
    expect(await send(db,csv,{source:"eclear"})).toMatchObject({code:200,data:{
      status:"already_imported",auditStatus:"legacy_unavailable",original:null,
      inserted:0,skipped:1,
    }});
    expect(await count(db,"body_measurements")).toBe(0);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(0);
  },100_000);

  it("modern audited job missing ALL audit rows fails closed and never invents historical outcomes",async()=>{
    const csv=hdr+"2026-01-03,0,0,0\n";
    expect((await send(db,csv)).data.inserted).toBe(1);
    const job="owner:lifestyle:"+await hash(csv);
    const meta=await db.prepare("SELECT source_id FROM import_jobs WHERE id=?").bind(job).first<{source_id:string}>();
    expect(meta?.source_id).toBe("csv:audited-v2:lifestyle");
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=?").bind(job).run();
    const blocked=await send(db,csv);
    expect(blocked).toMatchObject({code:503,data:{error:"INCOMPLETE_AUDIT"}});
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(0);
  },100_000);

  it("partially missing audit is always an error; retry does not write or repair it",async()=>{
    expect((await send(db,life)).data.inserted).toBe(3);
    const job="owner:lifestyle:"+await hash(life);
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=? AND source_row_number=?")
      .bind(job,3).run();
    for(let i=0;i<2;i++){
      expect(await send(db,life)).toMatchObject({code:503,data:{error:"INCOMPLETE_AUDIT"}});
    }
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(3);
    expect(await count(db,"import_row_audit")).toBe(2);
  },100_000);

  it("pre-audit marker with a partly populated audit is not treated as a legacy zero-audit success",async()=>{
    const csv=hdr+"2026-01-03,0,0,0\n2026-01-04,,,\n";
    const digest=await hash(csv),job="owner:lifestyle:"+digest;
    await db.prepare("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(job,"owner","lifestyle","csv:lifestyle",digest,"confirmed","2026-01-01Z","2026-01-01Z").run();
    await db.prepare("INSERT INTO import_row_audit(id,import_job_id,source_row_number,source_row_key,result) VALUES (?,?,?,?,?)")
      .bind(job+":2",job,2,digest+":2","inserted").run();
    expect(await send(db,csv)).toMatchObject({code:503,data:{error:"INCOMPLETE_AUDIT"}});
    expect(await count(db,"import_row_audit")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(0);
  },100_000);

  it("legacy partial status with no audit must fail closed, not claim completed import",async()=>{
    const csv=hdr+"2026-01-03,0,0,0\n";
    const digest=await hash(csv),job="owner:lifestyle:"+digest;
    await db.prepare("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(job,"owner","lifestyle","csv:lifestyle",digest,"partial","2026-01-01Z","2026-01-01Z").run();
    expect(await send(db,csv)).toMatchObject({code:503,data:{error:"INCOMPLETE_AUDIT"}});
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(0);
  },100_000);

  it("owner-scoped rows: same day in another owner is not treated as a conflict",async()=>{
    await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?)")
      .bind("other","2026-01-01T00:00:00Z").run();
    const base=hdr+"2026-01-03,0,0,0\n",other=hdr+"2026-01-03,1,,\n";
    expect((await send(db,base)).code).toBe(200);
    expect(await send(db,other,{owner:"other"})).toMatchObject({code:200,data:{inserted:1}});
    const ownerRow=await db.prepare("SELECT drinking_presence FROM lifestyle_days WHERE owner_id=?")
      .bind("owner").first<{drinking_presence:number|null}>();
    const otherRow=await db.prepare("SELECT drinking_presence FROM lifestyle_days WHERE owner_id=?")
      .bind("other").first<{drinking_presence:number|null}>();
    expect([ownerRow?.drinking_presence,otherRow?.drinking_presence]).toEqual([0,1]);
    expect(await count(db,"import_row_audit")).toBe(2);
  },100_000);
});
