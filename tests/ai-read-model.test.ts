import { beforeAll,afterAll,beforeEach,describe,it,expect } from "vitest";
import { getPlatformProxy } from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import drinksMigration from "../migrations/0004_drink_details.sql?raw";
import { projectAiReadSnapshot, type AiReadDb } from "../src/worker/ai-read-model";

type Statement={bind(...args:unknown[]):Statement;run():Promise<unknown>;
  all<T>():Promise<{results:T[]}>;first<T>():Promise<T|null>};
type DB=AiReadDb&{prepare(sql:string):Statement};
const owner="owner",other="other",at="2026-01-15T01:00:00Z";
const generationId="synthetic-001";
const options=(from="2026-01-11",to="2026-01-14")=>
  ({from,to,generatedAtUtc:at,generationId});
const run=(db:DB,sql:string,...args:unknown[])=>
  db.prepare(sql).bind(...args).run();
const weight=(db:DB,id:string,when:string,kg:number|null,source:string,
  sourceKind="measured",anomaly=0,who=owner)=>
  run(db,"INSERT INTO body_measurements (id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind,anomaly_flag) "+
    "VALUES(?,?,?,?,?,?,?,?)",id,who,when,kg,source,id,sourceKind,anomaly);
const step=(db:DB,id:string,day:string,value:number|null,source:string,who=owner)=>
  run(db,"INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) "+
    "VALUES(?,?,?,?,?,?)",id,who,day,value,source,id);
const lifestyle=(db:DB,day:string,source:string,
  values:{drinking?:number|null;cups?:number|null;lunch?:string|null;dinner?:string|null;late?:number|null}={},
  who=owner)=>
  run(db,"INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,lunch_kind,dinner_kind,late_meal,source_id,source_row_key) "+
    "VALUES(?,?,?,?,?,?,?,?,?)",who,day,values.drinking??null,values.cups??null,values.lunch??null,
    values.dinner??null,values.late??null,source,"row:"+day+":"+source);
