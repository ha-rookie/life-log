/**
 * Phase B2: OFFLINE Google Sheets snapshot contract, publisher and verifier.
 * No network, Cloudflare binding, Google credential, public route or D1 write.
 * A Sheet-controlled hash is a consistency check, NOT proof of D1 authenticity.
 */
import type { AiReadSnapshot, AiReadRows } from "./ai-read-model";

export const READ_TABS = [
  "Read_Weight","Read_Steps","Read_Meals","Read_Drinks","Read_DrinkDays"
] as const;
export type ReadTab = typeof READ_TABS[number];
export type Tab = ReadTab|"Sync_Status"|"Meta";
export type Cell = string|number|null;
export type Matrix = Cell[][];
export type Workbook = Record<Tab,Matrix>;

export const HEADERS:Record<Tab,readonly string[]> = {
  Read_Weight:["generation_id","record_key","local_day","measured_at_jst","weight_kg",
    "source_type","measurement_kind","value_state","revision"],
  Read_Steps:["generation_id","record_key","local_day","steps","source_type",
    "source_priority","value_state","revision"],
  Read_Meals:["generation_id","record_key","local_day","lunch_kind","lunch_value_state",
    "dinner_kind","dinner_value_state","late_meal","late_meal_value_state",
    "source_type","revision"],
  Read_Drinks:["generation_id","record_key","observed_at_jst","drink_kind","cups",
    "pure_alcohol_g","alcohol_value_kind","source_type","value_state","revision"],
  Read_DrinkDays:["generation_id","record_key","local_day","drinking_presence","drink_cups",
    "drink_cups_value_state","source_type","revision"],
  Sync_Status:["component","last_attempt_at_utc","last_success_at_utc","active_generation",
    "data_through_jst","status","pending_count","failed_count","error_code"],
  Meta:["key","value","updated_at_utc"]
};
const TABS:readonly Tab[]=[...READ_TABS,"Sync_Status","Meta"];
const MAX_ROWS=10001;
const MAX_CELL_BYTES=256;
const DEFAULT_BYTES=2_000_000;
/**
 * These are additive KEY ROWS, not new A1 columns. Without them the B1 SHA-256
 * manifest (including canonical weight representative map) cannot be reverified.
 * This key extension requires Human acceptance before any real Sheets activation.
 */
