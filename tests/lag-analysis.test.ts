import { describe,it,expect,beforeAll,afterAll,beforeEach } from "vitest";
import { getPlatformProxy } from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import drinksSchema from "../migrations/0004_drink_details.sql?raw";
import { buildLagEvidence } from "../src/shared/lag-analysis";
import { type MetricInput,type MetricBodyRow,type MetricStepRow,type MetricLifestyleRow,type MetricDrinkRow } from "../src/shared/analysis-metrics";
type MutableInput={bodies:MetricBodyRow[];steps:MetricStepRow[];lifestyles:MetricLifestyleRow[];drinks:MetricDrinkRow[]};
import { handleMvpFeatures } from "../src/worker/mvp-features";

const DAY=86400000;
const asOf="2026-11-15"; // Sunday; 2026-11-08 is the last safely completed Sunday
const date=(m:number)=>new Date(m).toISOString().slice(0,10);
const sunday=Date.parse("2026-11-08T00:00:00Z");
function syntheticWeeks(sign:-1|1= -1):MutableInput{
  const data:MutableInput={bodies:[],steps:[],lifestyles:[],drinks:[]};
  for(let week=0;week<12;week++){
    const finish=sunday-(11-week)*7*DAY;
    for(const back of [6,4,2,0]){
      const d=date(finish-back*DAY),at=d+"T08:00:00+09:00";
      data.bodies.push({
        id:"w-"+week+"-"+back,measured_at:at,source_id:"eclear",source_kind:"measured",
        anomaly_flag:0,weight_kg:75+sign*week,bmi:null,body_fat_pct:null,
        skeletal_muscle_pct:null,visceral_fat_level:null,bone_mass_kg:null,
        basal_metabolism_kcal:null
      });
    }
    for(let back=6;back>=0;back--){
      const d=date(finish-back*DAY);
      data.steps.push({local_day:d,steps:3000+week*100,source_id:"google_fit"});
      data.lifestyles.push({local_day:d,drinking_presence:0,source_id:"csv:lifestyle"});
    }
    data.drinks.push({observed_at:date(finish)+"T19:00:00+09:00",
      drink_kind:"other_alcohol",drink_variant:null,source_id:"manual:drink:tequila_shot",
      alcohol:1,cups:week+1,volume_ml:null,abv_pct:null});
  }
  return data;
}
describe("Issue #228 non-overlapping time-lag evidence",()=>{
 it("does not mistake unfinished current Sunday for completed, retains precise 1/2/4-week offsets",()=>{
   const data=buildLagEvidence(syntheticWeeks(),asOf);
   expect(data.window).toBe("12_completed_nonoverlapping_weeks");
   expect(data.weeks).toHaveLength(12);
   expect(data.weeks[11].to).toBe("2026-11-08");
   expect(data.weeks[0].weightObservedDays).toBe(4);
   expect(data.weeks[0].stepsObservedDays).toBe(7);
   expect(data.lags.map(x=>x.lagWeeks)).toEqual([1,2,4]);
   for(const lag of data.lags){
     expect(lag.stepHypothesis.pairedWeeks).toBeGreaterThanOrEqual(6);
     expect(lag.stepHypothesis.support).toBe(lag.stepHypothesis.pairedWeeks);
     expect(lag.stepHypothesis.verdict).toBe("supporting_observations");
     expect(lag.alcoholHypothesis.counter).toBe(lag.alcoholHypothesis.pairedWeeks);
     expect(lag.alcoholHypothesis.verdict).toBe("counter_observations");
     expect(lag.stepHypothesis.pairs.every(p=>p.outcomeTo>p.to)).toBe(true);
   }
   expect(data.disclaimer).toContain("因果");
 });
 it("opposite weight direction reverses exploratory evidence without treating it as causality",()=>{
   const result=buildLagEvidence(syntheticWeeks(1),asOf);
   expect(result.lags[0].stepHypothesis.verdict).toBe("counter_observations");
   expect(result.lags[0].alcoholHypothesis.verdict).toBe("supporting_observations");
 });
 it("sparse or anomalous body data is withheld, no invented sober days or zeros",()=>{
   const none=buildLagEvidence({bodies:[],steps:[],lifestyles:[],drinks:[]},asOf);
   expect(none.lags.every(l=>l.stepHypothesis.pairedWeeks===0&&
     l.alcoholHypothesis.verdict==="undetermined")).toBe(true);
   expect(none.weeks.every(w=>w.weightMeanKg===null&&w.stepsMean===null&&
     w.drinkingMissingDays===7)).toBe(true);
   const missing=syntheticWeeks();
   missing.bodies.splice(0,missing.bodies.length-3);
   expect(buildLagEvidence(missing,asOf).lags.every(l=>l.stepHypothesis.verdict==="undetermined")).toBe(true);
   expect(()=>buildLagEvidence(missing,"2026-02-30")).toThrow("LAG_DATE");
 });
});
type Stmt={bind(...a:unknown[]):Stmt;run():Promise<{meta?:{changes?:number}}>;
  first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>};