const drink=(db:DB,id:string,when:string,kind:string,alcohol:number,cups:number,
  source="manual:drink",volume:number|null=null,abv:number|null=null,
  variant:string|null=null,who=owner)=>
  run(db,"INSERT INTO drink_entries(id,owner_id,observed_at,drink_kind,alcohol,cups,volume_ml,abv_pct,source_id,source_row_key,drink_variant) "+
    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",id,who,when,kind,alcohol,cups,volume,abv,source,id,variant);

describe("AI B1 read-only canonical D1 projection (synthetic local D1)",()=>{
 let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:DB}>>>|undefined;
 let db:DB;
 beforeAll(async()=>{
   platform=await getPlatformProxy<{DB:DB}>({configPath:"wrangler.jsonc",remoteBindings:false,persist:false});
   db=platform.env.DB;
   for(const raw of [schema,drinksMigration]){
     const sql=raw.split("\n").filter(s=>!s.trimStart().startsWith("--")).join("\n");
     for(const query of sql.split(";").map(s=>s.trim()).filter(Boolean))
       await db.prepare(query).run();
   }
 },60000);
 afterAll(async()=>{await platform?.dispose();},60000);
 beforeEach(async()=>{
   for(const table of ["behavior_experiments","behavior_hypotheses","analysis_periods",
     "drink_entries","outings","activity_daily","body_measurements","lifestyle_days","import_jobs","owners"])
     await db.prepare("DELETE FROM "+table).run();
   await run(db,"INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01'),('other','2026-01-01')");
 });

 it("R01/R06: excludes legacy, reported and anomalies; keeps individual measurements and ECLEAR representative",async()=>{
   await weight(db,"m1","2026-01-12T09:00:00+09:00",70,"manual:weight");
   await weight(db,"ec1","2026-01-12T08:00:00+09:00",69,"eclear");
   await weight(db,"ec2","2026-01-12T10:00:00+09:00",68.9,"csv:eclear-batch");
   await weight(db,"legacy","2026-01-12T12:00:00+09:00",60,"csv:legacy");
   await weight(db,"reported","2026-01-13T08:00:00+09:00",70,"manual:weight","reported");
   await weight(db,"bad","2026-01-13T10:00:00+09:00",75,"eclear","measured",1);
   const a=await projectAiReadSnapshot(db,owner,options());
   expect(a.rows.Read_Weight.map(w=>w.weight_kg)).toEqual([69,70,68.9]);
   const ec=a.rows.Read_Weight.find(w=>w.weight_kg===68.9);
   expect(a.canonical_weight_keys["2026-01-12"]).toBe(ec?.record_key);
   expect(a.canonical_weight_keys["2026-01-13"]).toBeUndefined();
   expect(ec?.measured_at_jst).toContain("2026-01-12T10:00:00");
   expect(a.rows.Read_Weight.every(w=>w.measurement_kind==="measured")).toBe(true);
   expect(a.rows.Read_Weight.every(w=>!w.record_key.includes("owner"))).toBe(true);
 });

 it("R02: Fit zero is observed zero; manual fallback, no CSV lifestyle promotion",async()=>{
   await step(db,"manual-12","2026-01-12",600,"manual:steps");
   await step(db,"fit-12","2026-01-12",0,"fit");
   await step(db,"manual-13","2026-01-13",500,"manual:steps");
   await step(db,"legacy-14","2026-01-14",1800,"csv:oldsteps");
   await lifestyle(db,"2026-01-14","csv:legacy",{});
   const s=(await projectAiReadSnapshot(db,owner,options())).rows.Read_Steps;
   expect(s.map(z=>z.steps)).toEqual([null,0,500,null]);
   expect(s[1]).toMatchObject({source_type:"fit",value_state:"present",source_priority:0});
   expect(s[2].source_type).toBe("manual");
   expect(s[3].value_state).toBe("missing");
 });

 it("R03: distinguish abstinence, unrecorded, drink-entry evidence, conflicting no and nonalcohol only",async()=>{
   await lifestyle(db,"2026-01-12","manual:meals",{drinking:0,cups:0});
   await lifestyle(db,"2026-01-13","csv:legacy",{drinking:0,cups:0});
   await drink(db,"a1","2026-01-12T21:00:00+09:00","highball",1,2);
   await drink(db,"a2","2026-01-14T22:00:00+09:00","other_alcohol",1,1);
   await drink(db,"n1","2026-01-11T19:00:00+09:00","non_alcohol",0,1);
   const a=await projectAiReadSnapshot(db,owner,options());
   const days=a.rows.Read_DrinkDays;
   expect(days.map(d=>d.drinking_presence)).toEqual([null,null,0,1]);
   expect(days.map(d=>d.drink_cups)).toEqual([null,null,0,null]);
   expect(days[0].source_type).toBe("non_alcohol_only");
   expect(days[1].source_type).toBe("conflict");
   expect(days[2].drink_cups_value_state).toBe("present");
   expect(a.warnings).toContain("DRINK_DAY_CONFLICT:2026-01-12");
 });

 it("R03 extra: stated drinking with unknown cups does not become one cup or 0 grams",async()=>{
   await lifestyle(db,"2026-01-12","csv:legacy",{drinking:1,cups:null});
   const a=await projectAiReadSnapshot(db,owner,options());
   expect(a.rows.Read_DrinkDays[1]).toMatchObject({
     drinking_presence:1,drink_cups:null,drink_cups_value_state:"missing"
   });
   expect(a.rows.Read_Drinks).toHaveLength(0);
 });

 it("R04: merges distinct meal fields, preserving nullable dinner and explicit late-meal zero",async()=>{
   await lifestyle(db,"2026-01-12","manual:meals",{lunch:"home",late:0});
   await lifestyle(db,"2026-01-12","csv:meals",{dinner:"restaurant"});
   const a=await projectAiReadSnapshot(db,owner,options());
   const m=a.rows.Read_Meals[1];
   expect(m).toMatchObject({lunch_kind:"home",lunch_value_state:"present",
     dinner_kind:"restaurant",dinner_value_state:"present",late_meal:0,
     late_meal_value_state:"present",source_type:"mixed"});
   expect(a.rows.Read_Meals[0]).toMatchObject({lunch_kind:null,dinner_kind:null,
     late_meal:null,lunch_value_state:"missing",dinner_value_state:"missing"});
 });

 it("R05: JST second before/after midnight maps to different days, without synthetic midnight",async()=>{
   await weight(db,"last","2026-01-12T23:59:59+09:00",68,"eclear");
   await weight(db,"first","2026-01-13T00:00:00+09:00",67.9,"eclear");
   await drink(db,"edge","2026-01-12T23:59:59+09:00","highball",1,1);
   const a=await projectAiReadSnapshot(db,owner,options());
   expect(a.rows.Read_Weight.map(z=>z.local_day)).toEqual(["2026-01-12","2026-01-13"]);
   expect(a.rows.Read_Weight[1].measured_at_jst).toContain("T00:00:00");
   expect(a.rows.Read_Drinks[0].observed_at_jst).toContain("T23:59:59");
   expect(a.rows.Read_DrinkDays[1].drinking_presence).toBe(1);
 });

 it("R08: other owner with overlapping day/source stays private, no D1 writes",async()=>{
   await weight(db,"own1","2026-01-12T08:00:00+09:00",68,"eclear");
   await weight(db,"other1","2026-01-12T08:00:00+09:00",99,"eclear","measured",0,other);
   await step(db,"other-step","2026-01-13",8000,"fit",other);
   await lifestyle(db,"2026-01-14","manual:meals",{drinking:1,cups:5},other);
   await drink(db,"other-drink","2026-01-14T17:00:00+09:00","highball",1,2,
     "manual:drink",null,null,null,other);
   const before=await db.prepare("SELECT COUNT(*) AS n FROM body_measurements").first<{n:number}>();
   const a=await projectAiReadSnapshot(db,owner,options());
   const after=await db.prepare("SELECT COUNT(*) AS n FROM body_measurements").first<{n:number}>();
   expect(before?.n).toBe(after?.n);
   expect(a.rows.Read_Weight.map(z=>z.weight_kg)).toEqual([68]);
   expect(a.rows.Read_Steps.every(z=>z.steps===null)).toBe(true);
   expect(a.rows.Read_Drinks).toHaveLength(0);
   expect(a.rows.Read_DrinkDays[3].drinking_presence).toBeNull();
   expect(JSON.stringify(a)).not.toContain("other-drink");
   expect(JSON.stringify(a)).not.toContain("owner_id");
 });

 it("R09: entered grams, personal estimated grams, unknown and nonalcohol are distinct",async()=>{
   await drink(db,"entered","2026-01-12T20:00:00+09:00","highball",1,1,
     "manual:drink",250,5);
   await drink(db,"estimated","2026-01-12T21:00:00+09:00","highball",1,1);
   await drink(db,"unknown","2026-01-13T20:00:00+09:00","other_alcohol",1,1);
   await drink(db,"non","2026-01-13T21:00:00+09:00","non_alcohol",0,1);
   const d=(await projectAiReadSnapshot(db,owner,options())).rows.Read_Drinks;
   expect(d.map(z=>z.alcohol_value_kind)).toEqual(["entered","estimated","unknown","non_alcohol"]);
   expect(d.map(z=>z.pure_alcohol_g)).toEqual([10,10,null,0]);
   expect(d.every(z=>z.value_state==="present")).toBe(true);
 });

 it("R07: invalid/oversized/future windows and invalid owner fail closed before D1",async()=>{
   await expect(projectAiReadSnapshot(db,owner,options("2026-01-14","2026-01-11")))
     .rejects.toThrow("INVALID_SNAPSHOT_RANGE");
   await expect(projectAiReadSnapshot(db,owner,options("2024-01-01","2026-01-14")))
     .rejects.toThrow("INVALID_SNAPSHOT_RANGE");
   await expect(projectAiReadSnapshot(db,owner,options("2026-01-11","2026-01-20")))
     .rejects.toThrow("INVALID_SNAPSHOT_RANGE");
   await expect(projectAiReadSnapshot(db,"",options())).rejects.toThrow("INVALID_OWNER");
 });

 it("R07: source row overflow throws rather than silently truncates",async()=>{
   const overflowDb:AiReadDb={
     prepare:()=>{throw Error("SHOULD_USE_BATCH");},
     batch:async()=>Array.from({length:4},()=>({results:Array(10001).fill({})}))
   };
   await expect(projectAiReadSnapshot(overflowDb,owner,options()))
     .rejects.toThrow("TOO_MANY_SOURCE_ROWS");
 });

 it("R10: 30/90/366-day snapshot counts, metadata and stable digest (local estimates only)",async()=>{
   for(const n of [30,90,366]){
     const end=Date.parse("2026-01-14T00:00:00Z");
     const from=new Date(end-(n-1)*86400000).toISOString().slice(0,10);
     const opts=options(from,"2026-01-14");
     const start=performance.now();
     const a=await projectAiReadSnapshot(db,owner,opts);
     const elapsedMs=performance.now()-start;
     expect(a.counts.Read_Weight).toBe(0);
     expect(a.counts.Read_Steps).toBe(n);
     expect(a.counts.Read_Meals).toBe(n);
     expect(a.counts.Read_DrinkDays).toBe(n);
     expect(a.counts.Read_Drinks).toBe(0);
     expect(a.generation_digest).toMatch(/^[a-f0-9]{64}$/);
     expect((await projectAiReadSnapshot(db,owner,opts)).generation_digest)
       .toBe(a.generation_digest);
     expect(JSON.stringify(a).length).toBeGreaterThan(0);
     expect(elapsedMs).toBeGreaterThanOrEqual(0); // Not a Cloudflare Free CPU attestation.
   }
 });


 it("R11: all four owner-scoped SELECT statements execute in one atomic D1 batch",async()=>{
   let calls=0,statements=0;
   const wrapped:AiReadDb={
     prepare:(sql)=>{expect(sql.startsWith("SELECT ")).toBe(true);
       expect(sql).toContain("owner_id=?");return db.prepare(sql);},
     batch:async(reads)=>{calls++;statements=reads.length;return db.batch(reads);}
   };
   await projectAiReadSnapshot(wrapped,owner,options());
   expect(calls).toBe(1);
   expect(statements).toBe(4);
 });
 it("R11: failed/partial read batch never becomes a valid snapshot",async()=>{
   const invalid:AiReadDb={
     prepare:()=>db.prepare("SELECT 1"),
     batch:async()=>[{results:[]},{results:[]}]
   };
   await expect(projectAiReadSnapshot(invalid,owner,options()))
     .rejects.toThrow("INCOMPLETE_D1_READ_BATCH");
   const failed:AiReadDb={
     prepare:()=>db.prepare("SELECT 1"),
     batch:async()=>Array.from({length:4},(_,i)=>({results:[],success:i!==2}))
   };
   await expect(projectAiReadSnapshot(failed,owner,options()))
     .rejects.toThrow("INCOMPLETE_D1_READ_BATCH");
 });
 it("R12: manifest digest changes with canonical map and refresh timestamp",async()=>{
   await weight(db,"m12","2026-01-12T08:00:00+09:00",68.2,"manual:weight");
   const p=options(),before=await projectAiReadSnapshot(db,owner,p);
   const next=await projectAiReadSnapshot(db,owner,{
     ...p,generatedAtUtc:"2026-01-15T02:00:00Z"
   });
   expect(next.generation_digest).not.toBe(before.generation_digest);
   await weight(db,"e12","2026-01-12T07:00:00+09:00",68.2,"eclear");
   const after=await projectAiReadSnapshot(db,owner,p);
   expect(after.canonical_weight_keys["2026-01-12"])
     .not.toBe(before.canonical_weight_keys["2026-01-12"]);
   expect(after.generation_digest).not.toBe(before.generation_digest);
 });
 it("R13: provenance-only changes invalidate revisions even if output values match",async()=>{
   await step(db,"fitA","2026-01-12",1234,"fit");
   await lifestyle(db,"2026-01-12","csv:sourceA",{dinner:"home"});
   const before=await projectAiReadSnapshot(db,owner,options());
   await run(db,"UPDATE activity_daily SET source_id='google_fit' WHERE id='fitA'");
   await run(db,"UPDATE lifestyle_days SET source_id='csv:sourceB' WHERE local_day='2026-01-12'");
   const after=await projectAiReadSnapshot(db,owner,options());
   expect(after.rows.Read_Steps[1].steps).toBe(before.rows.Read_Steps[1].steps);
   expect(after.rows.Read_Steps[1].revision).not.toBe(before.rows.Read_Steps[1].revision);
   expect(after.rows.Read_Meals[1].dinner_kind).toBe(before.rows.Read_Meals[1].dinner_kind);
   expect(after.rows.Read_Meals[1].revision).not.toBe(before.rows.Read_Meals[1].revision);
 });

 it("Today's recorded weight is included but the day is not marked complete",async()=>{
   const s=await projectAiReadSnapshot(db,owner,{
     from:"2026-01-15",to:"2026-01-15",generatedAtUtc:"2026-01-15T01:00:00Z",
     generationId
   });
   expect(s.data_through_jst).toBeNull();
   expect(s.incomplete_day_jst).toBe("2026-01-15");
   expect(s.rows.Read_Steps[0].value_state).toBe("missing");
 });
});