const META_KEYS=[
  "contract_version","active_generation","generated_at_utc","data_through_jst",
  "expected_counts_json","generation_digest","retention_from_jst","publication_state",
  "coverage_to_jst","incomplete_day_jst","canonical_weight_keys_json","warnings_json"
] as const;
const NUMERIC:Partial<Record<ReadTab,readonly string[]>>={
  Read_Weight:["weight_kg"],
  Read_Steps:["steps","source_priority"],
  Read_Meals:["late_meal"],
  Read_Drinks:["cups","pure_alcohol_g"],
  Read_DrinkDays:["drinking_presence","drink_cups"]
};
const NULLABLE:Partial<Record<ReadTab,readonly string[]>>={
  Read_Steps:["steps","source_priority"],
  Read_Meals:["lunch_kind","dinner_kind","late_meal"],
  Read_Drinks:["pure_alcohol_g"],
  Read_DrinkDays:["drinking_presence","drink_cups"]
};
const enc=new TextEncoder();
const clone=<T>(a:T):T=>JSON.parse(JSON.stringify(a)) as T;
const bytes=(a:unknown)=>enc.encode(JSON.stringify(a)).byteLength;
const safe=(v:Cell,extended=false):Cell=>{
  if(v===null)return null;
  if(typeof v==="number"){
    if(!Number.isFinite(v))throw Error("INVALID_CELL_NUMBER");
    return v;
  }
  if(typeof v!=="string"||enc.encode(v).byteLength>(extended?90_000:MAX_CELL_BYTES)||
     /[\u0000-\u001f\u007f]/u.test(v)||/^\s*[=+@-]/u.test(v))
    throw Error("UNSAFE_SHEET_TEXT");
  return v;
};
const digest=async(value:unknown):Promise<string>=>{
  const b=await crypto.subtle.digest("SHA-256",enc.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,"0")).join("");
};
/** Exactly mirrors the B1 digest's canonical property order (not an auth token). */
export async function readModelDigest(s:AiReadSnapshot):Promise<string>{
  return digest({
    contract_version:s.contract_version,generation_id:s.generation_id,
    generated_at_utc:s.generated_at_utc,coverage_from_jst:s.coverage_from_jst,
    coverage_to_jst:s.coverage_to_jst,data_through_jst:s.data_through_jst,
    incomplete_day_jst:s.incomplete_day_jst,counts:s.counts,
    canonical_weight_keys:s.canonical_weight_keys,warnings:s.warnings,rows:s.rows
  });
}
function assertRowShape(tab:ReadTab,row:Record<string,unknown>,generation:string):void{
  const header=HEADERS[tab];
  if(Object.keys(row).length!==header.length||
    header.some(k=>!Object.prototype.hasOwnProperty.call(row,k)))throw Error("UNKNOWN_ROW_SCHEMA");
  if(row.generation_id!==generation)throw Error("MIXED_GENERATION");
  if(typeof row.record_key!=="string"||
    !/^(weight|steps|meals|drink|drink_day):[0-9a-f]{16}$/u.test(row.record_key))
    throw Error("INVALID_RECORD_KEY");
  if(typeof row.revision!=="string"||!/^[0-9a-f]{16}$/u.test(row.revision))
    throw Error("INVALID_REVISION");
  for(const k of header){
    const value=row[k];
    const isNull=(NULLABLE[tab]??[]).includes(k);
    const isNum=(NUMERIC[tab]??[]).includes(k);
    if(value===null){
      if(!isNull)throw Error("INVALID_NULL_CELL");
    }else if(isNum){
      if(typeof value!=="number"||!Number.isFinite(value))throw Error("INVALID_NUMERIC_CELL");
    }else{
      if(typeof value!=="string"||!value)throw Error("INVALID_STRING_CELL");
    }
    safe(value as Cell);
  }
  const day=tab==="Read_Drinks"?row.observed_at_jst:row.local_day;
  if(typeof day!=="string"||!/^\d{4}-\d{2}-\d{2}/u.test(day))
    throw Error("INVALID_ROW_DAY");
}
function validateSource(s:AiReadSnapshot):void{
  if(s.contract_version!=="ai-sheets-v1"||!/^[a-zA-Z0-9_-]{8,80}$/u.test(s.generation_id)||
     !/^\d{4}-\d{2}-\d{2}T/u.test(s.generated_at_utc)||
     s.coverage_to_jst<s.coverage_from_jst)throw Error("INVALID_SOURCE_MANIFEST");
  for(const tab of READ_TABS){
    const rows=s.rows[tab];
    if(!Array.isArray(rows)||rows.length>=MAX_ROWS||s.counts[tab]!==rows.length)
      throw Error("INVALID_SOURCE_COUNTS");
    const ids=new Set<string>();
    for(const row of rows){
      assertRowShape(tab,row as unknown as Record<string,unknown>,s.generation_id);
      if(ids.has(row.record_key))throw Error("DUPLICATE_RECORD_KEY");
      ids.add(row.record_key);
    }
  }
  const refs=new Map(s.rows.Read_Weight.map(w=>[w.record_key,w.local_day]));
  for(const [day,key] of Object.entries(s.canonical_weight_keys)){
    if(refs.get(key)!==day)throw Error("INVALID_CANONICAL_WEIGHT_KEY");
  }
  if(s.warnings.length>MAX_ROWS||s.warnings.some(w=>typeof w!=="string"||w.length>MAX_CELL_BYTES))
    throw Error("INVALID_WARNINGS");
}

