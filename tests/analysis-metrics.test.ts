import { beforeAll,afterAll,beforeEach,describe,it,expect } from "vitest";
import { getPlatformProxy } from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import drinkDetails from "../migrations/0004_drink_details.sql?raw";
import { buildAnalysisMetrics, type MetricBodyRow } from "../src/shared/analysis-metrics";
import { handleMvpFeatures } from "../src/worker/mvp-features";
type Stmt={bind(...a:unknown[]):Stmt;run():Promise<{meta?:{changes?:number}}>;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>};
type DB={prepare(sql:string):Stmt};
const site="http://127.0.0.1:8787";
const day=(n:number)=>new Date(Date.now()+9*3600000-n*86400000).toISOString().slice(0,10);
const time=(n:number)=>day(n)+"T08:00:00+09:00";
const empty={bodies:[],steps:[],lifestyles:[],drinks:[]};
const body=(id:string,at:string,source:string,weight:number|null,other:Partial<MetricBodyRow>={}):MetricBodyRow=>({
  id,measured_at:at,source_id:source,source_kind:"measured",anomaly_flag:0,
  weight_kg:weight,body_fat_pct:null,skeletal_muscle_pct:null,bmi:null,
  visceral_fat_level:null,bone_mass_kg:null,basal_metabolism_kcal:null,...other
});
const request=(path:string,method="GET")=>new Request(site+path,{method});

