/**
 * Phase B1: read-only, owner-scoped D1 observation projection.
 * No browser route, remote API, D1 mutation, Google adapter or Cron wiring.
 * Public row keys/revisions are non-authenticating freshness markers, not permissions.
 */
import { dateRange, isEclearWeightSource, jstDay, parseDay } from "../shared/weight-trend";
import { assessDrinkAlcohol, publicDrinkKind, type StoredDrinkKind } from "../shared/drink-measures";
import { isFitSource } from "./steps-trend";

type Statement = {
  bind(...values: unknown[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
};
type ReadBatchResult = { results: unknown[]; success?: boolean };
export type AiReadDb = {
  prepare(sql: string): Statement;
  /** D1 batch() executes the four read queries in a single SQL transaction. */
  batch(statements: Statement[]): Promise<ReadBatchResult[]>;
};
type WeightSource = { id:string; measured_at:string; weight_kg:number|null; source_id:string; source_kind:string; anomaly_flag:number };
type StepSource = { id:string; local_day:string; steps:number|null; source_id:string };
type LifestyleSource = { local_day:string; drinking_presence:number|null; drink_cups:number|null;
  lunch_kind:string|null; dinner_kind:string|null; late_meal:number|null; source_id:string };
type DrinkSource = { id:string; observed_at:string; drink_kind:StoredDrinkKind;
  drink_variant:string|null; source_id:string; alcohol:number; cups:number;
  volume_ml:number|null; abv_pct:number|null };

type State = "present"|"missing";
type CellValue = string|number|null;
type WeightRow = { generation_id:string; record_key:string; local_day:string; measured_at_jst:string;
  weight_kg:number; source_type:"eclear"|"manual"; measurement_kind:"measured";
  value_state:"present"; revision:string };
type StepRow = { generation_id:string; record_key:string; local_day:string; steps:number|null;
  source_type:"fit"|"manual"|"missing"; source_priority:number|null;
  value_state:State; revision:string };
type MealRow = { generation_id:string; record_key:string; local_day:string;
  lunch_kind:string|null; lunch_value_state:State; dinner_kind:string|null; dinner_value_state:State;
  late_meal:number|null; late_meal_value_state:State; source_type:string; revision:string };
type DrinkRow = { generation_id:string; record_key:string; observed_at_jst:string; drink_kind:string;
  cups:number; pure_alcohol_g:number|null; alcohol_value_kind:"entered"|"estimated"|"unknown"|"non_alcohol";
  source_type:string; value_state:"present"; revision:string };
type DrinkDayRow = { generation_id:string; record_key:string; local_day:string;
  drinking_presence:0|1|null; drink_cups:number|null; drink_cups_value_state:State;
  source_type:string; revision:string };

export type AiReadRows = { Read_Weight:WeightRow[]; Read_Steps:StepRow[];
  Read_Meals:MealRow[]; Read_Drinks:DrinkRow[]; Read_DrinkDays:DrinkDayRow[] };
export type AiReadSnapshot = {
  contract_version:"ai-sheets-v1"; generation_id:string; generated_at_utc:string;
  coverage_from_jst:string; coverage_to_jst:string; data_through_jst:string|null;
  incomplete_day_jst:string|null; counts:Record<keyof AiReadRows,number>;
  generation_digest:string; warnings:string[]; canonical_weight_keys:Record<string,string>;
  rows:AiReadRows;
};
export type AiReadOptions = { from:string; to:string; generatedAtUtc:string; generationId:string };

const DAY = 86400000;
const JST = 9 * 3600000;
const MAX_ROWS = 10000;
const LIMIT = MAX_ROWS + 1;
const todayJst = (ms:number)=>jstDay(ms);
const dayFrom = (ms:number)=>new Date(ms).toISOString().slice(0,10);

/** A deterministic non-cryptographic opaque marker. NOT a proof of record authority. */
function marker(input:string):string {
  let a=2166136261,b=0x9e3779b9;
  for(let i=0;i<input.length;i++){
    const c=input.charCodeAt(i);
    a=Math.imul(a^c,16777619);
    b=Math.imul(b^c,2246822519);
  }
  return (a>>>0).toString(16).padStart(8,"0")+(b>>>0).toString(16).padStart(8,"0");
}
const keyFor=(owner:string,kind:string,id:string)=>
  kind+":"+marker(JSON.stringify([owner,kind,id]));
const revision=(id:string,values:readonly CellValue[])=>
  marker(JSON.stringify([id,...values]));
function toJstIso(input:string):string {
  const ms=Date.parse(input);
  if(!Number.isFinite(ms))throw Error("INVALID_TIMESTAMP");
  return new Date(ms+JST).toISOString().replace("Z","+09:00");
}
function sourceType(source:string):string {
  if(source.startsWith("manual:"))return "manual";
  if(isEclearWeightSource(source))return "eclear";
  if(isFitSource(source))return "fit";
  return "csv";
}
function lifestylePriority(source:string):number {
  return source.startsWith("manual:")?0:source.startsWith("eclear")?1:2;
}
function assertUnique(rows:readonly {record_key:string}[],tab:string):void {
  const seen=new Set<string>();
  for(const row of rows){
    if(seen.has(row.record_key))throw Error("DUPLICATE_RECORD_KEY:"+tab);
    seen.add(row.record_key);
  }
}
function assertReadBatch(rows:readonly ReadBatchResult[]):void {
  if(rows.length!==4||rows.some(row=>row.success===false||!Array.isArray(row.results)))
    throw Error("INCOMPLETE_D1_READ_BATCH");
  if(rows.some(row=>row.results.length>=LIMIT))throw Error("TOO_MANY_SOURCE_ROWS");
}
function daySequence(from:number,days:number):string[] {
  return Array.from({length:days},(_,i)=>dayFrom(from+i*DAY));
}
async function digest(value:unknown):Promise<string> {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const result=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,"0")).join("");
}

