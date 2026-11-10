import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {getPlatformProxy} from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import migration from "../migrations/0005_eclear_enrichment_audit.sql?raw";
import {createHandler,type Env} from "../src/worker/index";
import {hash} from "../src/shared/csv-import";
import type {ImportDb,Statement} from "../src/worker/import";

interface LocalStmt extends Statement {
  bind(...values:unknown[]):LocalStmt;
  first<T>():Promise<T|null>;
  all<T>():Promise<{results:T[]}>;
  run():Promise<unknown>;
}
interface LocalDb extends ImportDb {prepare(sql:string):LocalStmt;}
const KEY="synthetic-local-only-review-key-never-deployed-00001";
const PREFIX="年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ\n";
const input=(rows:string[]=[ "2026/01/02,07:40,75,25,36,23.5,7,3,1700," ])=>
  PREFIX+rows.join("\n")+"\n";
const row=(time="07:40",weight=75,fat=25)=>
  "2026/01/02,"+time+","+weight+","+fat+",36,23.5,7,3,1700,";
const TIME="2026-01-02T07:40:00+09:00";
function req(mode:"preview"|"confirm",csv:string,token?:string,origin="http://localhost"){
  return new Request("http://localhost/api/eclear/enrichment/"+mode,{
    method:"POST",
    headers:{"Origin":origin,"Content-Type":"application/json",
      "Sec-Fetch-Site":"same-origin","X-Life-Log-Intent":"eclear-enrichment-v2"},
    body:JSON.stringify(token===undefined?{csv}:{csv,token})
  });
}
function env(db:LocalDb):Env{
  return {
    DB:db as unknown as Env["DB"],
    ASSETS:{fetch:async()=>new Response("private")},
    ECLEAR_ENRICHMENT_LOCAL_ONLY:"true",
    ECLEAR_ENRICHMENT_REVIEW_KEY:KEY
  } as Env;
}
const handler=createHandler(async()=>"owner");
async function migrate(db:LocalDb,sql:string){
  const stripped=sql.split("\n").filter(x=>!x.trimStart().startsWith("--")).join("\n");
  for(const part of stripped.split(";").map(x=>x.trim()).filter(Boolean))
    await db.prepare(part).run();
}
describe("#141 Stage 2B: synthetic local D1 transaction and owner gate",()=>{
  let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:LocalDb}>>>;
  let db:LocalDb;
  beforeAll(async()=>{
    platform=await getPlatformProxy<{DB:LocalDb}>({
      configPath:"wrangler.jsonc",remoteBindings:false,persist:false
    });
    db=platform.env.DB;
    await migrate(db,schema);
    await migrate(db,migration);
  },100_000);
  afterAll(async()=>{await platform?.dispose();},60_000);
  beforeEach(async()=>{
    for(const table of ["eclear_enrichment_cell_audit","eclear_enrichment_row_audit",
      "eclear_enrichment_jobs","eclear_enrichment_asserts","body_measurements",
      "import_row_audit","import_jobs","owners"])
      await db.prepare("DELETE FROM "+table).run();
    await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01'),('other','2026-01-01')").run();
  });
  async function put({id="existing",owner="owner",source="csv:eclear",at=TIME,
    fat=25,muscle=null,bmi=null,viscera=null,bone=null,metabolism=null}:{
    id?:string;owner?:string;source?:string;at?:string;
    fat?:number|null;muscle?:number|null;bmi?:number|null;viscera?:number|null;
    bone?:number|null;metabolism?:number|null
  }={}){
    await db.prepare(
      "INSERT INTO body_measurements("+
      "id,owner_id,measured_at,source_timezone,weight_kg,body_fat_pct,"+
      "skeletal_muscle_pct,bmi,visceral_fat_level,bone_mass_kg,basal_metabolism_kcal,"+
      "source_id,source_row_key,source_kind,reliable_fingerprint)"+
      " VALUES(?,?,?,'Asia/Tokyo',75,?,?,?,?,?,?,?,?,'measured',NULL)"
    ).bind(id,owner,at,fat,muscle,bmi,viscera,bone,metabolism,source,id).run();
  }
  const n=async(table:string)=>(
    await db.prepare("SELECT COUNT(*) AS n FROM "+table).first<{n:number}>()
  )?.n??-1;
  const get=async(id="existing")=>db.prepare(
    "SELECT id,weight_kg,body_fat_pct,skeletal_muscle_pct,bmi,"+
    "visceral_fat_level,bone_mass_kg,basal_metabolism_kcal,"+
    "import_job_id,reliable_fingerprint,source_id FROM body_measurements WHERE id=?"
  ).bind(id).first<Record<string,unknown>>();
  async function preview(csv=input(),workerEnv=env(db)){
    const res=await handler.fetch(req("preview",csv),workerEnv);
    expect(res.status).toBe(200);
    return res.json() as Promise<{reviewToken:string;enrichCells:number;newMeasurements:number;conflictMeasurements:number;missingCells:number}>;
  }
  async function confirm(csv:string,token:string,workerEnv=env(db)){
    const response=await handler.fetch(req("confirm",csv,token),workerEnv);
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  }
  it("fills only five NULL columns; preserves physical measurement, old identity and audit",async()=>{
    await put();
    const before=await get();
    const csv=input();
    const review=await preview(csv);
    expect(review.enrichCells).toBe(5);
    expect(await get()).toEqual(before);
    const result=await confirm(csv,review.reviewToken);
    expect(result).toMatchObject({status:200,body:{status:"applied",inserted:0,enriched:1,cells:5}});
    const after=await get();
    expect(after).toMatchObject({id:"existing",weight_kg:75,body_fat_pct:25,
      skeletal_muscle_pct:36,bmi:23.5,visceral_fat_level:7,bone_mass_kg:3,
      basal_metabolism_kcal:1700,import_job_id:null,reliable_fingerprint:null});
    expect(await n("body_measurements")).toBe(1);
    expect(await n("eclear_enrichment_jobs")).toBe(1);
    expect(await n("eclear_enrichment_row_audit")).toBe(1);
    expect(await n("eclear_enrichment_cell_audit")).toBe(5);
    expect(await n("eclear_enrichment_asserts")).toBe(0);
    expect(await n("import_jobs")).toBe(0);
    expect(await n("import_row_audit")).toBe(0);
    const replay=await preview(csv);
    expect(replay.enrichCells).toBe(0);
    expect(await confirm(csv,replay.reviewToken)).toMatchObject({status:200,body:{status:"unchanged",cells:0}});
    expect(await n("eclear_enrichment_jobs")).toBe(1);
  },100_000);
  it("creates one new exact timestamp with all present values, distinct from same-day morning",async()=>{
    await put({id:"morning",at:"2026-01-02T06:30:00+09:00"});
    const csv=input([row("07:40"),row("21:40")]);
    const rev=await preview(csv);
    expect(rev.newMeasurements).toBe(2);
    expect(await confirm(csv,rev.reviewToken)).toMatchObject({status:200,body:{inserted:2,enriched:0,cells:0}});
    expect(await n("body_measurements")).toBe(3);
    expect(await n("eclear_enrichment_row_audit")).toBe(2);
    expect(await n("eclear_enrichment_cell_audit")).toBe(14);
    const list=await db.prepare("SELECT measured_at,source_id,source_row_key,reliable_fingerprint,import_job_id FROM body_measurements WHERE id!='morning' ORDER BY measured_at").all<Record<string,unknown>>();
    expect(list.results.map(x=>x.measured_at)).toEqual([TIME,"2026-01-02T21:40:00+09:00"]);
    expect(list.results.every(x=>x.import_job_id===null&&x.source_id==="csv:eclear"&&
      typeof x.reliable_fingerprint==="string")).toBe(true);
    const expected=await hash(JSON.stringify(["eclear-v1",TIME,75,25]));
    expect(list.results[0].reliable_fingerprint).toBe(expected);
    const replay=await preview(csv);
    expect(await confirm(csv,replay.reviewToken)).toMatchObject({status:200,body:{status:"unchanged"}});
    expect(await n("body_measurements")).toBe(3);
  },100_000);
  it("never rewrites conflicting non-NULL values, and does not apply partial file",async()=>{
    await put({fat:27});
    const csv=input([row(),row("21:40")]);
    const before=await get();
    const rev=await preview(csv);
    expect(rev.conflictMeasurements).toBe(1);
    expect(await confirm(csv,rev.reviewToken)).toMatchObject({status:409,body:{error:"ECLEAR_CONFLICT"}});
    expect(await get()).toEqual(before);
    expect(await n("body_measurements")).toBe(1);
    expect(await n("eclear_enrichment_jobs")).toBe(0);
  },100_000);
  it("refuses ambiguous date-only/other source and does not merge it",async()=>{
    await put({source:"csv:weight_day",at:"2026-01-02"});
    const rev=await preview();
    expect(rev.conflictMeasurements).toBe(1);
    expect(await confirm(input(),rev.reviewToken)).toMatchObject({status:409});
    expect(await n("eclear_enrichment_jobs")).toBe(0);
    expect(await n("body_measurements")).toBe(1);
  },100_000);
  it("preserves literal zero and empty source values without inventing measurements",async()=>{
    await put({fat:0,muscle:null,bmi:24});
    const csv=input(["2026/01/02,07:40,75,0,0,,,,,"]);
    const rev=await preview(csv);
    expect(rev.enrichCells).toBe(1);
    expect(rev.missingCells).toBe(4);
    expect(await confirm(csv,rev.reviewToken)).toMatchObject({status:200,body:{cells:1}});
    expect(await get()).toMatchObject({body_fat_pct:0,skeletal_muscle_pct:0,bmi:24});
  },100_000);
  it("rejects stale reviewed snapshot and unsigned or tampered confirmation",async()=>{
    await put();
    const csv=input(),rev=await preview(csv);
    expect((await confirm(csv,rev.reviewToken.replace(/.$/,"0"))).status).toBe(409);
    await db.prepare("UPDATE body_measurements SET bmi=27 WHERE id='existing'").run();
    expect(await confirm(csv,rev.reviewToken)).toMatchObject({status:409,body:{error:"REVIEW_STALE"}});
    expect(await n("eclear_enrichment_jobs")).toBe(0);
    expect(await get()).toMatchObject({bmi:27,skeletal_muscle_pct:null});
  },100_000);
  it("rolls back all newly planned cells and jobs if independent audit already contains a cell",async()=>{
    await put();
    const csv=input(),first=await preview(csv);
    expect((await confirm(csv,first.reviewToken)).status).toBe(200);
    await db.prepare("UPDATE body_measurements SET skeletal_muscle_pct=NULL WHERE id='existing'").run();
    const state=await get();
    const p=await preview(csv);
    expect(p.enrichCells).toBe(1);
    expect((await confirm(csv,p.reviewToken)).status).toBe(409);
    expect(await get()).toEqual(state);
    expect(await n("eclear_enrichment_jobs")).toBe(1);
    expect(await n("eclear_enrichment_row_audit")).toBe(1);
    expect(await n("eclear_enrichment_cell_audit")).toBe(5);
    expect(await n("eclear_enrichment_asserts")).toBe(0);
  },100_000);
  it("never reads D1 for anonymous Owner or disabled local gate; rejects hostile Origin",async()=>{
    const fake=env(db);
    const anonymous=createHandler(async()=>null);
    const result=await anonymous.fetch(req("preview",input()),fake);
    expect(result.status).toBe(403);
    const unavailable={...fake,ECLEAR_ENRICHMENT_LOCAL_ONLY:undefined};
    expect((await handler.fetch(req("preview",input()),unavailable)).status).toBe(403);
    expect((await handler.fetch(req("confirm",input(),"x"),unavailable)).status).toBe(403);
    expect((await handler.fetch(req("preview",input(),undefined,"https://evil.example"),fake)).status).toBe(403);
    expect(await n("eclear_enrichment_jobs")).toBe(0);
  },100_000);
  it("does not expose personal values or stored IDs in preview JSON",async()=>{
    await put();
    const res=await handler.fetch(req("preview",input()),env(db));
    const serialized=await res.text();
    expect(res.status).toBe(200);
    expect(serialized).not.toContain("1700");
    expect(serialized).not.toContain("existing");
    expect(serialized).not.toContain("2026-01-02");
    expect(serialized).not.toContain('"weightKg":75');
  },100_000);
});