type DB={prepare(sql:string):Stmt};
const site="http://127.0.0.1:8787";
const jstNow=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
describe("Issue #228 synthetic local D1 GET-only Owner boundary",()=>{
 let proxy:Awaited<ReturnType<typeof getPlatformProxy<{DB:DB}>>>,db:DB;
 beforeAll(async()=>{
   proxy=await getPlatformProxy<{DB:DB}>({configPath:"wrangler.jsonc",remoteBindings:false,persist:false});
   db=proxy.env.DB;
   for(const src of [schema,drinksSchema]){
     const stripped=src.split("\n").filter(x=>!x.trimStart().startsWith("--")).join("\n");
     for(const query of stripped.split(";").map(s=>s.trim()).filter(Boolean))
       await db.prepare(query).run();
   }
 },60000);
 afterAll(async()=>{await proxy?.dispose();},60000);
 beforeEach(async()=>{
   for(const t of ["drink_entries","activity_daily","body_measurements","lifestyle_days","owners"])
     await db.prepare("DELETE FROM "+t).run();
   await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01'),('other','2026-01-01')").run();
 });
 it("filters to bound Owner, rejects unsupported methods, future and repeated query args",async()=>{
   const d=new Date(Date.now()+9*3600000-14*DAY).toISOString().slice(0,10);
   await db.prepare("INSERT INTO activity_daily "+
     "(id,owner_id,local_day,steps,source_id,source_row_key) VALUES(?,?,?,?,?,?)")
     .bind("s1","owner",d,0,"google_fit","one").run();
   await db.prepare("INSERT INTO activity_daily "+
     "(id,owner_id,local_day,steps,source_id,source_row_key) VALUES(?,?,?,?,?,?)")
     .bind("s2","other",d,90000,"google_fit","two").run();
   const count=await db.prepare("SELECT COUNT(*) AS n FROM activity_daily").first<{n:number}>();
   const req=(path:string,method="GET")=>new Request(site+path,{method});
   const res=await handleMvpFeatures(req("/api/mvp/lag"),db,"owner",{});
   expect(res.status).toBe(200);
   expect(res.headers.get("Cache-Control")).toBe("private, no-store");
   const data=await res.json() as ReturnType<typeof buildLagEvidence>;
   expect(data.weeks).toHaveLength(12);
   expect(JSON.stringify(data)).not.toContain("90000");
   expect((await db.prepare("SELECT COUNT(*) AS n FROM activity_daily").first<{n:number}>())?.n).toBe(count?.n);
   expect((await handleMvpFeatures(req("/api/mvp/lag","POST"),db,"owner",{})).status).toBe(405);
   expect((await handleMvpFeatures(req("/api/mvp/lag?asOf=2026-02-30"),db,"owner",{})).status).toBe(400);
   expect((await handleMvpFeatures(req("/api/mvp/lag?asOf="+jstNow()+"&asOf="+jstNow()),db,"owner",{})).status).toBe(400);
 });
});
