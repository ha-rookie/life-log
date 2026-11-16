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
    recordedAlcoholCups:1,knownAlcoholG:0,estimatedAlcoholG:10,
    estimatedAlcoholCups:1,unknownAlcoholCups:0,recordedNonAlcoholCups:1
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
 it("roundtrips tequila shots and mixed drinks through exact Owner D1 records, replay, edit, CSV and cancel",async()=>{
  const at=new Date().toISOString();
  const tequila={key:one,observedAt:at,kind:"tequila_shot",cups:2,size:"custom",volumeMl:null,abvPct:null};
  const sour={...tequila,key:two,kind:"lemon_sour",cups:1};
  for(const row of [tequila,tequila,sour])expect((await call(db,"/api/mvp/drinks","POST",row)).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","POST",{...tequila,kind:"wine"})).status).toBe(409);
  const stored=await db.prepare("SELECT id,source_id,drink_kind,drink_variant,cups,volume_ml,abv_pct FROM drink_entries WHERE owner_id=? AND source_row_key=?")
    .bind("owner",one).first();
  expect(stored).toMatchObject({id:"manual:drink:"+one,source_id:"manual:drink:tequila_shot",
    drink_kind:"other_alcohol",drink_variant:null,cups:2,volume_ml:null,abv_pct:null});
  const entries=(await (await call(db,"/api/mvp/drinks")).json() as {entries:{key:string;kind:string}[]}).entries;
  expect(entries.find(x=>x.key===one)?.kind).toBe("tequila_shot");
  expect(entries.find(x=>x.key===two)?.kind).toBe("lemon_sour");
  const period=await call(db,"/api/mvp/compare?"+
    new URLSearchParams({aFrom:day(2),aTo:day(1),bFrom:day(0),bTo:day(0)}));
  expect((await period.json() as {b:{drinking:unknown}}).b.drinking).toMatchObject({
    recordedAlcoholCups:3,knownAlcoholG:0,estimatedAlcoholG:29.2,
    estimatedAlcoholCups:3,unknownAlcoholCups:0,assumptionVersion:"personal-2026-11-15-v1"
  });
  const csv=await (await call(db,"/api/mvp/export?from="+day(0)+"&to="+day(0))).text();
  expect(csv).toContain('"drink","'+at+'","2","ordered_cups","manual:drink:tequila_shot","tequila_shot"');
  expect(csv).toContain('"drink_estimated_pure_alcohol","'+at+'","19.2","g","manual:drink:tequila_shot","tequila_shot"');
  expect(csv).toContain('"drink_alcohol_basis","'+at+'","estimated","basis","manual:drink:tequila_shot","tequila_shot"');
  expect(csv).toContain('"drink_estimate_rule","'+at+'","personal-2026-11-15-v1"');
  const patch={...tequila,kind:"beer",expectedKind:"tequila_shot",expectedObservedAt:at,
    expectedCups:2,expectedSize:"custom",expectedVolumeMl:null,expectedAbvPct:null};
  expect((await call(db,"/api/mvp/drinks","PATCH",patch)).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","PATCH",patch)).status).toBe(409);
  expect(await db.prepare("SELECT id,source_id,drink_variant FROM drink_entries WHERE owner_id=? AND source_row_key=?")
    .bind("owner",one).first()).toMatchObject({id:"manual:drink:"+one,source_id:"manual:drink",drink_variant:"beer"});
  expect((await call(db,"/api/mvp/drinks","PATCH",{...patch,kind:"tequila_shot",expectedKind:"beer"})).status).toBe(200);
  expect((await call(db,"/api/mvp/drinks","DELETE",{key:one,expectedObservedAt:at,expectedKind:"beer"})).status).toBe(409);
  expect((await call(db,"/api/mvp/drinks","DELETE",{key:one,expectedObservedAt:at,expectedKind:"tequila_shot"})).status).toBe(200);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM drink_entries WHERE owner_id='owner'").first<{n:number}>())?.n).toBe(1);
 });
 it("separates unknown alcoholic drinks, estimated shots and known zero non-alcohol",async()=>{
  const observedAt=new Date().toISOString();
  for(const row of [{key:one,kind:"other_alcohol",cups:3,observedAt},
    {key:two,kind:"non_alcohol",cups:2,observedAt},
    {key:crypto.randomUUID(),kind:"tequila_shot",cups:2,observedAt}])
    expect((await call(db,"/api/mvp/drinks","POST",row)).status).toBe(200);
  const period=await call(db,"/api/mvp/compare?"+
    new URLSearchParams({aFrom:day(2),aTo:day(1),bFrom:day(0),bTo:day(0)}));
  expect((await period.json() as {b:{drinking:unknown}}).b.drinking).toMatchObject({
    recordedAlcoholCups:5,recordedNonAlcoholCups:2,knownAlcoholG:0,
    estimatedAlcoholG:19.2,estimatedAlcoholCups:2,unknownAlcoholCups:3
  });
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
 it("computes Owner-scoped matched elapsed experiment and baseline windows with qualified 7-day weight means",async()=>{
  const plan={id:one,statement:"Synthetic test: daily walks",targetAction:"Walk after dinner",
    startsOn:day(8),endsOn:day(-7),supportText:"prior records",counterText:"missing days",unknownText:"other factors"};
  expect((await call(db,"/api/mvp/experiments","POST",plan)).status).toBe(200);
  const insertWeight=async(ago:number,kg:number,source:string,id:string,owner="owner")=>
    db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
      "VALUES(?,?,?,?,?,?,?)").bind(id,owner,time(ago),kg,source,id,"measured").run();
  // Before: nine JST days, last seven have 4 reliable ECLEAR days -> 79.5kg mean.
  for(const [ago,kg] of [[15,80],[14,81],[13,79],[12,78]] as const)
    await insertWeight(ago,kg,"eclear","before-"+ago);
  // During: first 9 days of a longer plan, last seven contain 4 ECLEAR measurements.
  for(const [ago,kg] of [[8,90],[6,77],[5,76],[4,76.5],[3,75]] as const)
    await insertWeight(ago,kg,"csv:eclear","after-"+ago);
  await insertWeight(6,140,"manual:weight","conflicting-manual");
  await insertWeight(5,200,"eclear","other-owner","other");
  const insertStep=async(ago:number,n:number,source:string,id:string)=>
    db.prepare("INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) VALUES(?,?,?,?,?,?)")
      .bind(id,"owner",day(ago),n,source,id).run();
  await insertStep(6,0,"google_fit","fit-zero");
  await insertStep(6,9999,"manual:steps","manual-conflict");
  await insertStep(5,3000,"fit","fit-nonzero");
  await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,source_id,source_row_key) "+
    "VALUES (?,?,?,?,?,?)").bind("owner",day(15),1,null,"csv","drank-but-no-cups").run();
  await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,source_id,source_row_key) "+
    "VALUES (?,?,?,?,?,?)").bind("owner",day(5),0,0,"csv","confirmed-sober").run();
  const reply=await call(db,"/api/mvp/experiments/evidence?id="+one);
  expect(reply.status).toBe(200);
  expect(reply.headers.get("Cache-Control")).toContain("no-store");
  const out=await reply.json() as any;
  expect(out).toMatchObject({id:one,status:"in_progress",asOf:day(0),
    plannedFrom:day(8),plannedTo:day(-7),
    before:{from:day(17),to:day(9),calendarDays:9},
    during:{from:day(8),to:day(0),calendarDays:9}});
  expect(out.before.weight).toMatchObject({lastSevenWindowDays:7,
    lastSevenObservedDays:4,lastSevenMeanKg:79.5});
  expect(out.during.weight).toMatchObject({lastSevenWindowDays:7,
    lastSevenObservedDays:4,lastSevenMeanKg:76.13,startKg:90,observedDays:5});
  expect(out.during.steps).toMatchObject({mean:1500,zeroDays:1,observedDays:2,
    sources:["google_fit","fit"]});
  expect(out.before.drinking).toMatchObject({drinkingDays:1,nondrinkingDays:0,
    recordedAlcoholCups:0,missingDays:8});
  expect(out.during.drinking).toMatchObject({drinkingDays:0,nondrinkingDays:1,missingDays:8});
  // Read-only aggregation must not write experiment decisions or any measurements.
  expect((await db.prepare("SELECT user_decision FROM behavior_experiments WHERE id=?").bind(one)
    .first<{user_decision:string|null}>())?.user_decision).toBeNull();
  expect((await db.prepare("SELECT count(*) n FROM body_measurements WHERE owner_id='owner'")
    .first<{n:number}>())?.n).toBe(10);
  for(const path of [
    "/api/mvp/experiments/evidence?id=bad",
    "/api/mvp/experiments/evidence",
    "/api/mvp/experiments/evidence?id="+one+"&owner=other",
    "/api/mvp/experiments/evidence?id="+one+"&id="+one
  ])expect((await call(db,path)).status).toBe(400);
  const foreign=await handleMvpFeatures(new Request(site+"/api/mvp/experiments/evidence?id="+one),
    db,"other",env);
  expect(foreign.status).toBe(404);
  expect((await call(db,"/api/mvp/experiments/evidence","POST",{id:one})).status).toBe(405);
 });
 it("returns no future evidence, no invented partial 7-day mean, and stops at a finished plan's actual end",async()=>{
  const future={id:one,statement:"Future synthetic",targetAction:"Try a walk",
    startsOn:day(-5),endsOn:day(-12)};
  expect((await call(db,"/api/mvp/experiments","POST",future)).status).toBe(200);
  const futureResult=await call(db,"/api/mvp/experiments/evidence?id="+one);
  expect(futureResult.status).toBe(200);
  expect(await futureResult.json()).toMatchObject({
    status:"not_started",before:null,during:null,asOf:day(0)});
  // A separate owner can register an overlapping future plan without leaking ours.
  const resolved=await call(db,"/api/mvp/experiments","PATCH",{
    id:one,decision:"unknown",outcomeText:"No observation yet"});
  expect(resolved.status).toBe(200);
  const plan={id:two,statement:"Short synthetic",targetAction:"Track a habit",
    startsOn:day(2),endsOn:day(-6)};
  expect((await call(db,"/api/mvp/experiments","POST",plan)).status).toBe(200);
  await db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "+
    "VALUES(?,?,?,?,?,?,?)").bind("single","owner",time(0),75,"eclear","single","measured").run();
  const partial=await (await call(db,"/api/mvp/experiments/evidence?id="+two)).json() as any;
  expect(partial).toMatchObject({status:"in_progress",
    before:{from:day(5),to:day(3),calendarDays:3},
    during:{from:day(2),to:day(0),calendarDays:3,
      weight:{observedDays:1,deltaKg:null,lastSevenWindowDays:3,
        lastSevenObservedDays:1,lastSevenMeanKg:null}}});
  expect(partial.before.weight.lastSevenMeanKg).toBeNull();
  // Finished historical plans may be compared through ends_on only, never today.
  expect((await call(db,"/api/mvp/experiments","PATCH",{
    id:two,decision:"unknown",outcomeText:"Data not available"})).status).toBe(200);
  const finishedId="00000000-0000-4000-8000-000000000017";
  const ended={id:finishedId,statement:"Finished synthetic",targetAction:"Recorded trial",
    startsOn:day(30),endsOn:day(20)};
  expect((await call(db,"/api/mvp/experiments","POST",ended)).status).toBe(200);
  const endedResult=await (await call(db,"/api/mvp/experiments/evidence?id="+finishedId)).json() as any;
  expect(endedResult).toMatchObject({status:"finished",before:{from:day(41),to:day(31),calendarDays:11},
    during:{from:day(30),to:day(20),calendarDays:11,
      weight:{observedDays:0,lastSevenMeanKg:null}}});
  expect(endedResult.during.weight.deltaKg).toBeNull();
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
  const bytes=new Uint8Array(await response.arrayBuffer());
  expect(Array.from(bytes.slice(0,3))).toEqual([0xef,0xbb,0xbf]);
  const csv=new TextDecoder("utf-8").decode(bytes);
  expect(csv.startsWith('"record_type","observed_at_or_day","value","unit","source","detail","value_state"\r\n')).toBe(true);
  expect(csv.endsWith("\r\n")).toBe(true);
  expect(csv).toContain('"steps","'+day(0)+'","0","steps","manual:steps","activity","present"');
  expect(csv).toContain('"\u0027=SHEET(""bad"")"');
  expect(csv).toContain('"drinking_presence","'+day(0)+'","","","\u0027=SHEET(""bad"")","lifestyle","null"');
  expect(csv).not.toContain("99999");
  expect((await call(db,"/api/mvp/export?from="+day(1)+"&from="+day(0)+"&to="+day(0))).status).toBe(400);
  expect((await call(db,"/api/mvp/export?from="+day(1)+"&to="+day(0)+"&to="+day(0))).status).toBe(400);
  expect((await call(db,"/api/mvp/export?from="+day(1)+"&to="+day(0)+"&owner=other")).status).toBe(400);
  expect((await call(db,"/api/mvp/export?from="+day(1))).status).toBe(400);
  expect((await call(db,"/api/mvp/export?to="+day(0))).status).toBe(400);
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
