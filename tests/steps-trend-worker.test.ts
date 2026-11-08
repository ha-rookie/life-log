import { afterAll,beforeAll,beforeEach,describe,it,expect,vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler,type Env } from "../src/worker/index";
import { buildStepsTrend } from "../src/worker/steps-trend";
type Statement={bind(...values:unknown[]):{all<T>():Promise<{results:T[]}>;run():Promise<unknown>};run():Promise<unknown>};
type Db={prepare(sql:string):Statement};
const path="https://example.invalid/api/steps/trend";
describe("Owner-only steps trend based on canonical Google Fit",()=>{
 let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:Db}>>>;
 let db:Db;
 beforeAll(async()=>{
   platform=await getPlatformProxy<{DB:Db}>({configPath:"wrangler.jsonc",remoteBindings:false,persist:false});
   db=platform.env.DB;
   for(const sql of schemaSql.split("\n").filter(x=>!x.trimStart().startsWith("--")).join("\n").split(";").map(x=>x.trim()).filter(Boolean))
     await db.prepare(sql).run();
 },100_000);
 afterAll(async()=>{await platform?.dispose();},60_000);
 beforeEach(async()=>{
   await db.prepare("DELETE FROM activity_daily").run();
   await db.prepare("DELETE FROM owners").run();
   await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01'),('other','2026-01-01')").run();
 });
 async function put(owner:string,day:string,steps:number|null,source:string){
   await db.prepare(
     "INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key)"+
     " VALUES(?,?,?,?,?,?)"
   ).bind(owner+":"+day+":"+source,owner,day,steps,source,day).run();
 }
 async function get(suffix:string="",owner:"owner"|null="owner",method="GET"){
   const spy=vi.fn((sql:string)=>db.prepare(sql));
   const handler=createHandler(async()=>owner);
   const res=await handler.fetch(new Request(path+suffix,{method}),{
     DB:{prepare:spy},ASSETS:{fetch:vi.fn()}
   } as unknown as Env);
   return {status:res.status,data:await res.json() as Record<string,unknown>,spy};
 }
 it("Fit wins over manual; zero is observation, NULL is missing, other owner isolated",async()=>{
   await put("owner","2026-01-02",9000,"manual:steps");
   await put("owner","2026-01-02",4800,"fit");
   await put("owner","2026-01-03",null,"fit");
   await put("owner","2026-01-03",0,"manual:steps");
   await put("owner","2026-01-04",null,"fit");
   await put("owner","2026-01-05",0,"fit");
   await put("owner","2026-01-05",7000,"manual:steps");
   await put("owner","2026-01-06",12345,"csv:lifestyle");
   await put("other","2026-01-04",70000,"fit");
   const before=await db.prepare("SELECT COUNT(*) AS n FROM activity_daily").bind().all<{n:number}>();
   const result=await get("?from=2026-01-02&to=2026-01-07");
   expect(result.status).toBe(200);
   const days=result.data.days as {day:string;steps:number|null;source:string|null}[];
   expect(days.map(x=>x.steps)).toEqual([4800,0,null,0,null,null]);
   expect(days.map(x=>x.source)).toEqual(["Google Fit","手入力",null,"Google Fit",null,null]);
   expect(result.data).toMatchObject({observedDays:3,missingDays:3,zeroDays:2,meanSteps:1600,timezone:"Asia/Tokyo"});
   expect(result.spy).toHaveBeenCalledTimes(1);
   const sql=result.spy.mock.calls[0][0];
   expect(sql).toContain("owner_id=?");expect(sql).toContain("LIMIT 10001");
   expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
   expect(JSON.stringify(result.data)).not.toContain("70000");
   const after=await db.prepare("SELECT COUNT(*) AS n FROM activity_daily").bind().all<{n:number}>();
   expect(after.results).toEqual(before.results);
 },100_000);
 it("rejects unauthorized access without D1 inspection",async()=>{
   const spy=vi.fn();
   const handler=createHandler(async()=>null);
   const res=await handler.fetch(new Request(path,{headers:{"Cf-Access-Authenticated-User-Email":"owner@example.invalid"}}),{
     DB:{prepare:spy},ASSETS:{fetch:vi.fn()}
   } as unknown as Env);
   expect(res.status).toBe(403);expect(spy).not.toHaveBeenCalled();
 });
 it("invalid range, future date, extra argument and non-GET never call D1",async()=>{
   for(const [suffix,method,expected] of [
     ["?from=2026-02-30&to=2026-03-01","GET",400],
     ["?from=2026-01-01&to=2027-02-01","GET",400],
     ["?from=2099-01-01&to=2099-01-30","GET",400],
     ["?from=2026-01-01&to=2026-01-31&owner=other","GET",400],
     ["?from=2026-01-01&from=2026-01-02&to=2026-01-31","GET",400],
     ["","POST",405]
   ] as const){
     const response=await get(suffix,"owner",method);
     expect(response.status).toBe(expected);
     expect(response.spy).not.toHaveBeenCalled();
   }
 });
 it("returns missing days without fabricated zero for an empty period",async()=>{
   const res=await get("?from=2026-01-01&to=2026-01-03");
   expect(res.status).toBe(200);
   expect(res.data).toMatchObject({meanSteps:null,observedDays:0,missingDays:3,zeroDays:0});
   expect((res.data.days as {steps:number|null}[]).map(x=>x.steps)).toEqual([null,null,null]);
 });
});
describe("Steps-trend grouping in progress UI",()=>{
 it("groups weeks from Monday, averages only observed values and preserves zero",async()=>{
   const {groupProgress}=await import("../src/client/ProgressCharts");
   const points=groupProgress([
     {day:"2026-11-02",value:0},
     {day:"2026-11-03",value:null},
     {day:"2026-11-08",value:5000},
     {day:"2026-11-09",value:null},
     {day:"2026-11-10",value:7000},
   ],"week");
   expect(points.map(p=>[p.key,p.value,p.count])).toEqual([
     ["2026-11-02",2500,2],["2026-11-09",7000,1]
   ]);
   const days=groupProgress([{day:"2026-11-02",value:0},{day:"2026-11-03",value:null}],"day");
   expect(days.map(p=>p.value)).toEqual([0,null]);
 });
});
