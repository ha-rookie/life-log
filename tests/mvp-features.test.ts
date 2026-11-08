import { beforeAll,afterAll,beforeEach,describe,it,expect } from "vitest";
import { getPlatformProxy } from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import { handleMvpFeatures } from "../src/worker/mvp-features";
type Statement={bind(...args:unknown[]):Statement;run():Promise<unknown>;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>};
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
});
