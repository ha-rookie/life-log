import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { handleAuditHistory } from "../src/worker/audit-history";
import { handleImport } from "../src/worker/import";
import type { ImportDb, Statement } from "../src/worker/import";
import { hash } from "../src/shared/csv-import";
import { normalizeOfficialCsv } from "../src/shared/source-adapter";

interface LocalStatement extends Statement { bind(...values:unknown[]):LocalStatement;run():Promise<unknown> }
interface LocalDb extends ImportDb {prepare(sql:string):LocalStatement}
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
    await db.batch(["DELETE FROM import_row_audit","DELETE FROM body_measurements","DELETE FROM lifestyle_days","DELETE FROM activity_daily","DELETE FROM import_jobs","DELETE FROM owners"].map(sql=>db.prepare(sql)));
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
      } else {
        await db.prepare(
          "INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,body_fat_pct,"
          + "source_id,source_row_key,source_kind,import_job_id) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(id+":"+i,owner,day+"T0"+i+":00:00Z",72+i,i===0?0:null,"csv:eclear",key,"measured",id).run();
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
  it("Japanese lifestyle canonical chunks retain strict one-row/one-audit cardinality and detect missing audit",async()=>{
    const original="\uFEFF歩数,飲酒,日付,体重_kg,測定時刻\r\n"+
      "0,1,2026/01/02,,\r\n"+
      ",0,2026/01/03,,\r\n"+
      "6500,,2026/01/04,,\r\n";
    const normalized=normalizeOfficialCsv("lifestyle",original);
    expect(normalized.parts).toHaveLength(1);
    const canonical=normalized.parts[0];
    const request=()=>new Request("https://example.invalid/api/import/confirm",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({source:"lifestyle",csv:canonical,hash:awaitDigest,confirmed:true})
    });
    const awaitDigest=await hash(canonical);
    const first=await handleImport(request(),db,"owner");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({inserted:3,skipped:0,auditStatus:"complete"});
    const list=await get(db);
    expect(list.code).toBe(200);
    expect(list.body.jobs).toHaveLength(1);
    expect(list.body.jobs[0]).toMatchObject({
      source:"lifestyle",auditStatus:"available",auditCount:3,insertedRecords:3
    });
    const job=list.body.jobs[0].id as string;
    const detail=await get(db,"/"+job);
    expect(detail.body.job).toMatchObject({auditStatus:"available",counts:{inserted:3,conflict:0}});
    expect(detail.body.rows.map((r:{result:string;values:unknown})=>[r.result,r.values])).toEqual([
      ["inserted",{drinkingPresence:1,drinkCups:null,steps:0}],
      ["inserted",{drinkingPresence:0,drinkCups:0,steps:null}],
      ["inserted",{drinkingPresence:null,drinkCups:null,steps:6500}]
    ]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM body_measurements")
      .first<{n:number}>())?.n).toBe(0);
    const again=await handleImport(request(),db,"owner");
    expect(again.status).toBe(200);
    expect((await get(db)).body.jobs).toHaveLength(1);
    // Removing a genuine inserted row audit must still fail the verified readback.
    const realId="owner:lifestyle:"+awaitDigest;
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=? AND source_row_number=?")
      .bind(realId,3).run();
    const after=await get(db,"/"+job);
    expect(after.body.job).toMatchObject({auditStatus:"incomplete",counts:null});
    expect((await get(db)).body.jobs[0]).toMatchObject({
      auditStatus:"incomplete",auditCount:2,insertedRecords:3
    });
  },100_000);

  it("reports Fit CSV corrections separately and preserves prior job audit provenance",async()=>{
    const importFit=async(csv:string)=>{
      const req=new Request("https://example.invalid/api/import/confirm",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({source:"fit",csv,hash:await hash(csv),confirmed:true})
      });
      const res=await handleImport(req,db,"owner");
      expect(res.status).toBe(200);
      return res.json() as Promise<{inserted:number;updated:number;skipped:number}>;
    };
    const initial="local_day,steps\n2026-01-01,4500\n";
    const corrected="local_day,steps\n2026-01-01,5000\n2026-01-02,0\n";
    expect(await importFit(initial)).toMatchObject({inserted:1,updated:0,skipped:0});
    expect(await importFit(corrected)).toMatchObject({inserted:1,updated:1,skipped:0});
    const listing=await get(db);
    expect(listing.code).toBe(200);
    expect(listing.body.jobs).toHaveLength(2);
    expect(listing.body.jobs.every((j:{auditStatus:string})=>j.auditStatus==="available")).toBe(true);
    const recent=listing.body.jobs[0].id as string;
    const prior=listing.body.jobs[1].id as string;
    const fresh=await get(db,"/"+recent);
    expect(fresh.body.job).toMatchObject({auditStatus:"available",counts:{inserted:1,updated:1,skipped:0,conflict:0,invalid:0}});
    expect(fresh.body.rows.map((r:{result:string;values:unknown})=>[r.result,r.values]))
      .toEqual([["updated",null],["inserted",{steps:0}]]);
    expect((await get(db,"/"+prior)).body.job).toMatchObject({
      auditStatus:"available",counts:{inserted:1,updated:0}});
  },100_000);
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
  it("flags partially missing inserted audit for lifestyle on list and detail",async()=>{
    const id=await seed("owner","lifestyle");
    // Delete only the second audit; both imported destination rows remain.
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=? AND source_row_number=3").bind(id).run();
    const list=await get(db);
    expect(list.body.jobs).toHaveLength(1);
    expect(list.body.jobs[0]).toMatchObject({auditStatus:"incomplete",auditCount:1,insertedRecords:2});
    const detail=await get(db,"/"+list.body.jobs[0].id);
    expect(detail.body.job).toMatchObject({auditStatus:"incomplete",counts:null});
    expect(detail.body.rows).toHaveLength(1);
    expect(detail.body.rows[0].line).toBe(2);
    expect(detail.body.rows[0].values).toEqual({drinkingPresence:0,drinkCups:0,steps:0});
    expect(detail.headers.get("Cache-Control")).toBe("private, no-store");
  },100_000);
  it("flags partially missing inserted audit for eclear on list and detail",async()=>{
    const id=await seed("owner","eclear");
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=? AND source_row_number=2").bind(id).run();
    const list=await get(db);
    expect(list.body.jobs[0]).toMatchObject({auditStatus:"incomplete",auditCount:1,insertedRecords:2});
    const detail=await get(db,"/"+list.body.jobs[0].id);
    expect(detail.body.job).toMatchObject({auditStatus:"incomplete",counts:null});
    expect(detail.body.rows).toHaveLength(1);
    expect(detail.body.rows[0].line).toBe(3);
    expect(detail.body.rows[0].values).toEqual({weightKg:73,bodyFatPct:null});
  },100_000);
  it("preserves legacy_unavailable with confirmed pre-audit destination records",async()=>{
    const id=await seed("owner","eclear","confirmed","csv:");
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=?").bind(id).run();
    const list=await get(db);
    expect(list.body.jobs[0]).toMatchObject({auditStatus:"legacy_unavailable",auditCount:0,insertedRecords:2});
    const detail=await get(db,"/"+list.body.jobs[0].id);
    expect(detail.body.job).toMatchObject({auditStatus:"legacy_unavailable",counts:null});
    expect(detail.body.rows).toEqual([]);
  },100_000);
  it("does not invent skipped or conflict values and does not write any DB state",async()=>{
    const id=await seed("owner","lifestyle");
    await db.prepare("UPDATE import_row_audit SET result='conflict',error_code='LIFESTYLE_CONFLICT_KEPT' WHERE import_job_id=? AND source_row_number=2").bind(id).run();
    await db.prepare("UPDATE import_row_audit SET result='skipped' WHERE import_job_id=? AND source_row_number=3").bind(id).run();
    // Skipped/conflicted rows legitimately have no inserted destinations in this job.
    await db.prepare("DELETE FROM lifestyle_days WHERE import_job_id=?").bind(id).run();
    const before=await db.prepare("SELECT COUNT(*) AS n FROM import_row_audit").first<{n:number}>();
    const list=await get(db);
    const handle=list.body.jobs[0].id as string;
    const detail=await get(db,"/"+handle);
    expect(list.body.jobs[0]).toMatchObject({auditStatus:"available",auditCount:2,insertedRecords:0});
    expect(detail.body.job).toMatchObject({auditStatus:"available",counts:{inserted:0,skipped:1,conflict:1,invalid:0}});
    expect(detail.body.rows.map((r:{values:unknown})=>r.values)).toEqual([null,null]);
    expect(detail.body.rows.map((r:{result:string})=>r.result)).toEqual(["conflict","skipped"]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM import_row_audit").first<{n:number}>())?.n).toBe(before?.n);
  },100_000);
  it("suppresses internal row error codes while retaining known safe classifications",async()=>{
    const id=await seed("owner","eclear");
    await db.prepare("UPDATE import_row_audit SET result='conflict', error_code=? WHERE import_job_id=? AND source_row_number=2")
      .bind("INTERNAL_SQL_PASSWORD_OR_EMAIL",id).run();
    const listing=await get(db);
    const job=listing.body.jobs[0].id as string;
    const first=await get(db,"/"+job);
    expect(first.code).toBe(200);
    expect(first.body.rows[0].errorCode).toBeNull();
    expect(JSON.stringify(first.body)).not.toContain("INTERNAL_SQL_PASSWORD_OR_EMAIL");
    await db.prepare("UPDATE import_row_audit SET error_code=? WHERE import_job_id=? AND source_row_number=2")
      .bind("AMBIGUOUS_ECLEAR_TIMESTAMP",id).run();
    const second=await get(db,"/"+job);
    expect(second.body.rows[0].errorCode).toBe("AMBIGUOUS_ECLEAR_TIMESTAMP");
  },100_000);
  it("denies non-GET and duplicate/extra query params without any D1 write",async()=>{
    const nonGet=await handleAuditHistory(new Request(prefix,{method:"POST"}),db,"owner");
    expect(nonGet.status).toBe(405);
    for(const path of ["?limit=1&limit=2","?cursor=x&cursor=y","?debug=1"]){
      expect((await get(db,"",path)).code).toBe(400);
    }
    expect(nonGet.headers.get("Cache-Control")).toBe("private, no-store");
  },100_000);
});