function encodeTable<T extends ReadTab>(s:AiReadSnapshot,tab:T):Matrix{
  const header=HEADERS[tab];
  return [ [...header],...s.rows[tab].map(row=>
    header.map(k=>{
      const value=(row as unknown as Record<string,unknown>)[k];
      return value===null?null:safe(value as Cell);
    })
  ) ];
}
function metaTable(s:AiReadSnapshot):Matrix{
  const dict:Record<typeof META_KEYS[number],string>={
    contract_version:s.contract_version,active_generation:s.generation_id,
    generated_at_utc:s.generated_at_utc,data_through_jst:s.data_through_jst??"",
    expected_counts_json:JSON.stringify(s.counts),
    generation_digest:s.generation_digest,retention_from_jst:s.coverage_from_jst,
    publication_state:"active",coverage_to_jst:s.coverage_to_jst,
    incomplete_day_jst:s.incomplete_day_jst??"",
    canonical_weight_keys_json:JSON.stringify(s.canonical_weight_keys),
    warnings_json:JSON.stringify(s.warnings)
  };
  return [[...HEADERS.Meta],...META_KEYS.map(k=>
    [k,safe(dict[k],true),s.generated_at_utc]
  )];
}
export type Prepared = {
  generation_id:string; workbook:Workbook; bytes:number; source_digest:string;
};
export async function prepareSheetSnapshot(s:AiReadSnapshot):Promise<Prepared>{
  validateSource(s);
  if((await readModelDigest(s))!==s.generation_digest)throw Error("SOURCE_DIGEST_MISMATCH");
  const wb={} as Workbook;
  for(const tab of READ_TABS)wb[tab]=encodeTable(s,tab);
  wb.Sync_Status=[
    [...HEADERS.Sync_Status],
    ["read",s.generated_at_utc,s.generated_at_utc,s.generation_id,
      s.data_through_jst??"","success",0,0,""]
  ];
  wb.Meta=metaTable(s);
  return {generation_id:s.generation_id,workbook:wb,
    bytes:bytes(wb),source_digest:s.generation_digest};
}
/** Explicit stringValue/numberValue, never formulaValue or USER_ENTERED. */
type GoogleValue={stringValue?:string;numberValue?:number};
type GoogleUpdateCells={
  updateCells:{
    range:{sheetId:number;startRowIndex:number;endRowIndex:number;
      startColumnIndex:number;endColumnIndex:number};
    rows:{values:{userEnteredValue?:GoogleValue}[]}[];
    fields:"userEnteredValue";
  }
};
export type AtomicBatch={requests:GoogleUpdateCells[]};
export type Layout=Record<Tab,{sheetId:number;rowCapacity:number;columnCapacity:number}>;
const makeRows=(rows:Matrix)=>rows.map(r=>({values:r.map(cell=>
  cell===null?{}:{userEnteredValue:typeof cell==="number"?
    {numberValue:cell}:{stringValue:cell}}
)}));
/** A genuine REST-shaped body; no spreadsheet ID, endpoint or HTTP call. */
export function buildAtomicBatch(prepared:Prepared,layout:Layout,maxBytes=DEFAULT_BYTES):
  {body:AtomicBatch;bytes:number}{
  const used=new Set<number>();
  const requests:GoogleUpdateCells[]=[];
  for(const tab of TABS){
    const p=layout[tab],matrix=prepared.workbook[tab];
    if(!p||!Number.isInteger(p.sheetId)||p.sheetId<0||used.has(p.sheetId)||
      !Number.isInteger(p.rowCapacity)||p.rowCapacity<matrix.length||
      !Number.isInteger(p.columnCapacity)||p.columnCapacity<HEADERS[tab].length)
      throw Error("INVALID_SHEET_LAYOUT");
    used.add(p.sheetId);
    requests.push({updateCells:{
      range:{sheetId:p.sheetId,startRowIndex:0,endRowIndex:p.rowCapacity,
        startColumnIndex:0,endColumnIndex:HEADERS[tab].length},
      rows:makeRows(matrix),fields:"userEnteredValue"
    }});
  }
  const body={requests};
  const size=bytes(body);
  if(!Number.isFinite(maxBytes)||maxBytes<1||size>maxBytes)
    throw Error("RECOMMENDED_PAYLOAD_LIMIT");
  return {body,bytes:size};
}
function parseMeta(rows:Matrix):Record<string,string>{
  if(JSON.stringify(rows[0])!==JSON.stringify(HEADERS.Meta))throw Error("BAD_META_HEADER");
  const keys=new Map<string,string>();
  for(const r of rows.slice(1)){
    if(r.length!==3||typeof r[0]!=="string"||typeof r[1]!=="string"||
      typeof r[2]!=="string"||keys.has(r[0])||!META_KEYS.includes(r[0] as typeof META_KEYS[number]))
      throw Error("BAD_META_ROW");
    safe(r[0]);safe(r[1],true);safe(r[2]);keys.set(r[0],r[1]);
  }
  if(keys.size!==META_KEYS.length)throw Error("MISSING_META_FIELDS");
  return Object.fromEntries(keys);
}
function parseTab(tab:ReadTab,matrix:Matrix,generation:string):AiReadRows[ReadTab]{
  const header=HEADERS[tab];
  if(!Array.isArray(matrix)||JSON.stringify(matrix[0])!==JSON.stringify(header))
    throw Error("BAD_READ_HEADER");
  if(matrix.length>MAX_ROWS)throw Error("TOO_MANY_ROWS");
  const out:Record<string,Cell>[]=[];
  const ids=new Set<string>();
  for(const cells of matrix.slice(1)){
    if(cells.length!==header.length)throw Error("WRONG_ROW_WIDTH");
    const row:Record<string,Cell>={};
    cells.forEach((cell,i)=>{
      const k=header[i],nullable=(NULLABLE[tab]??[]).includes(k);
      row[k]=nullable&&(cell===null||cell==="")?null:cell;
    });
    assertRowShape(tab,row as Record<string,unknown>,generation);
    const id=row.record_key as string;
    if(ids.has(id))throw Error("DUPLICATE_RECORD_KEY");
    ids.add(id);
    out.push(row);
  }
  return out as unknown as AiReadRows[ReadTab];
}
export type Verified={
  consistency:"consistent"|"unverified";reason:string;generation_id:string|null;
  freshness:"claimed_fresh"|"stale"|"not_checked";
  /** No cryptographic D1 provenance: sheet owner/editor can rewrite contents and digest. */
  authority:"sheet-copy-only";
};
export interface SheetReader{
  readMeta():Promise<Matrix>;
  readTab(tab:ReadTab|"Sync_Status",generation:string):Promise<Matrix>;
}
/** Caller must supply a trusted reference time before claiming snapshot freshness. */
export async function verifyReadSnapshot(
  reader:SheetReader,referenceUtc?:string,maxAgeMs=36*3600_000
):Promise<Verified>{
  const fail=(reason:string):Verified=>({consistency:"unverified",reason,
    freshness:reason==="STALE_SNAPSHOT"?"stale":"not_checked",
    generation_id:null,authority:"sheet-copy-only"});
  try{
    const first=await reader.readMeta(),meta=parseMeta(first);
    const gen=meta.active_generation;
    if(!/^[a-zA-Z0-9_-]{8,80}$/u.test(gen)||meta.contract_version!=="ai-sheets-v1"||
       meta.publication_state!=="active")throw Error("INVALID_ACTIVE_GENERATION");
    const rows={} as AiReadRows;
    for(const tab of READ_TABS)rows[tab]=parseTab(tab,await reader.readTab(tab,gen),gen) as never;
    const status=await reader.readTab("Sync_Status",gen);
    if(JSON.stringify(status[0])!==JSON.stringify(HEADERS.Sync_Status)||
       status.length!==2||status[1][3]!==gen||status[1][5]!=="success")
      throw Error("INVALID_SYNC_STATUS");
    const last=await reader.readMeta();
    if(JSON.stringify(first)!==JSON.stringify(last))throw Error("CONCURRENT_META_CHANGE");
    const counts=JSON.parse(meta.expected_counts_json) as AiReadSnapshot["counts"];
    const canonical_weight_keys=JSON.parse(meta.canonical_weight_keys_json) as Record<string,string>;
    const warnings=JSON.parse(meta.warnings_json) as string[];
    const snap:AiReadSnapshot={
      contract_version:"ai-sheets-v1",generation_id:gen,
      generated_at_utc:meta.generated_at_utc,
      coverage_from_jst:meta.retention_from_jst,coverage_to_jst:meta.coverage_to_jst,
      data_through_jst:meta.data_through_jst||null,
      incomplete_day_jst:meta.incomplete_day_jst||null,
      counts,canonical_weight_keys,warnings,
      rows,generation_digest:meta.generation_digest
    };
    validateSource(snap);
    if((await readModelDigest(snap))!==meta.generation_digest)throw Error("DIGEST_MISMATCH");
    if(referenceUtc!==undefined){
      const reference=Date.parse(referenceUtc),generated=Date.parse(meta.generated_at_utc);
      if(!/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(referenceUtc)||
         !Number.isFinite(reference)||!Number.isFinite(generated)||
         !Number.isFinite(maxAgeMs)||maxAgeMs<1||generated>reference+60_000)
        throw Error("INVALID_FRESHNESS_REFERENCE");
      if(reference-generated>maxAgeMs)throw Error("STALE_SNAPSHOT");
    }
    return {consistency:"consistent",reason:"INTERNAL_CONSISTENCY_ONLY",
      generation_id:gen,authority:"sheet-copy-only",
      freshness:referenceUtc===undefined?"not_checked":"claimed_fresh"};
  }catch(e){
    return fail(e instanceof Error?e.message:"INVALID_SNAPSHOT");
  }
}
type FakeStage=Partial<Record<Tab,Matrix>>;
type Fault={operation:"atomic"|"stage"|"activate";code:403|429|503|"timeout";
  afterApply?:boolean;tab?:Tab};
