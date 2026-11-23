import { describe,it,expect } from "vitest";
import type { AiReadSnapshot, AiReadRows } from "../src/worker/ai-read-model";
import {
  HEADERS,READ_TABS,FakeSheets,prepareSheetSnapshot,readModelDigest,
  verifyReadSnapshot,buildAtomicBatch,publishFake,
  type Layout,type Tab
} from "../src/worker/ai-sheet-snapshot";

const tabNames:readonly Tab[]=[...READ_TABS,"Sync_Status","Meta"];
const DAY=86400000;
const utc="2026-11-23T02:00:00Z";
const dayAt=(i:number,n:number)=>new Date(
  Date.parse("2026-11-22T00:00:00Z")-(n-1-i)*DAY
).toISOString().slice(0,10);
const id=(prefix:string,i:number)=>prefix+":"+i.toString(16).padStart(16,"0");
const rev=(i:number)=>(i+10000).toString(16).padStart(16,"0");
const layout=(rows=1200):Layout=>Object.fromEntries(tabNames.map((name,i)=>[
  name,{sheetId:i+1,rowCapacity:rows,columnCapacity:20}
])) as Layout;
async function synthetic(days=30,gen="synthetic_g001",withWeight=false):Promise<AiReadSnapshot>{
  const rows:AiReadRows={
    Read_Weight:[],Read_Steps:[],Read_Meals:[],Read_Drinks:[],Read_DrinkDays:[]
  };
  for(let i=0;i<days;i++){
    const local_day=dayAt(i,days);
    rows.Read_Steps.push({generation_id:gen,record_key:id("steps",i),
      local_day,steps:i%2===0?0:null,source_type:i%2===0?"fit":"missing",
      source_priority:i%2===0?0:null,value_state:i%2===0?"present":"missing",
      revision:rev(i)});
    rows.Read_Meals.push({generation_id:gen,record_key:id("meals",i),
      local_day,lunch_kind:i===0?"home":null,
      lunch_value_state:i===0?"present":"missing",dinner_kind:null,
      dinner_value_state:"missing",late_meal:i===0?0:null,
      late_meal_value_state:i===0?"present":"missing",
      source_type:i===0?"manual":"missing",revision:rev(i+1000)});
    rows.Read_DrinkDays.push({generation_id:gen,record_key:id("drink_day",i),
      local_day,drinking_presence:i===0?0:null,drink_cups:i===0?0:null,
      drink_cups_value_state:i===0?"present":"missing",
      source_type:i===0?"manual":"missing",revision:rev(i+2000)});
  }
  const canonical_weight_keys:Record<string,string>={};
  if(withWeight){
    const local_day=dayAt(0,days),record_key=id("weight",1);
    rows.Read_Weight.push({generation_id:gen,record_key,
      local_day,measured_at_jst:local_day+"T08:00:00+09:00",
      weight_kg:68.3,source_type:"eclear",measurement_kind:"measured",
      value_state:"present",revision:rev(3000)});
    canonical_weight_keys[local_day]=record_key;
  }
  const counts=Object.fromEntries(READ_TABS.map(tab=>[tab,rows[tab].length])) as AiReadSnapshot["counts"];
  const s:AiReadSnapshot={
    contract_version:"ai-sheets-v1",generation_id:gen,
    generated_at_utc:utc,coverage_from_jst:dayAt(0,days),
    coverage_to_jst:dayAt(days-1,days),
    data_through_jst:dayAt(days-1,days),incomplete_day_jst:null,
    counts,generation_digest:"",warnings:[],canonical_weight_keys,rows
  };
  s.generation_digest=await readModelDigest(s);
  return s;
}
const fresh=async(days=30,gen="synthetic_g001",weight=false)=>
  prepareSheetSnapshot(await synthetic(days,gen,weight));

