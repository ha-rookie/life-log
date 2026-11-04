import { describe, expect, it, vi } from "vitest";
import { csvSha256, previewCsv } from "../src/shared/csv-import";
import { createHandler, type Env } from "../src/worker/index";
import type { BoundStatement, ImportDatabase } from "../src/worker/import";

const L = "日付,歩数,体重_kg,飲酒\n2026-01-02,,72.4,1\n2026-01-03,0,,0";
const E = "年月日,時刻,体重,体脂肪率,骨格筋率\n2026-01-02,08:00,71.8,21.0,30.0\n2026-01-02,20:00,72.0,20.9,29.8";

type Values = unknown[];
type State = {
  jobs: Map<string,{status:string}>;
  days: Map<string,{drinking_presence:number|null;drink_cups:number|null;steps:number|null}>;
  bodies: Map<string,{weight_kg:number|null;body_fat_pct:number|null;skeletal_muscle_pct:number|null}>;
  audit: number;
};
const empty = (): State => ({jobs:new Map(),days:new Map(),bodies:new Map(),audit:0});
const copy = (x:State):State => ({
  jobs:new Map(x.jobs),days:new Map(x.days),bodies:new Map(x.bodies),audit:x.audit
});
const key = (...values:unknown[]) => JSON.stringify(values);
type TestBound = BoundStatement & { sql:string; values:Values };