const timeout=()=>{throw Error("SHEETS_TIMEOUT_UNKNOWN");};
/**
 * In-memory protocol fake. Staged paths demonstrate fail-safe two-generation
 * semantics, but DO NOT assert that Google has atomic cross-call publishing,
 * per-tab ACLs, or an actual approved staging worksheet layout.
 */
export class FakeSheets implements SheetReader{
  private active:string|null=null;
  private committed=new Map<string,Workbook>();
  private staged=new Map<string,FakeStage>();
  private fault:Fault|null=null;
  private afterFirstRead:(()=>void)|null=null;
  injectFailure(fault:Fault):void{this.fault=fault;}
  onFirstMetaRead(action:()=>void):void{this.afterFirstRead=action;}
  get activeGeneration():string|null{return this.active;}
  get committedCount():number{return this.committed.size;}
  get stagedCount():number{return this.staged.size;}
  private maybeFail(op:Fault["operation"],tab?:Tab,after=false):void{
    const f=this.fault;
    if(f?.operation===op&&(f.tab===undefined||f.tab===tab)&&!!f.afterApply===after){
      this.fault=null;
      if(f.code==="timeout")timeout();
      throw Error("SHEETS_HTTP_"+f.code);
    }
  }
  private activate(p:Prepared,wb:Workbook):void{
    const existing=this.committed.get(p.generation_id);
    if(existing&&JSON.stringify(existing)!==JSON.stringify(wb))
      throw Error("GENERATION_COLLISION");
    this.committed.set(p.generation_id,clone(wb));
    this.active=p.generation_id;
    // Retain the current and one immediately preceding generation at most.
    while(this.committed.size>2){
      const stale=[...this.committed.keys()].find(id=>id!==this.active);
      if(!stale)break;
      this.committed.delete(stale);
    }
  }
  async publishAtomic(p:Prepared,layout:Layout,maxBytes=DEFAULT_BYTES):Promise<void>{
    buildAtomicBatch(p,layout,maxBytes);
    this.maybeFail("atomic");
    this.activate(p,p.workbook);
    this.maybeFail("atomic",undefined,true);
  }
  private appendPart(id:string,tab:Tab,part:Matrix,offset:number):void{
    const stage=this.staged.get(id)??{};
    const existing=stage[tab]??[];
    if(existing.length!==offset)throw Error("STAGE_OFFSET_CONFLICT");
    stage[tab]=[...existing,...clone(part)];
    this.staged.set(id,stage);
  }
  /**
   * A bounded mock of multi-call staging. Meta is activated only after all
   * slices and a full digest have been checked; old active generation survives.
   */
  async publishStaged(p:Prepared,maxChunkBytes=DEFAULT_BYTES):Promise<void>{
    if(!Number.isFinite(maxChunkBytes)||maxChunkBytes<256)
      throw Error("INVALID_CHUNK_BUDGET");
    // In a failed-run storm, keep at most two partial generations in the fake.
    if(!this.staged.has(p.generation_id)&&this.staged.size>=2){
      const oldest=this.staged.keys().next().value;
      if(oldest!==undefined)this.staged.delete(oldest);
    }
    const inFlight=this.staged.get(p.generation_id);
    if(inFlight){
      for(const tab of TABS){
        const part=inFlight[tab];
        const full=p.workbook[tab];
        if(part&&JSON.stringify(part)!==JSON.stringify(full.slice(0,part.length)))
          throw Error("STAGE_GENERATION_CONFLICT");
      }
    }
    for(const tab of TABS){
      // Metadata is assembled for inspection but is NOT exposed until activation.
      const expected=p.workbook[tab];
      let offset=(this.staged.get(p.generation_id)?.[tab]??[]).length;
      while(offset<expected.length){
        const part:Matrix=[];
        while(offset+part.length<expected.length){
          const next=expected[offset+part.length];
          if(bytes([...part,next])>maxChunkBytes){
            if(!part.length)throw Error("OVERSIZED_SINGLE_ROW");
            break;
          }
          part.push(next);
        }
        this.maybeFail("stage",tab);
        this.appendPart(p.generation_id,tab,part,offset);
        this.maybeFail("stage",tab,true);
        offset+=part.length;
      }
    }
    const staged=this.staged.get(p.generation_id);
    if(!staged||TABS.some(tab=>JSON.stringify(staged[tab])!==JSON.stringify(p.workbook[tab])))
      throw Error("INCOMPLETE_STAGED_GENERATION");
    this.maybeFail("activate");
    this.activate(p,staged as Workbook);
    this.staged.delete(p.generation_id);
    this.maybeFail("activate",undefined,true);
  }
  async readMeta():Promise<Matrix>{
    const data=this.active?this.committed.get(this.active)?.Meta:undefined;
    if(!data)throw Error("NO_ACTIVE_GENERATION");
    const out=clone(data);
    if(this.afterFirstRead){const f=this.afterFirstRead;this.afterFirstRead=null;f();}
    return out;
  }
  async readTab(tab:ReadTab|"Sync_Status",generation:string):Promise<Matrix>{
    const data=this.committed.get(generation)?.[tab];
    if(!data)throw Error("MISSING_GENERATION_TAB");
    return clone(data);
  }
  /** Models the threat of an Editor replacing cells in an otherwise private file. */
  tamperActive(tab:Tab,row:number,col:number,value:Cell):void{
    if(!this.active)throw Error("NO_ACTIVE_GENERATION");
    const data=this.committed.get(this.active)?.[tab];
    if(!data||!data[row]||col<0||col>=data[row].length)throw Error("BAD_TAMPER_OFFSET");
    data[row][col]=value;
  }
}
/** Result is never proof of source D1 authenticity; unknown after lost ack is explicit. */
export async function publishFake(
  fake:FakeSheets,p:Prepared,layout:Layout,
  mode:"atomic"|"staged"="atomic",maxBytes=DEFAULT_BYTES
):Promise<"published"|"already"|"unknown"|"rejected">{
  const before=fake.activeGeneration;
  const current=await verifyReadSnapshot(fake);
  if(current.consistency==="consistent"&&current.generation_id===p.generation_id)
    return "already";
  if(before===p.generation_id)return "rejected"; // tampered active, do not overwrite
  try{
    if(mode==="atomic")await fake.publishAtomic(p,layout,maxBytes);
    else await fake.publishStaged(p,maxBytes);
    const v=await verifyReadSnapshot(fake);
    return v.consistency==="consistent"&&v.generation_id===p.generation_id?
      "published":"unknown";
  }catch(e){
    const msg=e instanceof Error?e.message:"UNKNOWN";
    if(msg.startsWith("SHEETS_HTTP_403")||msg.startsWith("INVALID_")||
       msg.startsWith("RECOMMENDED_")||msg.startsWith("GENERATION_COLLISION"))
      return "rejected";
    if(msg.startsWith("SHEETS_TIMEOUT"))return "unknown";
    return "unknown";
  }
}
