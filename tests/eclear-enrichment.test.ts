import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {getPlatformProxy} from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import {inspectOfficialEclearComposition,type EclearCompositionMeasurement} from "../src/shared/source-adapter";
import {previewEclearEnrichment} from "../src/worker/eclear-enrichment";
import type {ImportDb,Statement} from "../src/worker/import";

interface LocalStmt extends Statement {
  bind(...values:unknown[]):LocalStmt;
  run():Promise<unknown>;
  all<T>():Promise<{results:T[]}>;
}
interface LocalDb extends ImportDb {prepare(sql:string):LocalStmt;}
type Original={
  id:string;weight_kg:number|null;body_fat_pct:number|null;
  skeletal_muscle_pct:number|null;bmi:number|null;
  visceral_fat_level:number|null;bone_mass_kg:number|null;
  basal_metabolism_kcal:number|null;source_id:string;import_job_id:string|null;
};
const base=(time="07:40"):EclearCompositionMeasurement=>({
  measuredAt:"2026-01-02T"+time+":00+09:00",
  weightKg:75,bodyFatPct:25,skeletalMusclePct:36,
  bmi:23.5,visceralFatLevel:7,boneMassKg:3,basalMetabolismKcal:1700
});
describe("#124 Stage 2A: read-only ECLEAR enrichment classification on synthetic local D1",()=>{
  let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:LocalDb}>>>;
  let db:LocalDb;
  beforeAll(async()=>{
    platform=await getPlatformProxy<{DB:LocalDb}>({
      configPath:"wrangler.jsonc",remoteBindings:false,persist:false
    });
    db=platform.env.DB;
    const schema=schemaSql.split("\n").filter(x=>!x.trimStart().startsWith("--")).join("\n");
    for(const sql of schema.split(";").map(s=>s.trim()).filter(Boolean))
      await db.prepare(sql).run();
  },100_000);
  afterAll(async()=>{await platform?.dispose();},60_000);
  beforeEach(async()=>{
    await db.prepare("DELETE FROM body_measurements").run();
    await db.prepare("DELETE FROM owners").run();
    await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01'),('other','2026-01-01')").run();
  });
  async function put(m:EclearCompositionMeasurement,opts:{
    id?:string;owner?:string;source?:string;fats?:number|null;muscle?:number|null;
    bmi?:number|null;viscera?:number|null;bone?:number|null;metabolism?:number|null;
  }={}){
    const owner=opts.owner??"owner",id=opts.id??"eclear-1",source=opts.source??"csv:eclear";
    await db.prepare(
      "INSERT INTO body_measurements"+
      "(id,owner_id,measured_at,source_timezone,weight_kg,body_fat_pct,"+
      "skeletal_muscle_pct,bmi,visceral_fat_level,bone_mass_kg,basal_metabolism_kcal,"+
      "source_id,source_row_key,source_kind) VALUES(?,?,?,'Asia/Tokyo',?,?,?,?,?,?,?,?,?,'measured')"
    ).bind(id,owner,m.measuredAt,m.weightKg,
      opts.fats===undefined?m.bodyFatPct:opts.fats,
      opts.muscle===undefined?null:opts.muscle,
      opts.bmi===undefined?null:opts.bmi,
      opts.viscera===undefined?null:opts.viscera,
      opts.bone===undefined?null:opts.bone,
      opts.metabolism===undefined?null:opts.metabolism,source,id).run();
  }
  async function stored(id="eclear-1"){
    return db.prepare(
      "SELECT id,weight_kg,body_fat_pct,skeletal_muscle_pct,bmi,visceral_fat_level,"+
      "bone_mass_kg,basal_metabolism_kcal,source_id,import_job_id FROM body_measurements WHERE id=?"
    ).bind(id).first<Original>();
  }
  it("classifies one existing ECLEAR timestamp as five missing composition cells without changing weight/fat/id",async()=>{
    const m=base();
    await put(m);
    const before=await stored();
    const result=await previewEclearEnrichment(db,"owner",[m]);
    expect(result).toMatchObject({
      total:1,newMeasurements:0,enrichMeasurements:1,enrichCells:5,sameCells:2,
      conflictMeasurements:0,missingCells:0,unchangedMeasurements:0,
      classifications:[{line:2,status:"enrich",enrichFields:[
        "skeletalMusclePct","bmi","visceralFatLevel","boneMassKg","basalMetabolismKcal"
      ],conflictFields:[]}]
    });
    expect(await stored()).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("75");
    expect(JSON.stringify(result)).not.toContain("1700");
  },100_000);
  it("is idempotent for read-only preview: after synthetic NULL filling, next preview has zero eligible cells",async()=>{
    const m=base();
    await put(m);
    expect((await previewEclearEnrichment(db,"owner",[m])).enrichCells).toBe(5);
    // Simulates a future Stage 2B transaction, not a write by the preview function.
    await db.prepare(
      "UPDATE body_measurements SET skeletal_muscle_pct=?,bmi=?,"+
      "visceral_fat_level=?,bone_mass_kg=?,basal_metabolism_kcal=? WHERE id=?"
    ).bind(m.skeletalMusclePct,m.bmi,m.visceralFatLevel,m.boneMassKg,m.basalMetabolismKcal,"eclear-1").run();
    const second=await previewEclearEnrichment(db,"owner",[m]);
    expect(second).toMatchObject({enrichCells:0,enrichMeasurements:0,sameCells:7,unchangedMeasurements:1});
    expect((await db.prepare("SELECT COUNT(*) AS n FROM body_measurements").first<{n:number}>())?.n).toBe(1);
    expect((await stored())?.id).toBe("eclear-1");
  },100_000);
  it("does not replace old non-NULL values; conflicts block automatic partial filling",async()=>{
    const m=base();
    await put(m,{fats:27,muscle:30});
    const previous=await stored();
    const x=await previewEclearEnrichment(db,"owner",[m]);
    expect(x).toMatchObject({
      enrichMeasurements:0,enrichCells:0,conflictMeasurements:1,
      classifications:[{line:2,status:"conflict",conflictFields:["bodyFatPct","skeletalMusclePct"],
        enrichFields:["bmi","visceralFatLevel","boneMassKg","basalMetabolismKcal"]}]
    });
    expect(await stored()).toEqual(previous);
  },100_000);
  it("keeps explicit 0 different from NULL, and CSV blanks never erase saved values",async()=>{
    const m={...base(),bodyFatPct:0,skeletalMusclePct:0,bmi:null,visceralFatLevel:null,
      boneMassKg:null,basalMetabolismKcal:null};
    await put(m,{fats:0,muscle:null,bmi:22});
    const x=await previewEclearEnrichment(db,"owner",[m]);
    expect(x).toMatchObject({enrichCells:1,enrichMeasurements:1,sameCells:2,missingCells:4});
    expect(x.classifications[0].enrichFields).toEqual(["skeletalMusclePct"]);
    expect((await stored())?.bmi).toBe(22);
  },100_000);
  it("does not merge manual-only or unknown source at the same timestamp",async()=>{
    const m=base();await put(m,{source:"manual:weight"});
    const x=await previewEclearEnrichment(db,"owner",[m]);
    expect(x).toMatchObject({conflictMeasurements:1,newMeasurements:0,enrichCells:0});
    expect(x.classifications[0].status).toBe("conflict");
    expect((await stored())?.source_id).toBe("manual:weight");
  },100_000);
  it("uses a single canonical ECLEAR measurement without overwriting manual records at the same instant",async()=>{
    const m=base();await put(m,{id:"manual",source:"manual:weight"});await put(m,{id:"eclear",source:"csv:eclear"});
    const x=await previewEclearEnrichment(db,"owner",[m]);
    expect(x).toMatchObject({enrichMeasurements:1,enrichCells:5,conflictMeasurements:0});
    expect((await stored("manual"))?.source_id).toBe("manual:weight");
  },100_000);
  it("rejects two same-owner ECLEAR rows at identical timestamp rather than picking one",async()=>{
    const m=base();await put(m,{id:"eclear-a"});await put(m,{id:"eclear-b"});
    const x=await previewEclearEnrichment(db,"owner",[m]);
    expect(x).toMatchObject({conflictMeasurements:1,enrichCells:0});
  },100_000);
  it("keeps same-calendar-day morning/night as separate records and respects owner isolation",async()=>{
    const a=base(),b=base("21:40");
    await put(a,{owner:"other",id:"other-a"});
    await put(b,{owner:"owner",id:"owner-night"});
    const x=await previewEclearEnrichment(db,"owner",[a,b]);
    expect(x).toMatchObject({total:2,newMeasurements:1,enrichMeasurements:1,conflictMeasurements:0});
    expect(x.classifications.map(r=>r.status)).toEqual(["new","enrich"]);
  },100_000);
  it("accepts Stage 1 original ten-column CSV output and never creates new import jobs",async()=>{
    const original="年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ\n"+
      '2026/01/02,07:40,75,25,36,23.5,7,3,1700,"private, note"\n';
    const incoming=inspectOfficialEclearComposition(original);
    await put(incoming[0]);
    const x=await previewEclearEnrichment(db,"owner",incoming);
    expect(x.enrichCells).toBe(5);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM import_jobs").first<{n:number}>())?.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM import_row_audit").first<{n:number}>())?.n).toBe(0);
  },100_000);
  it("rejects duplicate timestamp, invalid values and >40 records before any database read",async()=>{
    const spy=vi.fn();
    const fake={prepare:spy};
    const m=base();
    await expect(previewEclearEnrichment(fake,"owner",[m,m])).rejects.toThrow("ECLEAR_ENRICHMENT_INPUT_INVALID");
    await expect(previewEclearEnrichment(fake,"owner",[{...m,measuredAt:"2026-02-30T07:40:00+09:00"}])).rejects.toThrow();
    await expect(previewEclearEnrichment(fake,"owner",[{...m,weightKg:0}])).rejects.toThrow();
    await expect(previewEclearEnrichment(fake,"owner",Array.from({length:41},(_,i)=>base(String(i).padStart(2,"0")+":40")))).rejects.toThrow();
    await expect(previewEclearEnrichment(fake,"", [m])).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it("uses only owner-scoped SELECT on a successful preview and leaves local D1 untouched",async()=>{
    const m=base();
    await put(m);
    const sqls:string[]=[];
    const readOnly={
      prepare:(query:string)=>{
        sqls.push(query);
        if(!/^\s*SELECT\b/i.test(query))throw Error("UNAUTHORIZED_WRITE");
        return db.prepare(query);
      }
    } as Pick<ImportDb,"prepare">;
    const before=await stored();
    const preview=await previewEclearEnrichment(readOnly,"owner",[m]);
    expect(preview).toMatchObject({enrichMeasurements:1,enrichCells:5,conflictMeasurements:0});
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("WHERE owner_id=? AND measured_at=?");
    expect(sqls[0]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
    expect(await stored()).toEqual(before);
  },100_000);
  it("fails closed on unavailable local D1 and never creates write statements",async()=>{
    const sql:string[]=[];
    const fake={
      prepare:(query:string)=>{
        sql.push(query);
        return {bind:()=>({all:async()=>{throw Error("D1_READ_FAILURE");}})};
      }
    } as unknown as Pick<ImportDb,"prepare">;
    await expect(previewEclearEnrichment(fake,"owner",[base()])).rejects.toThrow("D1_READ_FAILURE");
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^SELECT /);
    expect(sql[0]).toContain("owner_id=?");
    expect(sql[0]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  });
});