/** Input owner is a trusted server-side identity, never a user-supplied sheet cell. */
export async function projectAiReadSnapshot(
  db:AiReadDb,owner:string,options:AiReadOptions
):Promise<AiReadSnapshot>{
  if(!owner||owner.length>256||/\s/.test(owner))throw Error("INVALID_OWNER");
  const range=dateRange(options.from,options.to);
  const generated=Date.parse(options.generatedAtUtc);
  if(!range||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(options.generatedAtUtc)||
     !Number.isFinite(generated)||!(/^[a-zA-Z0-9_-]{8,80}$/.test(options.generationId))||
     options.to>todayJst(generated))throw Error("INVALID_SNAPSHOT_RANGE");
  const fromSec=Math.floor((range.start-JST)/1000);
  const toSec=Math.floor((range.end+DAY-JST)/1000);
  // A single D1 SQL transaction prevents inconsistent reads across four source tables.
  // Promise.all of independent D1 requests cannot guarantee a common snapshot.
  const readBatch=await db.batch([
    db.prepare("SELECT id,measured_at,weight_kg,source_id,source_kind,anomaly_flag "+
      "FROM body_measurements WHERE owner_id=? AND unixepoch(measured_at)>=? AND unixepoch(measured_at)<? "+
      "ORDER BY unixepoch(measured_at),id LIMIT ?").bind(owner,fromSec,toSec,LIMIT),
    db.prepare("SELECT id,local_day,steps,source_id FROM activity_daily "+
      "WHERE owner_id=? AND local_day>=? AND local_day<=? ORDER BY local_day,source_id,id LIMIT ?")
      .bind(owner,options.from,options.to,LIMIT),
    db.prepare("SELECT local_day,drinking_presence,drink_cups,lunch_kind,dinner_kind,late_meal,source_id "+
      "FROM lifestyle_days WHERE owner_id=? AND local_day>=? AND local_day<=? "+
      "ORDER BY local_day,source_id LIMIT ?").bind(owner,options.from,options.to,LIMIT),
    db.prepare("SELECT id,observed_at,drink_kind,drink_variant,source_id,alcohol,cups,volume_ml,abv_pct "+
      "FROM drink_entries WHERE owner_id=? AND unixepoch(observed_at)>=? AND unixepoch(observed_at)<? "+
      "ORDER BY unixepoch(observed_at),id LIMIT ?").bind(owner,fromSec,toSec,LIMIT),
  ]);
  assertReadBatch(readBatch);
  const [weights,steps,lifestyles,drinks]=readBatch.map(r=>r.results) as
    [WeightSource[],StepSource[],LifestyleSource[],DrinkSource[]];
  const generation_id=options.generationId;
  const warnings:string[]=[];
  const Read_Weight:WeightRow[]=[];
  const representatives=new Map<string,{record_key:string;rank:number;timestamp:number;id:string}>();
  for(const w of weights){
    const timestamp=Date.parse(w.measured_at), day=todayJst(timestamp);
    if(!Number.isFinite(timestamp)||day<options.from||day>options.to)continue;
    // Legacy/reported/estimated and anomalies are not canonical measured records.
    if(w.source_kind!=="measured"||w.anomaly_flag!==0||
       !(isEclearWeightSource(w.source_id)||w.source_id.startsWith("manual:"))||
       !Number.isFinite(w.weight_kg)||w.weight_kg===null||w.weight_kg<=0||w.weight_kg>=500)continue;
    const type=isEclearWeightSource(w.source_id)?"eclear" as const:"manual" as const;
    const record_key=keyFor(owner,"weight",w.id);
    const row:WeightRow={generation_id,record_key,local_day:day,
      measured_at_jst:toJstIso(w.measured_at),weight_kg:w.weight_kg,
      source_type:type,measurement_kind:"measured",value_state:"present",
      revision:revision(record_key,[w.source_id,w.source_kind,w.anomaly_flag,w.measured_at,w.weight_kg,type])};
    Read_Weight.push(row);
    const prior=representatives.get(day),rank=type==="eclear"?0:1;
    if(!prior||rank<prior.rank||(rank===prior.rank&&
       (timestamp>prior.timestamp||(timestamp===prior.timestamp&&w.id>prior.id))))
      representatives.set(day,{record_key,rank,timestamp,id:w.id});
  }
  const canonical_weight_keys=Object.fromEntries(
    [...representatives].sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([day,r])=>[day,r.record_key])
  );
  const selectedSteps=new Map<string,StepSource>();
  for(const s of steps){
    if(s.steps===null||!Number.isSafeInteger(s.steps)||s.steps<0)continue;
    const rank=isFitSource(s.source_id)?0:s.source_id.startsWith("manual:")?1:2;
    if(rank===2)continue;
    const p=selectedSteps.get(s.local_day);
    const oldRank=p?(isFitSource(p.source_id)?0:1):99;
    if(!p||rank<oldRank||(rank===oldRank&&
      (s.source_id<p.source_id||(s.source_id===p.source_id&&s.id<p.id))))
      selectedSteps.set(s.local_day,s);
  }
  const groups=new Map<string,LifestyleSource[]>();
  for(const l of lifestyles){
    const arr=groups.get(l.local_day)??[];arr.push(l);groups.set(l.local_day,arr);
  }
  for(const arr of groups.values())arr.sort((a,b)=>
    lifestylePriority(a.source_id)-lifestylePriority(b.source_id)||
    a.source_id.localeCompare(b.source_id));
  const drinkDay=new Map<string,DrinkSource[]>();
  const Read_Drinks:DrinkRow[]=[];
  for(const entry of drinks){
    const ms=Date.parse(entry.observed_at),day=todayJst(ms);
    if(!Number.isFinite(ms)||day<options.from||day>options.to)continue;
    const entries=drinkDay.get(day)??[];entries.push(entry);drinkDay.set(day,entries);
    const publicKind=publicDrinkKind(entry.drink_kind,entry.drink_variant,entry.source_id);
    const a=assessDrinkAlcohol({
      kind:publicKind,cups:entry.cups,volumeMl:entry.volume_ml,
      abvPct:entry.abv_pct,alcohol:entry.alcohol
    });
    const record_key=keyFor(owner,"drink",entry.id);
    Read_Drinks.push({generation_id,record_key,observed_at_jst:toJstIso(entry.observed_at),
      drink_kind:publicKind,cups:entry.cups,pure_alcohol_g:a.grams,
      alcohol_value_kind:a.basis,source_type:sourceType(entry.source_id),value_state:"present",
      revision:revision(record_key,[entry.id,entry.source_id,entry.observed_at,entry.drink_kind,
        entry.drink_variant,entry.alcohol,entry.cups,entry.volume_ml,entry.abv_pct,publicKind,
        a.grams,a.basis])});
  }
  function pick<K extends keyof LifestyleSource>(
    rows:readonly LifestyleSource[],field:K
  ): {value:LifestyleSource[K]|null;source:string|null;sourceId:string|null} {
    for(const row of rows)if(row[field]!==null)
      return {value:row[field],source:sourceType(row.source_id),sourceId:row.source_id};
    return {value:null,source:null,sourceId:null};
  }
  const Read_Steps:StepRow[]=[],Read_Meals:MealRow[]=[],Read_DrinkDays:DrinkDayRow[]=[];
  for(const day of daySequence(range.start,range.days)){
    const step=selectedSteps.get(day),rows=groups.get(day)??[],entries=drinkDay.get(day)??[];
    const sk=keyFor(owner,"steps",day),stepKind=step?(isFitSource(step.source_id)?"fit":"manual"):"missing";
    Read_Steps.push({generation_id,record_key:sk,local_day:day,steps:step?.steps??null,
      source_type:stepKind,source_priority:step?(stepKind==="fit"?0:1):null,
      value_state:step?"present":"missing",
      revision:revision(sk,[step?.id??null,step?.source_id??null,step?.steps??null,stepKind])});
    const lunch=pick(rows,"lunch_kind"),dinner=pick(rows,"dinner_kind"),late=pick(rows,"late_meal");
    const foundSources=[lunch.source,dinner.source,late.source].filter((s):s is string=>s!==null);
    const mealSource=[...new Set(foundSources)].length>1?"mixed":foundSources[0]??"missing";
    const mk=keyFor(owner,"meals",day);
    Read_Meals.push({generation_id,record_key:mk,local_day:day,
      lunch_kind:lunch.value as string|null,lunch_value_state:lunch.value===null?"missing":"present",
      dinner_kind:dinner.value as string|null,dinner_value_state:dinner.value===null?"missing":"present",
      late_meal:late.value as number|null,late_meal_value_state:late.value===null?"missing":"present",
      source_type:mealSource,revision:revision(mk,[lunch.value as CellValue,dinner.value as CellValue,
        late.value as CellValue,lunch.sourceId,dinner.sourceId,late.sourceId,mealSource])});
    const daily=pick(rows,"drinking_presence"),cups=pick(rows,"drink_cups");
    const explicitFlags=new Set(rows.filter(l=>l.drinking_presence!==null).map(l=>l.drinking_presence));
    const alcoholic=entries.some(e=>e.alcohol===1);
    const conflicted=(explicitFlags.size>1)||(explicitFlags.has(0)&&alcoholic);
    if(conflicted)warnings.push("DRINK_DAY_CONFLICT:"+day);
    const presence:0|1|null=conflicted?null:
      explicitFlags.has(1)||alcoholic?1:explicitFlags.has(0)?0:null;
    const cupValue=conflicted?null:presence===0?0:daily.value===1?cups.value as number|null:null;
    const type=conflicted?"conflict":daily.source??(alcoholic?"entry_evidence":
      entries.length?"non_alcohol_only":"missing");
    const dk=keyFor(owner,"drink_day",day);
    Read_DrinkDays.push({generation_id,record_key:dk,local_day:day,
      drinking_presence:presence,drink_cups:cupValue,
      drink_cups_value_state:cupValue===null?"missing":"present",source_type:type,
      revision:revision(dk,[presence,cupValue,type,...rows.flatMap(l=>
        [l.source_id,l.drinking_presence,l.drink_cups]),...entries.flatMap(e=>
        [e.id,e.source_id,e.alcohol,e.cups])])});
  }
  const result:AiReadRows={Read_Weight,Read_Steps,Read_Meals,Read_Drinks,Read_DrinkDays};
  for(const name of Object.keys(result) as (keyof AiReadRows)[])assertUnique(result[name],name);
  const counts=Object.fromEntries(
    (Object.keys(result) as (keyof AiReadRows)[]).map(k=>[k,result[k].length])
  ) as Record<keyof AiReadRows,number>;
  const today=todayJst(generated);
  const yesterday=dayFrom(parseDay(today)!-DAY);
  const completedThrough=options.to<today?options.to:yesterday;
  const data_through_jst=completedThrough>=options.from?completedThrough:null;
  const incomplete_day_jst=options.to===today?today:null;
  return {
    contract_version:"ai-sheets-v1",generation_id,generated_at_utc:options.generatedAtUtc,
    coverage_from_jst:options.from,coverage_to_jst:options.to,
    data_through_jst,incomplete_day_jst,counts,
    // Hash the entire verifiable manifest, including canonical representative keys,
    // source warnings and completeness dates. This is consistency, not authenticity.
    generation_digest:await digest({
      contract_version:"ai-sheets-v1",generation_id,generated_at_utc:options.generatedAtUtc,
      coverage_from_jst:options.from,coverage_to_jst:options.to,
      data_through_jst,incomplete_day_jst,counts,
      canonical_weight_keys,warnings,rows:result
    }),
    warnings,canonical_weight_keys,rows:result
  };
}