class FakeD1 implements ImportDatabase {
  public state = empty();
  public touched=0;
  public failAfter = 0;
  prepare(sql:string) {
    return { bind: (...values:Values): TestBound => ({
      sql, values,
      first: async <T>():Promise<T|null> => {
        this.touched++;
        let result:unknown = null;
        if (sql.startsWith("SELECT status FROM import_jobs"))
          result = this.state.jobs.get(key(...values)) ?? null;
        else if (sql.startsWith("SELECT drinking_presence"))
          result = this.state.days.get(key(...values)) ?? null;
        else if (sql.startsWith("SELECT weight_kg"))
          result = this.state.bodies.get(key(...values)) ?? null;
        return (result ?? null) as T|null;
      },
    })};
  }
  async batch(statements: BoundStatement[]):Promise<unknown[]> {
    this.touched++;
    const next=copy(this.state);
    for(const [i,item] of statements.entries()){
      if(this.failAfter && i+1>=this.failAfter) throw new Error("synthetic mid-batch failure");
      const s=item as TestBound, v=s.values, q=s.sql;
      if(q.startsWith("INSERT INTO import_jobs")){
        const jobKey=key(v[1],v[2],v[4]);
        if(next.jobs.has(jobKey)) throw new Error("duplicate job");
        next.jobs.set(jobKey,{status:"confirmed"});
      } else if(q.startsWith("INSERT INTO lifestyle_days")){
        const k=key(v[0],v[1],v[5]);
        if(next.days.has(k)) throw new Error("duplicate day");
        next.days.set(k,{drinking_presence:v[2] as number|null,drink_cups:v[3] as number|null,steps:v[4] as number|null});
      } else if(q.startsWith("INSERT INTO body_measurements")){
        const src=q.includes("reliable_fingerprint")?v[6]:v[4];
        const rowkey=q.includes("reliable_fingerprint")?v[7]:v[5];
        const k=key(v[1],src,rowkey);
        if(next.bodies.has(k)) throw new Error("duplicate body");
        next.bodies.set(k,{weight_kg:v[3] as number|null,
          body_fat_pct:(q.includes("reliable_fingerprint")?v[4]:null) as number|null,
          skeletal_muscle_pct:(q.includes("reliable_fingerprint")?v[5]:null) as number|null});
      } else if(q.startsWith("INSERT INTO import_row_audit")) next.audit++;
    }
    this.state=next; // Atomic: commit only after all statements succeed.
    return statements.map(()=>({success:true}));
  }
}
function env(db:FakeD1,enabled="true"):Env{
  return {DB:db,IMPORT_LOCAL_ONLY:enabled,ASSETS:{fetch:vi.fn(async()=>new Response("private"))}};
}
async function send(csv:string,opts:{kind?:"lifestyle"|"eclear";confirm?:boolean;hash?:string;origin?:string;url?:string;site?:string}={}){
  const url=opts.url??"http://127.0.0.1:8787/api/import/confirm";
  const headers:Record<string,string>={"Content-Type":"application/json",Origin:opts.origin??new URL(url).origin};
  if(opts.site)headers["Sec-Fetch-Site"]=opts.site;
  return new Request(url,{method:"POST",headers,
    body:JSON.stringify({csv,hash:opts.hash??await csvSha256(csv),kind:opts.kind??previewCsv(csv).kind,confirm:opts.confirm??true})});
}
describe("local-only confirmed import / D1 batch atomicity",()=>{
  it("preview alone never calls DB and confirmation persists nullable values with audit",async()=>{
    const db=new FakeD1();
    expect(previewCsv(L).errors).toEqual([]);
    expect(db.touched).toBe(0);
    const res=await createHandler(async()=> "owner").fetch(await send(L),env(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({kind:"lifestyle",inserted:2,skipped:0,replay:false});
    expect(db.state.days.get(key("owner","2026-01-02","lifestyle"))).toEqual({drinking_presence:1,drink_cups:null,steps:null});
    expect(db.state.days.get(key("owner","2026-01-03","lifestyle"))).toEqual({drinking_presence:0,drink_cups:0,steps:0});
    expect(db.state.bodies.size).toBe(1);
    expect(db.state.audit).toBe(2);
  });
  it("replay of same file skips all, different file overlap skips identical and inserts only new",async()=>{
    const db=new FakeD1(), handler=createHandler(async()=> "owner");
    expect((await handler.fetch(await send(L),env(db))).status).toBe(200);
    const replay=await handler.fetch(await send(L),env(db));
    expect(await replay.json()).toMatchObject({inserted:0,skipped:2,replay:true});
    const more="日付,歩数,体重_kg,飲酒\n2026-01-02,,72.4,1\n2026-01-04,1500,,1";
    const added=await handler.fetch(await send(more),env(db));
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({inserted:1,skipped:1,replay:false});
    expect(db.state.days.size).toBe(3);
    expect(db.state.audit).toBe(4);
  });
  it("conflicting same-day values abort entire different-file import",async()=>{
    const db=new FakeD1(),handler=createHandler(async()=> "owner");
    await handler.fetch(await send(L),env(db));
    const before=db.state.audit;
    const conflict="日付,歩数,体重_kg,飲酒\n2026-01-04,12,,0\n2026-01-02,100,72.4,1";
    const res=await handler.fetch(await send(conflict),env(db));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("EXISTING_CONFLICT");
    expect(db.state.days.size).toBe(2);
    expect(db.state.audit).toBe(before);
  });
  it("ECLEAR preserves different times on same date; cross-file exact times are skipped",async()=>{
    const db=new FakeD1(),handler=createHandler(async()=> "owner");
    const first=await handler.fetch(await send(E),env(db));
    expect(first.status).toBe(200);
    expect(db.state.bodies.size).toBe(2);
    const more="年月日,時刻,体重,体脂肪率,骨格筋率\n2026-01-02,08:00,71.8,21.0,30.0\n2026-01-02,21:00,72.1,21.1,30.1";
    const second=await handler.fetch(await send(more),env(db));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({inserted:1,skipped:1});
    expect(db.state.bodies.size).toBe(3);
    const mismatch="年月日,時刻,体重,体脂肪率,骨格筋率\n2026-01-02,08:00,90.0,21.0,30.0";
    expect((await handler.fetch(await send(mismatch),env(db))).status).toBe(409);
    expect(db.state.bodies.size).toBe(3);
  });
  it("invalid rows, file mutation and malformed confirmation never touch DB",async()=>{
    const db=new FakeD1(),handler=createHandler(async()=> "owner");
    const invalid="日付,歩数,飲酒\n2026-01-02,0,0\n2026-02-30,1,1";
    const failed=await handler.fetch(await send(invalid),env(db));
    expect(failed.status).toBe(422);
    expect((await failed.json()).error).toBe("INVALID_ROWS");
    expect(db.touched).toBe(0);
    const changed=await handler.fetch(await send(L,{hash:"a".repeat(64)}),env(db));
    expect(changed.status).toBe(422);
    expect(db.touched).toBe(0);
    const unconfirmed=await handler.fetch(await send(L,{confirm:false}),env(db));
    expect(unconfirmed.status).toBe(400);
    expect(db.touched).toBe(0);
  });
  it("rejects unauthenticated, disabled remote, different origin, cross-site request without DB access",async()=>{
    const db=new FakeD1();
    expect((await createHandler(async()=>null).fetch(await send(L),env(db))).status).toBe(403);
    const handler=createHandler(async()=> "owner");
    expect((await handler.fetch(await send(L),env(db,""))).status).toBe(403);
    expect((await handler.fetch(await send(L,{url:"https://example.invalid/api/import/confirm"}),env(db))).status).toBe(403);
    expect((await handler.fetch(await send(L,{origin:"http://evil.invalid"}),env(db))).status).toBe(403);
    expect((await handler.fetch(await send(L,{site:"cross-site"}),env(db))).status).toBe(403);
    expect(db.touched).toBe(0);
  });
  it("simulated mid-batch failure cannot partially commit and never exposes SQL errors",async()=>{
    const db=new FakeD1();db.failAfter=4;
    const res=await createHandler(async()=> "owner").fetch(await send(L),env(db));
    expect(res.status).toBe(409);
    const body=await res.text();
    expect(body).toContain("ATOMIC_IMPORT_RETRY");
    expect(body).not.toContain("synthetic mid-batch failure");
    expect(db.state.jobs.size).toBe(0);
    expect(db.state.days.size).toBe(0);
    expect(db.state.bodies.size).toBe(0);
    expect(db.state.audit).toBe(0);
  });
});
