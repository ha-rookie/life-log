import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { handleAuditHistory } from "../src/worker/audit-history";
import type { ImportDb } from "../src/worker/import";
import { hash } from "../src/shared/csv-import";

interface Statement { bind(...values:unknown[]):Statement;run():Promise<unknown>;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}> }
type LocalDb = ImportDb & {prepare(sql:string):Statement};
const prefix="https://example.invalid/api/import/history";
const req=(path="",query="")=>new Request(prefix+path+query,{method:"GET"});
const get=async(db:ImportDb,path="",query="",owner="owner")=>{
  const r=await handleAuditHistory(req(path,query),db,owner);
  return {code:r.status,body:await r.json() as Record<string,any>,headers:r.headers};
};
describe("owner-only CSV audit history on ephemeral local D1",()=>{
  let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:LocalDb}>>>;
  let db:LocalDb;
  beforeAll(async()=>{
    platform=await getPlatformProxy<{DB:LocalDb}>({configPath:"wrangler.jsonc",remoteBindings:false,persist:false});
    db=platform.env.DB;
    const schema=schemaSql.split("\n").filter(line=>!line.trimStart().startsWith("--")).join("\n");
    for(const statement of schema.split(";").map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  },100_000);
  afterAll(async()=>{await platform?.dispose();},60_000);
  beforeEach(async()=>{
    await db.batch(["DELETE FROM import_row_audit","DELETE FROM body_measurements","DELETE FROM lifestyle_days","DELETE FROM import_jobs","DELETE FROM owners"].map(sql=>db.prepare(sql)));
    for(const owner of ["owner","other"])await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?)").bind(owner,"2026-01-01Z").run();
  });
  async function seed(owner:string,source:"lifestyle"|"eclear",status="confirmed",marker="csv:audited-v2:",day="2026-01-02",n=2){
    const id=owner+":"+source+":"+await hash(owner+day+source);
    await db.prepare("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id,owner,source,marker+source,await hash(owner+day+source),status,day+"T00:00:00Z",day+"T00:00:01Z").run();
    for(let i=0;i<n;i++){
      const key=await hash(id+":"+i);
      if(source==="lifestyle"){
        await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id) VALUES (?,?,?,?,?,?,?,?)")
          .bind(owner,i===0?"2026-01-02":"2026-01-03",i===0?0:null,i===0?0:null,i===0?0:null,"csv:lifestyle",key,id).run();
      }
      await db.prepare("INSERT INTO import_row_audit(id,import_job_id,source_row_number,source_row_key,result) VALUES (?,?,?,?,?)")
        .bind(id+":"+i,id,i+2,key,"inserted").run();
    }
    return id;
  }
  it("denies unauthenticated and spoofed requests before any DB read",async()=>{
    const spy={prepare:vi.fn(),batch:vi.fn()};
    const env={DB:spy,ASSETS:{fetch:vi.fn()}} as unknown as Env;
    for(const path of ["/api/import/history","/api/import/history/owner:lifestyle:fake"]){
      const response=await createHandler(async()=>null).fetch(new Request("https://example.invalid"+path,{
        headers:{"Cf-Access-Authenticated-User-Email":"owner@example.invalid","X-User":"owner"}}),env);
      expect(response.status).toBe(403);
    }
    expect(spy.prepare).not.toHaveBeenCalled();
    expect(spy.batch).not.toHaveBeenCalled();
  });
  it("lists only own jobs, owner-scoped detail, and does not leak CSV hash or row keys",async()=>{
    await seed("owner","lifestyle");
    const other=await seed("other","eclear");
    const list=await get(db);
    expect(list.code).toBe(200);
    expect(list.body.jobs).toHaveLength(1);
    const handle=list.body.jobs[0].id as string;
    expect(handle).toMatch(/^[1-9][0-9]*$/);
    expect(JSON.stringify(list.body)).not.toContain(other);
    expect(list.headers.get("Cache-Control")).toBe("private, no-store");
    expect(list.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await get(db,"/"+other)).code).toBe(404);
    const detail=await get(db,"/"+handle);
    expect(detail.code).toBe(200);
    expect(detail.body.rows).toHaveLength(2);
    expect(JSON.stringify(detail.body)).not.toContain("source_row_key");
    expect(JSON.stringify(detail.body)).not.toContain("file_sha256");
    expect(JSON.stringify(detail.body)).not.toContain("owner_id");
    expect(detail.body.rows[0].values).toEqual({drinkingPresence:0,drinkCups:0,steps:0});
    expect(detail.body.rows[1].values).toEqual({drinkingPresence:null,drinkCups:null,steps:null});
  },100_000);
  it("paginates jobs and rows with stable keysets and rejects forged and malformed cursors",async()=>{
    const jobs:string[]=[];
    for(let i=1;i<=4;i++)jobs.push(await seed("owner","eclear","confirmed","csv:audited-v2:","2026-01-0"+i,0));
    const first=await get(db,"","?limit=2");
    expect(first.body.jobs).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second=await get(db,"","?limit=2&cursor="+encodeURIComponent(first.body.nextCursor));
    expect(second.body.jobs).toHaveLength(2);
    expect(new Set([...first.body.jobs,...second.body.jobs].map((j:{id:string})=>j.id)).size).toBe(4);
    for(const query of ["?limit=26","?limit=0","?limit=1&limit=2","?cursor=bad!","?foo=x"]){
      expect((await get(db,"",query)).code).toBe(400);
    }
    await seed("owner","lifestyle");
    const listing=await get(db);
    const handle=(listing.body.jobs.find((j:{source:string})=>j.source==="lifestyle") as {id:string}).id;
    const r1=await get(db,"/"+handle,"?limit=1");
    const r2=await get(db,"/"+handle,"?limit=1&cursor="+encodeURIComponent(r1.body.nextCursor));
    expect(r1.body.rows[0].line).toBe(2);
    expect(r2.body.rows[0].line).toBe(3);
    expect(r2.body.nextCursor).toBeNull();
    expect((await get(db,"/"+handle,"?cursor=bad!")).code).toBe(400);
    expect((await get(db,"/"+handle,"?limit=25")).code).toBe(200);
  },100_000);
  it("marks legacy zero-audit explicitly and modern missing audit incomplete without guessing",async()=>{
    await seed("owner","eclear","confirmed","csv:", "2026-01-02",0);
    await seed("owner","lifestyle","confirmed","csv:audited-v2:","2026-01-03",0);
    const list=await get(db);
    const modern=(list.body.jobs.find((j:{source:string})=>j.source==="lifestyle") as {id:string}).id;
    const legacy=(list.body.jobs.find((j:{source:string})=>j.source==="eclear") as {id:string}).id;
    expect((await get(db,"/"+legacy)).body).toMatchObject({job:{auditStatus:"legacy_unavailable",counts:null},rows:[]});
    expect((await get(db,"/"+modern)).body).toMatchObject({job:{auditStatus:"incomplete",counts:null},rows:[]});
    const listing=await get(db);
    expect(listing.body.jobs.map((j:{auditStatus:string})=>j.auditStatus)).toEqual(["incomplete","legacy_unavailable"]);
  },100_000);
  it("does not invent skipped or conflict values and does not write any DB state",async()=>{
    const id=await seed("owner","lifestyle");
    await db.prepare("UPDATE import_row_audit SET result='conflict',error_code='LIFESTYLE_CONFLICT_KEPT' WHERE import_job_id=? AND source_row_number=2").bind(id).run();
    await db.prepare("UPDATE import_row_audit SET result='skipped' WHERE import_job_id=? AND source_row_number=3").bind(id).run();
    const before=await db.prepare("SELECT COUNT(*) AS n FROM import_row_audit").first<{n:number}>();
    const list=await get(db);
    const handle=list.body.jobs[0].id as string;
    const detail=await get(db,"/"+handle);
    expect(detail.body.rows.map((r:{values:unknown})=>r.values)).toEqual([null,null]);
    expect(detail.body.rows.map((r:{result:string})=>r.result)).toEqual(["conflict","skipped"]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM import_row_audit").first<{n:number}>())?.n).toBe(before?.n);
  },100_000);
});
