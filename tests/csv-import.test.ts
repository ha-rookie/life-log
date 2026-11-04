import {describe,it,expect} from "vitest";
import {previewCsv,hash} from "../src/shared/csv-import";
import {handleImport,type ImportDb,type Statement} from "../src/worker/import";
const life="local_day,drinking_presence,drink_cups,steps\n2026-01-02,1,,\n2026-01-03,0,0,0\n2026-01-04,,,\n";
const eclear="measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,72.2,22.5\n";
function request(path:string,body:unknown){return new Request("https://example.invalid/api/import/"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
function fake(){
  const jobs=new Map<string,string>(),seen=new Set<string>(),calls:string[]=[],state={fail:false,failAt:-1};
  const db:ImportDb={prepare(sql:string){
    calls.push(sql);
    const q:{sql:string;args:unknown[];bind:(...v:unknown[])=>Statement;first:<T>()=>Promise<T|null>}={
      sql,args:[],bind(...v:unknown[]){this.args=v;return this;},
      async first<T>(){if(sql.startsWith("SELECT status"))return (jobs.has(String(this.args[2]))?{status:"confirmed"}:null) as T|null;return null;}
    };return q;
  },async batch(statements:Statement[]){
    if(state.fail)throw Error("synthetic failure");
    const results:unknown[]=[],staged=new Set(seen);
    for(let i=0;i<statements.length;i++){
      if(i===state.failAt)throw Error("synthetic partial batch failure");
      const q=statements[i] as unknown as {sql:string;args:unknown[]};
      let changes=1;
      if(q.sql.includes("INSERT OR IGNORE INTO body_measurements")){const key=String(q.args[8]);if(staged.has(key))changes=0;else staged.add(key);}
      if(q.sql.includes("INSERT OR IGNORE INTO lifestyle_days")){const key=String(q.args[1])+":"+String(q.args[5]);if(staged.has(key))changes=0;else staged.add(key);}
      results.push({meta:{changes}});
    }
    const job=statements[1] as unknown as {args:unknown[]};for(const key of staged)seen.add(key);jobs.set(String(job.args[4]),"confirmed");return results;
  }};
  return {db,calls,jobs,seen,state};
}
describe("synthetic CSV preview",()=>{
  it("distinguishes missing from explicit zero and keeps provenance",async()=>{
    const p=await previewCsv("lifestyle",life);
    expect(p.errors).toEqual([]);expect(p.rows).toHaveLength(3);
    expect([p.rows[0].presence,p.rows[0].cups,p.rows[0].steps]).toEqual([1,null,null]);
    expect([p.rows[1].presence,p.rows[1].cups,p.rows[1].steps]).toEqual([0,0,0]);
    expect([p.rows[2].presence,p.rows[2].cups,p.rows[2].steps]).toEqual([null,null,null]);
    expect(p.rows[0].key).toContain(p.hash);
  });
  it("rejects invalid headers, quotes and oversize",async()=>{
    await expect(previewCsv("eclear","wrong,header\nx,y")).rejects.toThrow();
    await expect(previewCsv("eclear",'measured_at,weight_kg,body_fat_pct\n"oops,72,20')).rejects.toThrow();
    await expect(previewCsv("eclear","x".repeat(65537))).rejects.toThrow();
  });
  it("reports malformed rows rather than guessing numbers",async()=>{
    const p=await previewCsv("lifestyle",life+"2026-02-30,1,0,3\n2026-01-05,,0,0\n2026-01-06,0,,\n");
    expect(p.errors).toHaveLength(3);
  });
  it("detects reliable cross-file duplicate despite row/key differences",async()=>{
    const a=await previewCsv("eclear",eclear);
    const b=await previewCsv("eclear",eclear+"2026-01-04T07:00:00+09:00,73,21\n");
    expect(a.hash).not.toBe(b.hash);expect(a.rows[0].fingerprint).toBe(b.rows[0].fingerprint);
    expect(await hash(eclear)).toBe(a.hash);
  });
});
describe("explicit confirmed import",()=>{
  it("preview performs zero D1 operations",async()=>{
    const f=fake();const r=await handleImport(request("preview",{source:"lifestyle",csv:life}),f.db,"owner");
    expect(r.status).toBe(200);expect(f.calls).toHaveLength(0);
  });
  it("requires explicit confirmation and matching content hash",async()=>{
    const f=fake();for(const x of [{source:"lifestyle",csv:life,confirmed:true,hash:"bad"},{source:"lifestyle",csv:life,confirmed:false,hash:await hash(life)}]){
      const r=await handleImport(request("confirm",x),f.db,"owner");expect(r.status).toBe(409);
    }expect(f.calls).toHaveLength(0);
  });
  it("commits once and skips exact file replay",async()=>{
    const f=fake(),body={source:"lifestyle",csv:life,hash:await hash(life),confirmed:true};
    const first=await handleImport(request("confirm",body),f.db,"owner");
    expect(first.status).toBe(200);expect(await first.json()).toMatchObject({status:"confirmed",inserted:3});
    const again=await handleImport(request("confirm",body),f.db,"owner");
    expect(await again.json()).toMatchObject({status:"already_imported",inserted:0,skipped:3});
    expect(f.jobs.size).toBe(1);
  });
  it("rejects invalid rows and duplicate natural keys before DB reads",async()=>{
    const f=fake(),bad=life+"2026-01-05,0,,\n",dupe=life+"2026-01-02,1,,\n";
    for(const csv of [bad,dupe]){const r=await handleImport(request("confirm",{source:"lifestyle",csv,hash:await hash(csv),confirmed:true}),f.db,"owner");expect(r.status).toBe(422);}
    expect(f.calls).toHaveLength(0);
  });
  it("fails closed on SQL failure without committed job/rows",async()=>{
    const f=fake();f.state.fail=true;const r=await handleImport(request("confirm",{source:"eclear",csv:eclear,hash:await hash(eclear),confirmed:true}),f.db,"owner");
    expect(r.status).toBe(503);expect(f.jobs.size).toBe(0);expect(f.seen.size).toBe(0);
  });
  it("rolls back a mid-batch failure, then succeeds on a clean retry",async()=>{
    const f=fake(),body={source:"lifestyle",csv:life,hash:await hash(life),confirmed:true};
    f.state.failAt=4;
    const failed=await handleImport(request("confirm",body),f.db,"owner");
    expect(failed.status).toBe(503);expect(f.jobs.size).toBe(0);expect(f.seen.size).toBe(0);
    f.state.failAt=-1;
    const retry=await handleImport(request("confirm",body),f.db,"owner");
    expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({inserted:3,skipped:0});
  });
  it("does not interpolate CSV into SQL",async()=>{
    const f=fake(),csv=life.replace("2026-01-02","2026-01-02");
    await handleImport(request("confirm",{source:"lifestyle",csv,hash:await hash(csv),confirmed:true}),f.db,"owner");
    expect(f.calls.every(s=>!s.includes("2026-01-02"))).toBe(true);
  });
});