describe("Phase B2 offline fake Sheets snapshot publication / validation",()=>{
 it("B01: exact A1 header order, explicit zero/NULL, no Commands/Results, no owner PII",async()=>{
   const p=await fresh(30,"synthetic_g001",true);
   expect(Object.keys(p.workbook).sort()).toEqual([...tabNames].sort());
   for(const t of tabNames)expect(p.workbook[t][0]).toEqual(HEADERS[t]);
   expect(p.workbook.Read_DrinkDays[1][3]).toBe(0);
   expect(p.workbook.Read_DrinkDays[2][3]).toBeNull();
   expect(p.workbook.Read_Steps[1][3]).toBe(0);
   expect(p.workbook.Read_Steps[2][3]).toBeNull();
   expect(p.workbook.Read_Meals[1][7]).toBe(0);
   expect(p.workbook.Read_Meals[2][7]).toBeNull();
   expect(p.workbook.Read_Weight).toHaveLength(2);
   const text=JSON.stringify(p.workbook);
   expect(text).not.toContain("owner_id");
   expect(text).not.toContain("source_row_key");
   expect(text).not.toContain("Commands");
   expect(text).not.toContain("Results");
   expect(text).not.toContain("secret");
 });
 it("B02: single Google spreadsheets.batchUpdate shape is explicit typed RAW-equivalent values",async()=>{
   const p=await fresh(30);
   const b=buildAtomicBatch(p,layout());
   expect(b.body.requests).toHaveLength(7);
   expect(b.bytes).toBeLessThan(2_000_000);
   for(const req of b.body.requests){
     expect(req.updateCells.fields).toBe("userEnteredValue");
     expect(req.updateCells.range.endRowIndex).toBe(1200);
     const cell=req.updateCells.rows[0].values[0].userEnteredValue;
     expect(cell).toHaveProperty("stringValue");
   }
   expect(JSON.stringify(b.body)).not.toContain("formulaValue");
   expect(JSON.stringify(b.body)).not.toContain("valueInputOption");
   expect(b.body.requests.at(-1)?.updateCells.range.sheetId).toBe(layout().Meta.sheetId);
 });
 it("B03: prepared / read verified full B1 manifest, representative weight key",async()=>{
   const p=await fresh(30,"synthetic_g001",true);
   const fake=new FakeSheets();
   expect(await verifyReadSnapshot(fake)).toMatchObject({consistency:"unverified",
     authority:"sheet-copy-only"});
   expect(await publishFake(fake,p,layout())).toBe("published");
   const result=await verifyReadSnapshot(fake);
   expect(result).toMatchObject({consistency:"consistent",
     reason:"INTERNAL_CONSISTENCY_ONLY",generation_id:p.generation_id,
     authority:"sheet-copy-only"});
   const meta=await fake.readMeta();
   expect(meta.some(row=>row[0]==="canonical_weight_keys_json"&&
     (row[1] as string).includes("weight:"))).toBe(true);
   expect(await publishFake(fake,p,layout())).toBe("already");
   expect(fake.committedCount).toBe(1);
 });
 it("B04: source metadata digest tampering, missing row, partial tab, wrong width, dup key fail closed",async()=>{
   const p=await fresh(30);
   const fake=new FakeSheets();
   await publishFake(fake,p,layout());
   fake.tamperActive("Read_Steps",1,3,98765);
   expect((await verifyReadSnapshot(fake)).consistency).toBe("unverified");
   expect(await publishFake(fake,p,layout())).toBe("rejected"); // do not rewrite a tampered active gen
   const p2=await fresh(30,"synthetic_g002");
   await publishFake(fake,p2,layout());
   fake.tamperActive("Read_Meals",0,0,"WRONG_HEADER");
   expect((await verifyReadSnapshot(fake)).consistency).toBe("unverified");
   const p3=await fresh(30,"synthetic_g003");
   await publishFake(fake,p3,layout());
   fake.tamperActive("Read_DrinkDays",2,1,p3.workbook.Read_DrinkDays[1][1]);
   expect((await verifyReadSnapshot(fake)).reason).toBe("DUPLICATE_RECORD_KEY");
 });
 it("B05: malformed/meta pointer/partial generation rejected; no false fresh or D1 authority",async()=>{
   const p=await fresh(30),fake=new FakeSheets();
   await fake.publishAtomic(p,layout());
   // contract_version row is 1, active_generation row is 2
   fake.tamperActive("Meta",1,1,"wrong-schema");
   expect((await verifyReadSnapshot(fake)).reason).toBe("INVALID_ACTIVE_GENERATION");
   const p2=await fresh(30,"synthetic_g002");
   await fake.publishAtomic(p2,layout());
   fake.tamperActive("Meta",2,1,"another_g999");
   expect((await verifyReadSnapshot(fake)).consistency).toBe("unverified");
 });
 it("B06: collaborator switches metadata between two reads => torn snapshot rejected",async()=>{
   const p=await fresh(30),fake=new FakeSheets();
   await fake.publishAtomic(p,layout());
   fake.onFirstMetaRead(()=>fake.tamperActive("Meta",2,1,"collaborator_002"));
   expect((await verifyReadSnapshot(fake)).reason).toBe("CONCURRENT_META_CHANGE");
 });
 it("B07: 403, 429, 503, response-loss simulated; no accidental extra active generation",async()=>{
   const old=await fresh(30),next=await fresh(30,"synthetic_g002");
   for(const code of [403,429,503] as const){
     const fake=new FakeSheets();
     await fake.publishAtomic(old,layout());
     fake.injectFailure({operation:"atomic",code});
     expect(await publishFake(fake,next,layout())).toBe(code===403?"rejected":"unknown");
     expect(fake.activeGeneration).toBe(old.generation_id);
     expect(fake.committedCount).toBe(1);
   }
   const fake=new FakeSheets();
   await fake.publishAtomic(old,layout());
   fake.injectFailure({operation:"atomic",code:"timeout",afterApply:true});
   expect(await publishFake(fake,next,layout())).toBe("unknown");
   expect(fake.activeGeneration).toBe(next.generation_id);
   expect((await verifyReadSnapshot(fake)).consistency).toBe("consistent");
   expect(await publishFake(fake,next,layout())).toBe("already");
 });
 it("B08: staged partial failure retains old generation and retries bounded without append duplication",async()=>{
   const fake=new FakeSheets();
   const old=await fresh(30),next=await fresh(90,"synthetic_g002");
   await fake.publishAtomic(old,layout());
   fake.injectFailure({operation:"stage",code:429,tab:"Read_Steps",afterApply:true});
   await expect(fake.publishStaged(next,1600)).rejects.toThrow("SHEETS_HTTP_429");
   expect(fake.activeGeneration).toBe(old.generation_id);
   expect(fake.stagedCount).toBe(1);
   expect((await verifyReadSnapshot(fake)).generation_id).toBe(old.generation_id);
   await fake.publishStaged(next,1600);
   expect(fake.activeGeneration).toBe(next.generation_id);
   expect(fake.stagedCount).toBe(0);
   expect((await verifyReadSnapshot(fake)).consistency).toBe("consistent");
   const third=await fresh(30,"synthetic_g003");
   await fake.publishAtomic(third,layout());
   expect(fake.committedCount).toBe(2);
 });
 it("B09: fail closed on formula-leading text, invalid keys and forged digest",async()=>{
   const s=await synthetic(30);
   s.rows.Read_Meals[0].lunch_kind="=IMPORTXML(\"evil\",\"//a\")";
   s.rows.Read_Meals[0].lunch_value_state="present";
   s.generation_digest=await readModelDigest(s);
   await expect(prepareSheetSnapshot(s)).rejects.toThrow("UNSAFE_SHEET_TEXT");
   const changed=await synthetic(30);
   changed.rows.Read_Steps[0].record_key="steps:RAW_OWNER_PRIVATE";
   changed.generation_digest=await readModelDigest(changed);
   await expect(prepareSheetSnapshot(changed)).rejects.toThrow("INVALID_RECORD_KEY");
   const forged=await synthetic(30);
   forged.rows.Read_Steps[1].steps=99;
   await expect(prepareSheetSnapshot(forged)).rejects.toThrow("SOURCE_DIGEST_MISMATCH");
 });
 it("B10: 30, 90, 366 day synthetic sizes and CPU timing are only local estimates",async()=>{
   for(const n of [30,90,366]){
     const s=await synthetic(n,"synthetic_g001",true);
     const start=performance.now();
     const p=await prepareSheetSnapshot(s);
     const shape=buildAtomicBatch(p,layout(1000));
     const wallMs=Number((performance.now()-start).toFixed(2));
     expect(p.workbook.Read_Steps).toHaveLength(n+1);
     expect(p.workbook.Read_DrinkDays).toHaveLength(n+1);
     expect(shape.bytes).toBeLessThan(2_000_000);
     expect(wallMs).toBeGreaterThanOrEqual(0);
     console.info("B2 synthetic estimate (NOT Workers Free CPU):",JSON.stringify({
       days:n,rawBytes:p.bytes,googleBatchBytes:shape.bytes,
       localWallMs:wallMs
     }));
   }
 });
 it("B11: reject unusable Google layout/oversized batch; staged simulation is not external API proof",async()=>{
   const p=await fresh(30);
   const bad=layout(5);
   expect(()=>buildAtomicBatch(p,bad)).toThrow("INVALID_SHEET_LAYOUT");
   expect(()=>buildAtomicBatch(p,layout(),100)).toThrow("RECOMMENDED_PAYLOAD_LIMIT");
   const fake=new FakeSheets();
   expect(await publishFake(fake,p,layout(),"atomic",100)).toBe("rejected");
   expect(fake.activeGeneration).toBeNull();
   expect(await publishFake(fake,p,layout(),"staged",1500)).toBe("published");
 });
 it("B12: late mutation after an accepted generation cannot be treated as a verified copy",async()=>{
   const p=await fresh(30),fake=new FakeSheets();
   await fake.publishAtomic(p,layout());
   fake.tamperActive("Read_Steps",1,1,"steps:000000000000000f");
   expect((await verifyReadSnapshot(fake)).consistency).toBe("unverified");
 });
 it("B13: source warning and canonical map modification requires new B1 digest",async()=>{
   const s=await synthetic(30,"synthetic_g001",true);
   const initial=await readModelDigest(s);
   s.canonical_weight_keys[dayAt(0,30)]="weight:000000000000000f";
   expect(await readModelDigest(s)).not.toBe(initial);
   await expect(prepareSheetSnapshot(s)).rejects.toThrow("INVALID_CANONICAL_WEIGHT_KEY");
   const sw=await synthetic(30);
   sw.warnings.push("DRINK_DAY_CONFLICT:2026-11-22");
   await expect(prepareSheetSnapshot(sw)).rejects.toThrow("SOURCE_DIGEST_MISMATCH");
 });

 it("B14: consistent does not imply fresh; stale claimed generation is rejected using a trusted clock",async()=>{
   const p=await fresh(30),fake=new FakeSheets();
   await fake.publishAtomic(p,layout());
   const unknownTime=await verifyReadSnapshot(fake);
   expect(unknownTime).toMatchObject({consistency:"consistent",freshness:"not_checked"});
   const freshTime=await verifyReadSnapshot(fake,"2026-11-23T02:30:00Z");
   expect(freshTime).toMatchObject({consistency:"consistent",freshness:"claimed_fresh"});
   const stale=await verifyReadSnapshot(fake,"2026-11-26T02:00:00Z");
   expect(stale).toMatchObject({consistency:"unverified",freshness:"stale",reason:"STALE_SNAPSHOT"});
   expect((await verifyReadSnapshot(fake,"2026-11-22T00:00:00Z")).reason)
     .toBe("INVALID_FRESHNESS_REFERENCE");
 });
 it("B15: staged failure storms retain no more than two in-flight generations",async()=>{
   const fake=new FakeSheets();
   for(const g of ["synthetic_g001","synthetic_g002","synthetic_g003"]){
     const p=await fresh(30,g);
     fake.injectFailure({operation:"stage",code:503,tab:"Read_Steps",afterApply:true});
     await expect(fake.publishStaged(p,1600)).rejects.toThrow("SHEETS_HTTP_503");
     expect(fake.stagedCount).toBeLessThanOrEqual(2);
   }
   expect(fake.activeGeneration).toBeNull();
 });

 it("B16: same generation ID with different valid snapshot digest is rejected, never already",async()=>{
   const first=await fresh(30,"synthetic_g001");
   const changed=await fresh(31,"synthetic_g001");
   const fake=new FakeSheets();
   expect(await publishFake(fake,first,layout())).toBe("published");
   expect(await publishFake(fake,changed,layout())).toBe("rejected");
   expect(fake.activeGeneration).toBe(first.generation_id);
   expect(fake.committedCount).toBe(1);
   expect((await verifyReadSnapshot(fake)).generation_digest).toBe(first.source_digest);
 });
 it("B17: missing calendar day from B1 daily tabs is incomplete, not recorded abstinence",async()=>{
   const s=await synthetic(30);
   s.rows.Read_DrinkDays.splice(5,1);
   s.counts.Read_DrinkDays=s.rows.Read_DrinkDays.length;
   s.generation_digest=await readModelDigest(s);
   await expect(prepareSheetSnapshot(s)).rejects.toThrow("INCOMPLETE_DAY_COVERAGE:Read_DrinkDays");
   const missing=await synthetic(30);
   missing.rows.Read_Steps.splice(2,1);
   missing.counts.Read_Steps=missing.rows.Read_Steps.length;
   missing.generation_digest=await readModelDigest(missing);
   await expect(prepareSheetSnapshot(missing)).rejects.toThrow("INCOMPLETE_DAY_COVERAGE:Read_Steps");
 });
});
