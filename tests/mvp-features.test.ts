import { beforeAll,afterAll,beforeEach,describe,it,expect } from "vitest";
import { getPlatformProxy } from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import drinksMigration from "../migrations/0004_drink_details.sql?raw";
import { handleMvpFeatures } from "../src/worker/mvp-features";
type Statement={bind(...args:unknown[]):Statement;run():Promise<{meta?:{changes?:number}}>;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>};
type DB={prepare(sql:string):Statement;batch(stmts:unknown[]):Promise<unknown[]>};
const site="http://127.0.0.1:8787";
const ms=86400000;
const day=(ago:number)=>new Date(Date.now()+9*3600000-ago*ms).toISOString().slice(0,10);
const time=(ago:number)=>day(ago)+"T08:00:00+09:00";
const one="00000000-0000-4000-8000-000000000015";
const two="00000000-0000-4000-8000-000000000016";
const env={local:"true"};
const call=async(db:DB,path:string,method="GET",data?:unknown,origin=site)=>{
 const headers:Record<string,string>={};
 if(method!=="GET"){
  headers["Origin"]=origin;
  headers["Sec-Fetch-Site"]="same-origin";
  headers["Content-Type"]="application/json";
 }
 if(data!==undefined)headers["X-Life-Log-Intent"]="manual-write-v1";
 const req=new Request(site+path,{method,headers,
  ...(data===undefined?{}:{body:JSON.stringify(data)})});
 return handleMvpFeatures(req,db,"owner",env);
};
describe("MVP: Owner drinks, periods, experiments and private CSV (local D1)",()=>{
 let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:DB}>>>,db:DB;
 beforeAll(async()=>{
  platform=await getPlatformProxy<{DB:DB}>({configPath:"wrangler.jsonc",remoteBindings:false,persist:false});
  db=platform.env.DB;
  const sql=schema.split("\n").filter(x=>!x.trimStart().startsWith("--")).join("\n");
  for(const statement of sql.split(";").map(x=>x.trim()).filter(Boolean))
   await db.prepare(statement).run();
  const drinkSql=drinksMigration.split("\n").filter(x=>!x.trimStart().startsWith("--")).join("\n");
  for(const statement of drinkSql.split(";").map(x=>x.trim()).filter(Boolean))
   await db.prepare(statement).run();
 },60000);
 afterAll(async()=>{await platform?.dispose();},60000);
 beforeEach(async()=>{
  for(const table of ["behavior_experiments","behavior_hypotheses","analysis_periods",
    "drink_entries","outings","activity_daily","body_measurements","lifestyle_days","import_jobs","owners"])
   await db.prepare("DELETE FROM "+table).run();
  await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01'),('other','2026-01-01')").run();
 });
 it("requires trusted local/remote write gate, valid Origin and method",async()=>{
  const data={key:one,kind:"highball",observedAt:new Date().toISOString()};
  const denied=await handleMvpFeatures(new Request(site+"/api/mvp/drinks",{
   method:"POST",headers:{"Origin":site,"Sec-Fetch-Site":"same-origin","Content-Type":"application/json"},
   body:JSON.stringify(data)}),db,"owner",{});
  expect(denied.status).toBe(403);
  expect((await call(db,"/api/mvp/drinks","POST",data,"https://evil.invalid")).status).toBe(403);
  expect((await call(db,"/api/mvp/experiments","DELETE",{id:one})).status).toBe(405);
  expect((await db.prepare("SELECT COUNT(*) n FROM drink_entries").first<{n:number}>())?.n).toBe(0);
 });
 it("records, retries, corrects and deletes alcoholic/nonalcoholic drinks without mixing cups",async()=>{
  const initial={key:one,kind:"highball",observedAt:new Date().toISOString()};
  const second={key:two,kind:"non_alcohol",observedAt:new Date().toISOString()};
  for(const payload of [initial,initial,second]){
   expect((await call(db,"/api/mvp/drinks","POST",payload)).status).toBe(200);
  }
  expect((await db.prepare("SELECT COUNT(*) n FROM drink_entries").first<{n:number}>())?.n).toBe(2);
  expect((await call(db,"/api/mvp/drinks","PATCH",{
   ...initial,kind:"green_tea_high",expectedKind:"highball",expectedObservedAt:initial.observedAt
  })).status).toBe(200);
  const listed=await call(db,"/api/mvp/drinks");
  expect(listed.status).toBe(200);
  const {entries}=await listed.json() as {entries:{kind:string;alcohol:number}[]};
  expect(entries).toHaveLength(2);
  expect(entries.filter(x=>x.alcohol===1)[0].kind).toBe("green_tea_high");
  expect(entries.filter(x=>x.alcohol===0)[0].kind).toBe("non_alcohol");
  expect((await call(db,"/api/mvp/drinks","DELETE",{
   key:one,expectedKind:"highball",expectedObservedAt:initial.observedAt
  })).status).toBe(409);
  expect((await call(db,"/api/mvp/drinks","DELETE",{
   key:one,expectedKind:"green_tea_high",expectedObservedAt:initial.observedAt
  })).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","DELETE",{
   key:two,expectedKind:"non_alcohol",expectedObservedAt:second.observedAt
  })).status).toBe(200);
  expect((await db.prepare("SELECT COUNT(*) n FROM drink_entries").first<{n:number}>())?.n).toBe(0);
 });
 it("saves mega beer separately from order count, retains source DB kind and exports grams",async()=>{
  const stamp=new Date().toISOString();
  const mega={key:one,kind:"beer",observedAt:stamp,cups:2,size:"mega",
    volumeMl:700,abvPct:5};
  expect((await call(db,"/api/mvp/drinks","POST",mega)).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","POST",mega)).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","POST",{...mega,cups:3})).status).toBe(409);
  const stored=await db.prepare(
    "SELECT drink_kind,drink_variant,size_label,cups,volume_ml,abv_pct FROM drink_entries WHERE owner_id='owner'"
  ).first<{drink_kind:string;drink_variant:string;size_label:string;cups:number;volume_ml:number;abv_pct:number}>();
  expect(stored).toMatchObject({
    drink_kind:"other_alcohol",drink_variant:"beer",size_label:"mega",
    cups:2,volume_ml:700,abv_pct:5
  });
  const listed=await call(db,"/api/mvp/drinks");
  expect((await listed.json() as {entries:any[]}).entries[0]).toMatchObject({
    kind:"beer",cups:2,size:"mega",volumeMl:700,abvPct:5
  });
  const period=await call(db,"/api/mvp/compare?"+
    new URLSearchParams({aFrom:day(2),aTo:day(1),bFrom:day(0),bTo:day(0)}));
  expect((await period.json() as {b:any}).b.drinking).toMatchObject({
    recordedAlcoholCups:2,knownAlcoholG:56,unknownAlcoholCups:0
  });
  const exported=await call(db,"/api/mvp/export?from="+day(0)+"&to="+day(0));
  expect(exported.status).toBe(200);
  const csv=await exported.text();
  expect(csv).toContain('"drink","'+stamp+'","2","ordered_cups","manual:drink","beer"');
  expect(csv).toContain('"drink_volume_per_cup","'+stamp+'","700","ml","manual:drink","beer"');
  expect(csv).toContain('"drink_pure_alcohol","'+stamp+'","56","g","manual:drink","beer"');
 });
 it("preserves legacy drinks as unknown size and ABV, validates updates and no-duplicate retries",async()=>{
  const time=new Date().toISOString();
  const legacy={key:one,kind:"highball",observedAt:time};
  expect((await call(db,"/api/mvp/drinks","POST",legacy)).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","POST",{key:two,kind:"non_alcohol",
    observedAt:time,cups:1,size:"regular",volumeMl:350,abvPct:null})).status).toBe(200);
  const entries=(await (await call(db,"/api/mvp/drinks")).json() as {entries:any[]}).entries;
  expect(entries.find(x=>x.key===one)).toMatchObject({
    kind:"highball",cups:1,size:null,volumeMl:null,abvPct:null
  });
  const period=await call(db,"/api/mvp/compare?"+
    new URLSearchParams({aFrom:day(2),aTo:day(1),bFrom:day(0),bTo:day(0)}));
  expect((await period.json() as {b:any}).b.drinking).toMatchObject({
    recordedAlcoholCups:1,knownAlcoholG:0,unknownAlcoholCups:1,
    recordedNonAlcoholCups:1
  });
  for(const payload of [
    {...legacy,cups:0},
    {...legacy,cups:51},
    {...legacy,cups:1.5},
    {...legacy,cups:1,size:"mega",volumeMl:700,abvPct:0},
    {...legacy,cups:1,size:"wrong",volumeMl:700,abvPct:7},
    {...legacy,cups:1,size:"mega",volumeMl:700,abvPct:101},
    {...legacy,cups:1,size:"mega",volumeMl:-1,abvPct:7},
    {...legacy,kind:"non_alcohol",cups:1,size:"regular",volumeMl:350,abvPct:5},
  ]) {
    expect((await call(db,"/api/mvp/drinks","POST",{...payload,key:crypto.randomUUID()})).status)
      .toBe(422);
  }
  const edited={...legacy,kind:"beer",cups:3,size:"large",volumeMl:500,abvPct:5,
    expectedKind:"highball",expectedObservedAt:time,
    expectedCups:1,expectedSize:null,expectedVolumeMl:null,expectedAbvPct:null};
  expect((await call(db,"/api/mvp/drinks","PATCH",edited)).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","PATCH",edited)).status).toBe(409);
  expect((await call(db,"/api/mvp/drinks","DELETE",{
    key:one,expectedKind:"highball",expectedObservedAt:time})).status).toBe(409);
  expect((await call(db,"/api/mvp/drinks","DELETE",{
    key:one,expectedKind:"beer",expectedObservedAt:time})).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","DELETE",{
    key:two,expectedKind:"non_alcohol",expectedObservedAt:time})).status).toBe(200);
 });
 it("compares weight, steps, drinking presence and coverage without fabricating 0",async()=>{
  for(const [d,kg] of [[28,78],[27,77.5],[10,76],[9,75]] as const)
   await db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
    "VALUES(?,?,?,?,?,?,?)").bind("w"+d,"owner",time(d),kg,"eclear","row"+d,"measured").run();
  for(const [d,steps] of [[28,0],[27,4000],[10,5000],[9,6000]] as const)
   await db.prepare("INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) "+
    "VALUES(?,?,?,?,?,?)").bind("s"+d,"owner",day(d),steps,"fit","row"+d).run();
  await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,lunch_kind,source_id,source_row_key) "+
   "VALUES(?,?,?,?,?,?,?)").bind("owner",day(28),1,null,"restaurant","csv","row28").run();
  await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,lunch_kind,source_id,source_row_key) "+
   "VALUES(?,?,?,?,?,?,?)").bind("owner",day(10),0,0,"home","csv","row10").run();
  const query="?aFrom="+day(29)+"&aTo="+day(15)+"&bFrom="+day(14)+"&bTo="+day(0);
  const res=await call(db,"/api/mvp/compare"+query);
  expect(res.status).toBe(200);
  const result=await res.json() as {a:any;b:any};
  expect(result.a.weight.deltaKg).toBe(-0.5);
  expect(result.b.weight.deltaKg).toBe(-1);
  expect(result.a.weight).toMatchObject({
    startDay:day(28),startKg:78,startMeasuredAt:time(28),startSource:"eclear",
    endDay:day(27),endKg:77.5,endMeasuredAt:time(27),endSource:"eclear",
    observedDays:2,missingDays:13
  });
  expect(result.a.weight.observedDays).toBe(2);
  expect(result.a.steps.zeroDays).toBe(1);
  expect(result.a.steps.observedDays).toBe(2);
  expect(result.a.drinking.drinkingDays).toBe(1);
  expect(result.a.drinking.missingDays).toBe(14);
  expect(result.b.drinking.nondrinkingDays).toBe(1);
  expect((await call(db,"/api/mvp/compare?"+new URLSearchParams({
   aFrom:day(10),aTo:day(1),bFrom:day(5),bTo:day(0)}))).status).toBe(400);
  // A different Owner's values never influence the comparison.
  await db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
   "VALUES(?,?,?,?,?,?,?)").bind("otherWeight","other",time(1),100,"eclear","external","measured").run();
  const again=await call(db,"/api/mvp/compare"+query);
  expect((await again.json() as {b:any}).b.weight.deltaKg).toBe(-1);
 });
 it("prefers Google Fit over conflicting lifestyle/manual steps and ECLEAR over conflicting weights",async()=>{
  const a=day(10),b=day(9),legacyOnly=day(8);
  const weight=async(id:string,date:string,kg:number,source:string,hour="08")=>
    db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
      "VALUES(?,?,?,?,?,?,?)").bind(id,"owner",date+"T"+hour+":00:00+09:00",kg,source,id,"measured").run();
  await weight("ec1",a,80,"csv:eclear");
  await weight("manual1",a,90,"manual:weight","23");
  await weight("ec2",b,79,"eclear");
  await weight("old2",b,93,"legacy:txt","22");
  await weight("old3",legacyOnly,95,"csv:lifestyle");
  const step=async(id:string,date:string,n:number,source:string)=>
    db.prepare("INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) VALUES(?,?,?,?,?,?)")
      .bind(id,"owner",date,n,source,id).run();
  await step("fit1",a,1000,"google_fit");
  await step("legacy1",a,9999,"csv:lifestyle");
  await step("manual1",a,3000,"manual:steps");
  await step("fit2",b,0,"fit");
  await step("legacy2",b,3333,"csv:lifestyle");
  await step("legacy3",legacyOnly,4444,"csv:lifestyle");
  const q=new URLSearchParams({aFrom:day(11),aTo:day(8),bFrom:day(7),bTo:day(5)});
  const res=await call(db,"/api/mvp/compare?"+q);
  expect(res.status).toBe(200);
  const result=await res.json() as {a:{
    weight:{startKg:number|null;endKg:number|null;deltaKg:number|null;observedDays:number};
    steps:{mean:number|null;observedDays:number;zeroDays:number;sources:string[]}
  }};
  expect(result.a.weight).toMatchObject({
    startKg:80,startDay:a,startMeasuredAt:a+"T08:00:00+09:00",startSource:"csv:eclear",
    endKg:79,endDay:b,endMeasuredAt:b+"T08:00:00+09:00",endSource:"eclear",
    deltaKg:-1,observedDays:2,missingDays:2
  });
  expect(result.a.steps).toMatchObject({mean:500,observedDays:2,zeroDays:1});
  expect(result.a.steps.sources).toEqual(["google_fit","fit"]);
 });
 it("keeps one-observation and empty comparison endpoints null without leaking another Owner",async()=>{
  await db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
    "VALUES(?,?,?,?,?,?,?)").bind("one-owner","owner",time(3),75,"manual:weight","single","measured").run();
  await db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
    "VALUES(?,?,?,?,?,?,?)").bind("another-owner","other",time(0),100,"eclear","other","measured").run();
  const q=new URLSearchParams({aFrom:day(3),aTo:day(2),bFrom:day(1),bTo:day(0)});
  const response=await call(db,"/api/mvp/compare?"+q);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const result=await response.json() as {a:{weight:any};b:{weight:any}};
  expect(result.a.weight).toMatchObject({
    startDay:day(3),startKg:75,startMeasuredAt:time(3),startSource:"manual:weight",
    endDay:day(3),endKg:75,endMeasuredAt:time(3),endSource:"manual:weight",
    observedDays:1,missingDays:1,deltaKg:null
  });
  expect(result.b.weight).toMatchObject({
    startDay:null,startKg:null,startMeasuredAt:null,startSource:null,
    endDay:null,endKg:null,endMeasuredAt:null,endSource:null,
    observedDays:0,missingDays:2,deltaKg:null
  });
 });
 it("persists one active hypothesis and records explicit user decision",async()=>{
  const plan={id:one,statement:"Evening walks change my steps",supportText:"some observations",
   counterText:"missing weight",unknownText:"alcohol/food",targetAction:"Walk after dinner",
   startsOn:day(0),endsOn:day(-14)};
  expect((await call(db,"/api/mvp/experiments","POST",plan)).status).toBe(200);
  expect((await call(db,"/api/mvp/experiments","POST",plan)).status).toBe(200);
  expect((await call(db,"/api/mvp/experiments","POST",{...plan,id:two})).status).toBe(409);
  const rows=await call(db,"/api/mvp/experiments");
  expect(rows.status).toBe(200);
  const result=await rows.json() as {experiments:{id:string;decision:null|string}[]};
  expect(result.experiments).toHaveLength(1);
  expect(result.experiments[0].decision).toBeNull();
  expect((await call(db,"/api/mvp/experiments","PATCH",{
   id:one,decision:"unknown",outcomeText:"Data coverage too low"
  })).status).toBe(200);
  expect((await call(db,"/api/mvp/experiments","PATCH",{
   id:one,decision:"stop",outcomeText:"retry"
  })).status).toBe(409);
 });
 it("exports Owner-only CSV, preserving NULL separately from 0 and escaping formulas",async()=>{
  await db.prepare("INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) "+
   "VALUES(?,?,?,?,?,?)").bind("s0","owner",day(0),0,"manual:steps","today").run();
  await db.prepare("INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) "+
   "VALUES(?,?,?,?,?,?)").bind("s1","other",day(0),99999,"manual:steps","other").run();
  await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,lunch_kind,source_id,source_row_key) "+
   "VALUES(?,?,?,?,?,?,?)").bind("owner",day(0),null,null,null,'=SHEET("bad")',"safe").run();
  const response=await call(db,"/api/mvp/export?from="+day(1)+"&to="+day(0));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Content-Type")).toContain("text/csv");
  const csv=await response.text();
  expect(csv).toContain('"steps","'+day(0)+'","0"');
  expect(csv).toContain('"\u0027=SHEET(""bad"")"');
  expect(csv).toContain('"drinking_presence","'+day(0)+'","",""');
  expect(csv).not.toContain("99999");
 });
 it("safely writes, corrects and removes Owner meals while preserving separate CSV drinking observations",async()=>{
  const d=day(0);
  await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,source_id,source_row_key) "+
   "VALUES(?,?,?,?,?,?)").bind("owner",d,1,null,"csv","from-csv").run();
  const base={day:d,lunchKind:"restaurant",dinnerKind:null,lateMeal:0 as const};
  const corrected={day:d,lunchKind:"restaurant",dinnerKind:"takeout",lateMeal:1 as const};
  expect((await call(db,"/api/mvp/meals","PUT",{...base,expected:null})).status).toBe(200);
  expect((await call(db,"/api/mvp/meals","PUT",{...corrected,expected:base})).status).toBe(200);
  expect((await call(db,"/api/mvp/meals","PUT",{...base,expected:base})).status).toBe(409);
  const meals=await call(db,"/api/mvp/meals");
  expect(meals.status).toBe(200);
  const list=await meals.json() as {entries:({day:string;lunchKind:string;dinnerKind:string;lateMeal:number})[]};
  expect(list.entries.find(x=>x.day===d)).toMatchObject(corrected);
  const cmp=await call(db,"/api/mvp/compare?"+
    new URLSearchParams({aFrom:day(2),aTo:day(1),bFrom:d,bTo:d}));
  expect(cmp.status).toBe(200);
  const result=await cmp.json() as {b:{drinking:{drinkingDays:number};meals:{restaurantLunchDays:number;lateMealDays:number}}};
  expect(result.b.drinking.drinkingDays).toBe(1); // manual meal must NOT hide CSV alcohol observation
  expect(result.b.meals.restaurantLunchDays).toBe(1);
  expect(result.b.meals.lateMealDays).toBe(1);
  expect((await call(db,"/api/mvp/meals","DELETE",{day:d,expected:base})).status).toBe(409);
  expect((await call(db,"/api/mvp/meals","DELETE",{day:d,expected:corrected})).status).toBe(200);
  expect((await db.prepare("SELECT COUNT(*) n FROM lifestyle_days WHERE owner_id='owner' AND source_id='csv'").first<{n:number}>())?.n).toBe(1);
  expect((await db.prepare("SELECT COUNT(*) n FROM lifestyle_days WHERE owner_id='owner' AND source_id='manual:meals'").first<{n:number}>())?.n).toBe(0);
 });
 it("records outing participation separately from drink cups, with idempotence and source-scoped cancellation",async()=>{
  const d=day(0);
  const initial={key:one,day:d,category:"bar"};
  expect((await call(db,"/api/mvp/outings","POST",initial)).status).toBe(200);
  expect((await call(db,"/api/mvp/outings","POST",initial)).status).toBe(200);
  expect((await db.prepare("SELECT COUNT(*) n FROM outings").first<{n:number}>())?.n).toBe(1);
  expect((await call(db,"/api/mvp/outings","PATCH",{
    key:one,day:d,category:"work",expectedDay:d,expectedCategory:"bar"})).status).toBe(200);
  const result=await call(db,"/api/mvp/compare?"+
    new URLSearchParams({aFrom:day(2),aTo:day(1),bFrom:d,bTo:d}));
  const comp=await result.json() as {b:{outings:{visits:number;work:number};drinking:{recordedAlcoholCups:number}}};
  expect(comp.b.outings.visits).toBe(1);
  expect(comp.b.outings.work).toBe(1);
  expect(comp.b.drinking.recordedAlcoholCups).toBe(0);
  expect((await call(db,"/api/mvp/outings","DELETE",{
    key:one,expectedDay:d,expectedCategory:"bar"})).status).toBe(409);
  expect((await call(db,"/api/mvp/outings","DELETE",{
    key:one,expectedDay:d,expectedCategory:"work"})).status).toBe(200);
  expect((await db.prepare("SELECT COUNT(*) n FROM outings").first<{n:number}>())?.n).toBe(0);
 });

});
