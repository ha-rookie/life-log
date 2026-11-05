import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { handleImport, type ImportDb, type Statement } from "../src/worker/import";
import { hash } from "../src/shared/csv-import";

interface LocalStatement extends Statement {
  bind(...values: unknown[]): LocalStatement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}
interface LocalDb extends ImportDb { prepare(sql: string): LocalStatement; }
type Audit = { source_row_number:number;source_row_key:string;result:string;error_code:string|null };
type Reply = { status?:string;error?:string;inserted?:number;skipped?:number;conflicted?:number;
  reviewToken?:string;conflicts?:{day:string;fields:string[]}[];
  original?:{inserted:number;skipped:number;conflicted:number} };
const hdr = "local_day,drinking_presence,drink_cups,steps\n";
const life = hdr+"2026-01-02,1,,\n2026-01-03,0,0,0\n2026-01-04,,,\n";
const ec = "measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,72.2,22.5\n";
async function send(db:ImportDb,csv:string,opts:{
  source?:"lifestyle"|"eclear";owner?:string;confirmed?:boolean;
  resolution?:{mode:"keep_existing";token:string}
}={}){
  const source=opts.source??"lifestyle",confirmed=opts.confirmed??true;
  const req=new Request("https://example.invalid/api/import/"+(confirmed?"confirm":"preview"),{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({source,csv,hash:await hash(csv),confirmed,
      ...(opts.resolution?{resolution:opts.resolution}:{})}),
  });
  const r=await handleImport(req,db,opts.owner??"owner");
  return {code:r.status,data:await r.json() as Reply};
}
const keep=(token:string)=>({mode:"keep_existing" as const,token});
async function count(db:LocalDb,t:"owners"|"lifestyle_days"|"body_measurements"|"import_jobs"|"import_row_audit"){
  return (await db.prepare("SELECT COUNT(*) AS n FROM "+t).first<{n:number}>())?.n;
}
async function audit(db:LocalDb,source:"eclear"|"lifestyle",csv:string,owner="owner"){
  const job=owner+":"+source+":"+await hash(csv);
  const r=await db.prepare("SELECT source_row_number,source_row_key,result,error_code FROM import_row_audit WHERE import_job_id=? ORDER BY source_row_number")
    .bind(job).all<Audit>();
  return r.results;
}
describe("CSV Worker signed-identity boundary",()=>{
  it("rejects unauthenticated owner and spoofed identity on preview/confirm before any DB call",async()=>{
    const dbSpy={prepare:vi.fn(),batch:vi.fn()};
    const env={DB:dbSpy,ASSETS:{fetch:vi.fn()}} as unknown as Env;
    for(const path of ["/api/import/preview","/api/import/confirm"]){
      const r=await createHandler(async()=>null).fetch(new Request("https://example.invalid"+path,{
        method:"POST",headers:{"Content-Type":"application/json","Cf-Access-Authenticated-User-Email":"owner@example.invalid"},
        body:JSON.stringify({resolution:keep("0".repeat(64))}),
      }),env);
      expect(r.status).toBe(403);
    }
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(dbSpy.batch).not.toHaveBeenCalled();
  });
});
describe("real ephemeral local D1 audited import",()=>{
  let platform:Awaited<ReturnType<typeof getPlatformProxy<{DB:LocalDb}>>>;
  let db:LocalDb;
  beforeAll(async()=>{
    platform=await getPlatformProxy<{DB:LocalDb}>({
      configPath:"wrangler.jsonc",remoteBindings:false,persist:false,
    });
    db=platform.env.DB;
    const schema=schemaSql.split("\n").filter((line:string)=>!line.trimStart().startsWith("--")).join("\n");
    for(const sql of schema.split(";").map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  },100_000);
  afterAll(async()=>{await platform?.dispose();},60_000);
  beforeEach(async()=>{
    await db.batch(["DELETE FROM import_row_audit","DELETE FROM body_measurements",
      "DELETE FROM lifestyle_days","DELETE FROM import_jobs","DELETE FROM owners"]
      .map(sql=>db.prepare(sql)));
    await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?)")
      .bind("owner","2026-01-01T00:00:00Z").run();
  });

  it("previews without D1 mutation; confirms all rows with actual NULL and explicit zero plus audit",async()=>{
    expect((await send(db,life,{confirmed:false})).code).toBe(200);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"import_row_audit")).toBe(0);
    expect(await count(db,"lifestyle_days")).toBe(0);
    expect(await send(db,life)).toMatchObject({code:200,data:{
      status:"confirmed",inserted:3,skipped:0,conflicted:0,
    }});
    const rows=await db.prepare("SELECT local_day,drinking_presence,drink_cups,steps FROM lifestyle_days ORDER BY local_day")
      .all<{local_day:string;drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(rows.results).toEqual([
      {local_day:"2026-01-02",drinking_presence:1,drink_cups:null,steps:null},
      {local_day:"2026-01-03",drinking_presence:0,drink_cups:0,steps:0},
      {local_day:"2026-01-04",drinking_presence:null,drink_cups:null,steps:null},
    ]);
    const a=await audit(db,"lifestyle",life);
    expect(a.map(x=>[x.source_row_number,x.result,x.error_code])).toEqual([
      [2,"inserted",null],[3,"inserted",null],[4,"inserted",null],
    ]);
    expect(a.every(x=>x.source_row_key.length>60)).toBe(true);
  },100_000);

  it("same-file confirmed replay is idempotent; original audit is preserved unchanged",async()=>{
    expect((await send(db,life)).data.inserted).toBe(3);
    expect(await send(db,life)).toMatchObject({code:200,data:{
      status:"already_imported",inserted:0,skipped:3,
      original:{inserted:3,skipped:0,conflicted:0},
    }});
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(3);
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);

  it("identical lifestyle row from another file is skipped/audited, not double-counted",async()=>{
    const a=hdr+"2026-01-03,0,0,0\n",b=a+"2026-01-05,1,,2500\n";
    expect((await send(db,a)).data.inserted).toBe(1);
    expect(await send(db,b)).toMatchObject({code:200,data:{inserted:1,skipped:1,conflicted:0}});
    expect((await audit(db,"lifestyle",b)).map(x=>[x.result,x.error_code]))
      .toEqual([["skipped",null],["inserted",null]]);
    expect(await count(db,"lifestyle_days")).toBe(2);
  },100_000);

  it("a conflicting day blocks all writes until explicit keep-existing; partial job and all audits persist atomically",async()=>{
    const base=hdr+"2026-01-03,0,0,0\n";
    const candidate=hdr+"2026-01-03,1,,0\n2026-01-06,0,0,5000\n";
    expect((await send(db,base)).code).toBe(200);
    const blocked=await send(db,candidate);
    expect(blocked).toMatchObject({code:409,data:{error:"LIFESTYLE_CONFLICT",conflicts:[{
      day:"2026-01-03",fields:["drinking_presence","drink_cups"],
    }]}});
    expect(blocked.data.reviewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(1);
    const ok=await send(db,candidate,{resolution:keep(blocked.data.reviewToken!)});
    expect(ok).toMatchObject({code:200,data:{status:"partial",inserted:1,skipped:0,conflicted:1}});
    expect((await audit(db,"lifestyle",candidate)).map(x=>[x.result,x.error_code]))
      .toEqual([["conflict","LIFESTYLE_CONFLICT_KEPT"],["inserted",null]]);
    const saved=await db.prepare("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day=?")
      .bind("2026-01-03").first<{drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(saved).toEqual({drinking_presence:0,drink_cups:0,steps:0});
    expect(await count(db,"lifestyle_days")).toBe(2);
    expect(await send(db,candidate)).toMatchObject({code:200,data:{
      status:"already_imported",original:{inserted:1,skipped:0,conflicted:1},
    }});
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);

  it("NULL to zero produces three-field conflict, keeps original unknown values and audits a skip decision",async()=>{
    const base=hdr+"2026-01-04,,,\n",candidate=hdr+"2026-01-04,0,0,0\n";
    expect((await send(db,base)).code).toBe(200);
    const blocked=await send(db,candidate);
    expect(blocked.data.conflicts).toEqual([{
      day:"2026-01-04",fields:["drinking_presence","drink_cups","steps"],
    }]);
    const accepted=await send(db,candidate,{resolution:keep(blocked.data.reviewToken!)});
    expect(accepted).toMatchObject({code:200,data:{
      status:"partial",inserted:0,skipped:0,conflicted:1,
    }});
    const saved=await db.prepare("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day=?")
      .bind("2026-01-04").first<{drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(saved).toEqual({drinking_presence:null,drink_cups:null,steps:null});
    expect((await audit(db,"lifestyle",candidate))[0].result).toBe("conflict");
    expect(await count(db,"lifestyle_days")).toBe(1);
  },100_000);

  it("stale conflict decision requires fresh review and does not create an audit/job",async()=>{
    const base=hdr+"2026-01-03,0,0,0\n",candidate=hdr+"2026-01-03,1,,0\n";
    await send(db,base);
    const first=await send(db,candidate);
    await db.prepare("UPDATE lifestyle_days SET steps=9 WHERE owner_id=? AND local_day=?")
      .bind("owner","2026-01-03").run();
    const stale=await send(db,candidate,{resolution:keep(first.data.reviewToken!)});
    expect(stale).toMatchObject({code:409,data:{error:"REVIEW_STALE"}});
    expect(stale.data.reviewToken).not.toBe(first.data.reviewToken);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(1);
    const accepted=await send(db,candidate,{resolution:keep(stale.data.reviewToken!)});
    expect(accepted).toMatchObject({code:200,data:{status:"partial",conflicted:1}});
  },100_000);

  it("preflight-to-batch race is rejected inside real D1 transaction: no orphan job/audit",async()=>{
    const candidate=hdr+"2026-01-03,0,0,0\n2026-01-06,1,,6000\n";
    let injected=false;
    const raced:ImportDb={
      prepare:sql=>db.prepare(sql),
      batch:async ops=>{
        if(!injected){
          injected=true;
          await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key) VALUES (?,?,?,?,?,?,?)")
            .bind("owner","2026-01-03",1,null,null,"test-concurrent","race").run();
        }
        return db.batch(ops);
      },
    };
    expect(await send(raced,candidate)).toMatchObject({code:409,data:{error:"LIFESTYLE_CONFLICT"}});
    expect(injected).toBe(true);
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"import_row_audit")).toBe(0);
  },100_000);

  it("approved conflict cannot bypass a concurrent change before D1 batch",async()=>{
    const base=hdr+"2026-01-03,0,0,0\n",candidate=hdr+"2026-01-03,1,,0\n2026-01-06,1,,6000\n";
    await send(db,base);
    const review=await send(db,candidate);
    const raced:ImportDb={
      prepare:sql=>db.prepare(sql),
      batch:async ops=>{
        await db.prepare("UPDATE lifestyle_days SET steps=10 WHERE owner_id=? AND local_day=?")
          .bind("owner","2026-01-03").run();
        return db.batch(ops);
      },
    };
    expect(await send(raced,candidate,{resolution:keep(review.data.reviewToken!)}))
      .toMatchObject({code:409,data:{error:"REVIEW_STALE"}});
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"import_row_audit")).toBe(1);
  },100_000);

  it("mid-batch SQL error after an audit insert rolls back job/data/audit; retry succeeds",async()=>{
    let failedInside=false;
    const faultDb:ImportDb={
      prepare:sql=>db.prepare(sql),
      batch:ops=>{
        failedInside=true;
        const invalid=db.prepare(
          "INSERT INTO import_row_audit(id,import_job_id,source_row_number,source_row_key,result)"
          +" VALUES ('fault','missing-job',1,'fault','ILLEGAL')"
        );
        return db.batch([...ops.slice(0,4),invalid,...ops.slice(4)]);
      },
    };
    const res=await send(faultDb,life);
    expect(failedInside).toBe(true);
    expect(res.code).toBe(503);
    expect(await count(db,"lifestyle_days")).toBe(0);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"import_row_audit")).toBe(0);
    expect(await send(db,life)).toMatchObject({code:200,data:{status:"confirmed",inserted:3}});
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);

  it("ECLEAR cross-file identical fingerprint is skipped, new same-day reading is inserted and both audited",async()=>{
    const bigger=ec+"2026-01-02T20:00:00+09:00,72.8,23.1\n";
    expect(await send(db,ec,{source:"eclear"})).toMatchObject({code:200,data:{inserted:1}});
    expect(await send(db,bigger,{source:"eclear"})).toMatchObject({code:200,data:{
      inserted:1,skipped:1,conflicted:0,
    }});
    expect((await audit(db,"eclear",bigger)).map(x=>x.result)).toEqual(["skipped","inserted"]);
    expect(await count(db,"body_measurements")).toBe(2);
    expect(await count(db,"import_row_audit")).toBe(3);
  },100_000);

  it("owner-scoped rows: same day in another owner is not treated as a conflict",async()=>{
    await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?)")
      .bind("other","2026-01-01T00:00:00Z").run();
    const base=hdr+"2026-01-03,0,0,0\n",other=hdr+"2026-01-03,1,,\n";
    expect((await send(db,base)).code).toBe(200);
    expect(await send(db,other,{owner:"other"})).toMatchObject({code:200,data:{inserted:1}});
    const ownerRow=await db.prepare("SELECT drinking_presence FROM lifestyle_days WHERE owner_id=?")
      .bind("owner").first<{drinking_presence:number|null}>();
    const otherRow=await db.prepare("SELECT drinking_presence FROM lifestyle_days WHERE owner_id=?")
      .bind("other").first<{drinking_presence:number|null}>();
    expect([ownerRow?.drinking_presence,otherRow?.drinking_presence]).toEqual([0,1]);
    expect(await count(db,"import_row_audit")).toBe(2);
  },100_000);
});