describe("Issue #229 observed-only derived metrics",()=>{
  it("ECLEAR/Fit beat manual on a day; 0 is observed, missing is not abstinence",()=>{
    const d=day(0);
    const result=buildAnalysisMetrics({
      ...empty,
      bodies:[
        body("manual",time(0),"manual:weight",72),
        body("eclear",time(0),"csv:eclear",76,{
          body_fat_pct:25,skeletal_muscle_pct:35,bmi:24,visceral_fat_level:7,
          bone_mass_kg:3,basal_metabolism_kcal:1650
        }),
        body("bad",time(1),"csv:eclear",60,{anomaly_flag:1})
      ],
      steps:[
        {local_day:d,steps:4000,source_id:"manual:steps"},
        {local_day:d,steps:0,source_id:"csv:fit"}
      ],
      lifestyles:[],drinks:[]
    },d);
    const week=result.windows[0];
    expect(week.weight).toMatchObject({observedDays:1,missingDays:6,meanKg:76,qualifiedMeanKg:null});
    expect(week.steps).toMatchObject({observedDays:1,missingDays:6,explicitZeroDays:1,mean:0});
    expect(week.composition.latest).toMatchObject({
      source:"csv:eclear",weight_kg:76,body_fat_pct:25,skeletal_muscle_pct:35,
      bmi:24,visceral_fat_level:7,bone_mass_kg:3,basal_metabolism_kcal:1650,
      estimatedFatMassKg:19,estimatedSkeletalMuscleKg:26.6,
      estimatedFatFreeMassKg:57,calculatedBmi:null,estimatedFmi:null
    });
    expect(week.composition.fieldObservedDays).toMatchObject({body_fat_pct:1,bone_mass_kg:1});
    expect(week.drinking).toMatchObject({observedDays:0,missingDays:7,
      drinkingDays:0,explicitNondrinkingDays:0,enteredG:0,estimatedG:0,unknownCups:0});
    expect(result.excluded.anomalyRows).toBe(1);
    expect(result.windows.map(x=>x.days)).toEqual([7,14,28]);
  });
  it("distinct 7-day observations qualify the average; estimates keep their provenance",()=>{
    const result=buildAnalysisMetrics({
      ...empty,
      bodies:[0,1,3,6].map(n=>body(String(n),time(n),"eclear",74+n)),
      steps:[{local_day:day(1),steps:5000,source_id:"google_fit"}],
      lifestyles:[{local_day:day(2),drinking_presence:0,source_id:"csv:lifestyle"}],
      drinks:[
        {observed_at:time(0),drink_kind:"other_alcohol",drink_variant:null,
          source_id:"manual:drink:tequila_shot",alcohol:1,cups:2,volume_ml:null,abv_pct:null},
        {observed_at:time(1),drink_kind:"highball",drink_variant:null,
          source_id:"manual:drink",alcohol:1,cups:1,volume_ml:250,abv_pct:5},
        {observed_at:time(1),drink_kind:"other_alcohol",drink_variant:null,
          source_id:"manual:drink",alcohol:1,cups:1,volume_ml:null,abv_pct:null}
      ]
    },day(0));
    const week=result.windows[0];
    expect(week.weight.observedDays).toBe(4);
    expect(week.weight.qualifiedMeanKg).not.toBeNull();
    expect(week.drinking).toMatchObject({
      observedDays:3,missingDays:4,drinkingDays:2,explicitNondrinkingDays:1,
      recordedAlcoholCups:4,enteredG:10,estimatedG:19.2,unknownCups:1
    });
    expect(week.drinking.assumptionVersion).toContain("personal-");
    expect(result.windows[2].weight.missingDays).toBe(24);
  });
  it("does not mix independent BIA fields from other source and rejects invalid dates",()=>{
    const v=buildAnalysisMetrics({...empty,bodies:[
      body("m",time(0),"manual:weight",70,{body_fat_pct:22}),
      body("e",time(0),"eclear",71,{body_fat_pct:null,skeletal_muscle_pct:35})
    ]},day(0));
    expect(v.windows[0].composition.latest).toMatchObject({
      weight_kg:71,body_fat_pct:null,estimatedFatMassKg:null,
      estimatedFatFreeMassKg:null,estimatedSkeletalMuscleKg:24.85
    });
    expect(()=>buildAnalysisMetrics(empty,"2026-02-30")).toThrow("METRICS_DATE");
  });
});
describe("Issue #229 Owner-scoped read-only API on ephemeral local D1",()=>{
  let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:DB}>>>,db:DB;
  beforeAll(async()=>{
    platform=await getPlatformProxy<{DB:DB}>({configPath:"wrangler.jsonc",remoteBindings:false,persist:false});
    db=platform.env.DB;
    for(const sql of [schema,drinkDetails]){
      const stripped=sql.split("\n").filter(s=>!s.trimStart().startsWith("--")).join("\n");
      for(const statement of stripped.split(";").map(s=>s.trim()).filter(Boolean))
        await db.prepare(statement).run();
    }
  },60000);
  afterAll(async()=>{await platform?.dispose();},60000);
  beforeEach(async()=>{
    for(const t of ["drink_entries","activity_daily","body_measurements","lifestyle_days","owners"])
      await db.prepare("DELETE FROM "+t).run();
    await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01'),('other','2026-01-01')").run();
  });
  it("requires GET, binds owner and never modifies records",async()=>{
    await db.prepare("INSERT INTO body_measurements "+
      "(id,owner_id,measured_at,weight_kg,body_fat_pct,source_id,source_row_key,source_kind) "+
      "VALUES(?,?,?,?,?,?,?,?)").bind("1","owner",time(0),76,25,"csv:eclear","1","measured").run();
    await db.prepare("INSERT INTO body_measurements "+
      "(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
      "VALUES(?,?,?,?,?,?,?)").bind("2","other",time(0),120,"csv:eclear","2","measured").run();
    await db.prepare("INSERT INTO activity_daily "+
      "(id,owner_id,local_day,steps,source_id,source_row_key) VALUES(?,?,?,?,?,?)")
      .bind("fit","owner",day(0),0,"csv:fit","fit").run();
    const before=await db.prepare("SELECT COUNT(*) AS n FROM body_measurements").first<{n:number}>();
    const res=await handleMvpFeatures(request("/api/mvp/metrics?asOf="+day(0)),db,"owner",{});
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const data=await res.json() as ReturnType<typeof buildAnalysisMetrics>;
    expect(data.windows[0].weight.meanKg).toBe(76);
    expect(data.windows[0].steps.explicitZeroDays).toBe(1);
    expect(data.windows[0].composition.latest?.estimatedFatMassKg).toBe(19);
    expect(JSON.stringify(data)).not.toContain("120");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM body_measurements").first<{n:number}>())?.n).toBe(before?.n);
    expect((await handleMvpFeatures(request("/api/mvp/metrics","POST"),db,"owner",{})).status).toBe(405);
    expect((await handleMvpFeatures(request("/api/mvp/metrics?asOf="+day(-1)),db,"owner",{})).status).toBe(400);
    expect((await handleMvpFeatures(request("/api/mvp/metrics?asOf="+day(0)+"&asOf="+day(1)),db,"owner",{})).status).toBe(400);
    expect((await handleMvpFeatures(request("/api/mvp/metrics?days=42"),db,"owner",{})).status).toBe(400);
  });
});
