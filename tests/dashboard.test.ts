import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {getPlatformProxy} from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import {getDashboard} from "../src/worker/summary";
import {createHandler,type Env} from "../src/worker/index";

interface DbStmt {
  bind(...values:unknown[]):DbStmt;
  run():Promise<unknown>;
  first<T>():Promise<T|null>;
}
interface LocalDb {prepare(sql:string):DbStmt}
describe("canonical, read-only home metrics on local D1",()=>{
  let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:LocalDb}>>>;
  let db:LocalDb;
  beforeAll(async()=>{
    platform=await getPlatformProxy<{DB:LocalDb}>({configPath:"wrangler.jsonc",remoteBindings:false,persist:false});
    db=platform.env.DB;
    const statements=schemaSql.split("\n").filter(l=>!l.trimStart().startsWith("--")).join("\n")
      .split(";").map(s=>s.trim()).filter(Boolean);
    for(const sql of statements)await db.prepare(sql).run();
  },100_000);
  afterAll(async()=>{await platform?.dispose();},60000);
  beforeEach(async()=>{
    for(const t of ["body_measurements","activity_daily","owners"])
      await db.prepare("DELETE FROM "+t).run();
    await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01T00:00:00Z')").run();
  });

  it("does not invent a weight, step count, or zero on missing data",async()=>{
    expect(await getDashboard(db,"owner")).toEqual({
      latestWeightKg:null,measuredAt:null,weightSource:null,
      latestSteps:null,stepsDay:null,stepsSource:null
    });
  });
  it("prefers ECLEAR and Google Fit on the same day, while preserving manual source rows",async()=>{
    const w="INSERT INTO body_measurements"+
      "(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind)"+
      " VALUES(?,?,?,?,?,?,'measured')";
    await db.prepare(w).bind("manual-w","owner","2026-11-06T21:00:00+09:00",80.1,"manual:weight","mw").run();
    await db.prepare(w).bind("eclear-w","owner","2026-11-06T08:00:00+09:00",75.2,"csv:eclear","ew").run();
    const st="INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) VALUES(?,?,?,?,?,?)";
    await db.prepare(st).bind("manual-s","owner","2026-11-06",9000,"manual:steps","ms").run();
    await db.prepare(st).bind("fit-s","owner","2026-11-06",0,"fit","fs").run();
    expect(await getDashboard(db,"owner")).toEqual({
      latestWeightKg:75.2,measuredAt:"2026-11-06T08:00:00+09:00",weightSource:"csv:eclear",
      latestSteps:0,stepsDay:"2026-11-06",stepsSource:"fit"
    });
  },100_000);
  it("shows the latest observed day; a Fit NULL is missing, not a zero",async()=>{
    const st="INSERT INTO activity_daily(id,owner_id,local_day,steps,source_id,source_row_key) VALUES(?,?,?,?,?,?)";
    await db.prepare(st).bind("fit-s","owner","2026-11-07",null,"fit","f0").run();
    await db.prepare(st).bind("manual-s","owner","2026-11-07",4400,"manual:steps","m0").run();
    const result=await getDashboard(db,"owner");
    expect(result.latestSteps).toBe(4400);
    expect(result.stepsSource).toBe("manual:steps");
  },100_000);
  it("never exposes owner dashboard to anonymous or forged identity; POST forbidden",async()=>{
    const env={
      DB:{prepare:vi.fn(()=>{throw Error("Do not read owner DB");})},
      ASSETS:{fetch:vi.fn()}
    } as unknown as Env;
    const handler=createHandler(async()=>null);
    const anon=await handler.fetch(new Request("https://app.example.invalid/api/dashboard",{
      headers:{"Cf-Access-Authenticated-User-Email":"owner@example.invalid"}
    }),env);
    expect(anon.status).toBe(403);
    expect(env.DB.prepare).not.toHaveBeenCalled();
    const allowedEnv={...env,DB:db} as unknown as Env;
    const auth=createHandler(async()=>"owner");
    const post=await auth.fetch(new Request("https://app.example.invalid/api/dashboard",{method:"POST"}),allowedEnv);
    expect(post.status).toBe(405);
    expect(post.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
