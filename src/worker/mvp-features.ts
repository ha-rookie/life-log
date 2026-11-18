import { handleLagAnalysis } from "./lag-analysis";
import { handleAnalysisMetrics } from "./analysis-metrics";
import { isSafeLocalManual, isSafeRemoteManual, type RemoteWriteConfig } from "./manual-entry";
import { isEclearWeightSource } from "../shared/weight-trend";
import { drinkVariant, isDrinkKind, isDrinkSize, pureAlcoholGrams, storedDrinkKind,
  assessDrinkAlcohol, publicDrinkKind, drinkSourceId, manualDrinkSources, personalAlcoholRule,
  validDrinkAmounts, type DrinkKind, type DrinkSize, type StoredDrinkKind } from "../shared/drink-measures";

type Stmt={bind(...args:unknown[]):{
  first<T>():Promise<T|null>;
  all<T>():Promise<{results:T[]}>;
  run():Promise<{meta?:{changes?:number}}>;
}};
export type MvpDb={prepare(sql:string):Stmt;batch?(stmts:unknown[]):Promise<unknown[]>};
export type MvpConfig={local?:string;remote?:RemoteWriteConfig};
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const json=(o:unknown,status=200)=>Response.json(o,{status,headers});
const fail=(reason:string,status=422)=>json({error:reason},status);
const dayMs=86400000;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type Kind=DrinkKind;
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const millis=(date:string)=>Date.parse(date+"T00:00:00Z");
const validCalendarDay=(d:unknown):d is string=>typeof d==="string"&&/^\d{4}-\d\d-\d\d$/.test(d)&&
  Number.isFinite(millis(d))&&new Date(millis(d)).toISOString().slice(0,10)===d;
const validDay=(d:unknown):d is string=>validCalendarDay(d)&&d<=today();
const jstDate=(text:string)=>new Date(Date.parse(text)+9*3600000).toISOString().slice(0,10);
const validObserved=(s:unknown):s is string=>typeof s==="string"&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s)&&
  Number.isFinite(Date.parse(s))&&Date.parse(s)<=Date.now()+60000&&Date.parse(s)>Date.now()-366*dayMs;
const validText=(s:unknown,max=600):s is string=>typeof s==="string"&&s.trim().length>0&&s.trim().length<=max;
const range=(from:unknown,to:unknown,max=366)=>{
  if(!validDay(from)||!validDay(to))return null;
  const days=Math.round((millis(to)-millis(from))/dayMs)+1;
  return days>=1&&days<=max?{from,to,days}:null;
};
const dateBounds=(a:{from:string;to:string})=>[
  Math.floor((millis(a.from)-9*3600000)/1000),
  Math.floor((millis(a.to)+dayMs-9*3600000)/1000)
];
const body=async(request:Request)=>{
  if(!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))return null;
  if(Number(request.headers.get("Content-Length")??0)>4096)return null;
  const text=await request.text();
  if(new TextEncoder().encode(text).length>4096)return null;
  try{const obj:unknown=JSON.parse(text);return obj&&!Array.isArray(obj)&&typeof obj==="object"?obj as Record<string,unknown>:null;}
  catch{return null;}
};
const allowWrite=(req:Request,config:MvpConfig)=>
  isSafeLocalManual(req,config.local)||isSafeRemoteManual(req,config.remote??{});
type W={id:string;measured_at:string;weight_kg:number|null;source_id:string;anomaly_flag:number};
type S={local_day:string;steps:number|null;source_id:string};
type L={local_day:string;drinking_presence:number|null;drink_cups:number|null;lunch_kind:string|null;dinner_kind:string|null;late_meal:number|null;source_id:string};
type D={id:string;observed_at:string;drink_kind:StoredDrinkKind;source_id:string;alcohol:number;cups:number;
  volume_ml:number|null;abv_pct:number|null;drink_variant:string|null;size_label:string|null;
  source_row_key:string};
const priority=(source:string)=>source.startsWith("manual:")?0:source.startsWith("eclear")?1:2;
const isFitStepSource=(s:string):boolean=>
  s==="fit"||s==="google_fit"||s==="google-fit"||
  s.startsWith("fit:")||s.startsWith("google_fit:")||
  s.startsWith("google-fit:")||s.startsWith("csv:fit")||
  s.startsWith("csv:google_fit")||s.startsWith("csv:google-fit");
const stepRank=(s:string):number=>
  isFitStepSource(s)?0:s.startsWith("manual:")?1:2;
const preferStep=(old:S|undefined,next:S):S=>
  !old||stepRank(next.source_id)<stepRank(old.source_id)?next:old;
const weightRank=(s:string):number=>
  isEclearWeightSource(s)?0:s.startsWith("manual:")?1:2;
async function comparePeriod(db:MvpDb,owner:string,p:{from:string;to:string;days:number}){
  const [fromSec,toSec]=dateBounds(p);
  const weights=await db.prepare("SELECT id,measured_at,weight_kg,source_id,anomaly_flag FROM body_measurements "+
    "WHERE owner_id=? AND unixepoch(measured_at)>=? AND unixepoch(measured_at)<? "+
    "ORDER BY unixepoch(measured_at),id LIMIT 10001")
    .bind(owner,fromSec,toSec).all<W>();
  const steps=await db.prepare("SELECT local_day,steps,source_id FROM activity_daily "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? ORDER BY local_day,source_id LIMIT 10001")
    .bind(owner,p.from,p.to).all<S>();
  const lifestyles=await db.prepare("SELECT local_day,drinking_presence,drink_cups,lunch_kind,dinner_kind,late_meal,source_id FROM lifestyle_days "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? ORDER BY local_day,source_id LIMIT 10001")
    .bind(owner,p.from,p.to).all<L>();
  const drinks=await db.prepare("SELECT id,observed_at,drink_kind,source_id,alcohol,cups,volume_ml,abv_pct,drink_variant,size_label,source_row_key FROM drink_entries "+
    "WHERE owner_id=? AND unixepoch(observed_at)>=? AND unixepoch(observed_at)<? LIMIT 10001")
    .bind(owner,fromSec,toSec).all<D>();
  const visitRows=await db.prepare("SELECT local_day,category FROM outings "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? LIMIT 10001")
    .bind(owner,p.from,p.to).all<{local_day:string;category:string}>();
  if([weights,steps,lifestyles,drinks,visitRows].some(x=>x.results.length>10000))throw Error("TOO_MANY");
  const measures=new Map<string,W>();
  for(const w of weights.results){
    if(w.weight_kg===null||w.anomaly_flag!==0)continue;
    // ECLEAR is authoritative. Old lifestyle/legacy/XLSX weight is not a
    // historical fallback. Explicit manual observations remain separate.
    if(!isEclearWeightSource(w.source_id)&&!w.source_id.startsWith("manual:")&&w.source_id!=="synthetic")continue;
    const day=jstDate(w.measured_at),old=measures.get(day);
    if(!old||weightRank(w.source_id)<weightRank(old.source_id)||
      (weightRank(w.source_id)===weightRank(old.source_id)&&
       (Date.parse(w.measured_at)>Date.parse(old.measured_at)||
        (w.measured_at===old.measured_at&&w.id>old.id))))
      measures.set(day,w);
  }
  const observed=[...measures.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const start=observed[0],end=observed.at(-1);
  // Qualified trailing 7-day weight mean: at least four separate observed JST days,
  // never a fabricated zero or a '7-day mean' from a shorter partial window.
  const lastSevenWindowDays=Math.min(7,p.days);
  const lastSevenFrom=new Date(millis(p.to)-(lastSevenWindowDays-1)*dayMs).toISOString().slice(0,10);
  const lastSevenValues=observed.filter(([d])=>d>=lastSevenFrom).map(([,w])=>w.weight_kg!);
  const lastSevenMeanKg=lastSevenWindowDays===7&&lastSevenValues.length>=4
    ?Number((lastSevenValues.reduce((a,b)=>a+b,0)/lastSevenValues.length).toFixed(2)):null;
  const days=new Map<string,S>();
  for(const s of steps.results){
    // Google Fit is the canonical step record, never sum duplicate sources.
    // CSV lifestyle steps are reference-only; explicit manual inputs remain
    // eligible if that day has no Fit observation.
    if(s.steps===null||!(isFitStepSource(s.source_id)||s.source_id.startsWith("manual:")))continue;
    days.set(s.local_day,preferStep(days.get(s.local_day),s));
  }
  const ls=new Map<string,L>();
  // Preserve each observed field independently: a manual meal-only row must
  // never turn an existing CSV drinking observation into an unknown day.
  for(const l of lifestyles.results.sort((a,b)=>priority(a.source_id)-priority(b.source_id))){
    const current=ls.get(l.local_day);
    if(!current){ls.set(l.local_day,{...l});continue;}
    for(const key of ["drinking_presence","drink_cups","lunch_kind","dinner_kind","late_meal"] as const){
      if(current[key]===null&&l[key]!==null)(current as Record<typeof key,unknown>)[key]=l[key];
    }
  }
  // Do not impute drinking=0 for unobserved days or convert past 'drank' to one cup.
  const known=[...ls.values()].filter(l=>l.drinking_presence!==null);
  const stepValues=[...days.values()].map(s=>s.steps!).filter(n=>Number.isFinite(n));
  const lunch=[...ls.values()].filter(l=>l.lunch_kind!==null);
  const dinner=[...ls.values()].filter(l=>l.dinner_kind!==null);
  const alcoholCups=drinks.results.filter(x=>x.alcohol===1).reduce((a,x)=>a+x.cups,0);
  const nonAlcoholCups=drinks.results.filter(x=>x.alcohol===0).reduce((a,x)=>a+x.cups,0);
  const knownAlcoholG=drinks.results.filter(x=>x.alcohol===1).reduce((a,x)=>
    a+(pureAlcoholGrams({cups:x.cups,volumeMl:x.volume_ml,abvPct:x.abv_pct,alcohol:x.alcohol})??0),0);
  const drinkAssessments=drinks.results.map(x=>assessDrinkAlcohol({
    kind:publicDrinkKind(x.drink_kind,x.drink_variant,x.source_id),
    cups:x.cups,volumeMl:x.volume_ml,abvPct:x.abv_pct,alcohol:x.alcohol
  }));
  const estimatedAlcoholG=drinkAssessments.reduce((a,x)=>a+(x.basis==="estimated"?(x.grams??0):0),0);
  const estimatedAlcoholCups=drinkAssessments.reduce((a,x)=>a+x.estimatedCups,0);
  const unknownAlcoholCups=drinkAssessments.reduce((a,x)=>a+x.unknownCups,0);
  return {
    from:p.from,to:p.to,calendarDays:p.days,
    weight:{
      startDay:start?.[0]??null,startKg:start?.[1].weight_kg??null,
      startMeasuredAt:start?.[1].measured_at??null,startSource:start?.[1].source_id??null,
      endDay:end?.[0]??null,endKg:end?.[1].weight_kg??null,
      endMeasuredAt:end?.[1].measured_at??null,endSource:end?.[1].source_id??null,
      deltaKg:start&&end&&observed.length>=2?Number((end[1].weight_kg!-start[1].weight_kg!).toFixed(2)):null,
      observedDays:observed.length,missingDays:p.days-observed.length,
      lastSevenMeanKg,lastSevenObservedDays:lastSevenValues.length,
      lastSevenWindowDays,
    },
    steps:{mean:stepValues.length?Math.round(stepValues.reduce((a,b)=>a+b,0)/stepValues.length):null,
      observedDays:stepValues.length,missingDays:p.days-stepValues.length,zeroDays:stepValues.filter(x=>x===0).length,
      sources:[...new Set([...days.values()].map(x=>x.source_id))]},
    drinking:{observedDays:known.length,
      drinkingDays:known.filter(x=>x.drinking_presence===1).length,
      nondrinkingDays:known.filter(x=>x.drinking_presence===0).length,
      missingDays:p.days-known.length,
      recordedAlcoholCups:alcoholCups,recordedNonAlcoholCups:nonAlcoholCups,
      cupEntryCount:drinks.results.length,
      knownAlcoholG:Math.round(knownAlcoholG*10)/10,
      estimatedAlcoholG:Math.round(estimatedAlcoholG*10)/10,estimatedAlcoholCups,
      unknownAlcoholCups,assumptionVersion:personalAlcoholRule},
    meals:{observedLunchDays:lunch.length,observedDinnerDays:dinner.length,
      restaurantLunchDays:lunch.filter(x=>x.lunch_kind==="restaurant").length,
      restaurantDinnerDays:dinner.filter(x=>x.dinner_kind==="restaurant").length,
      takeoutLunchDays:lunch.filter(x=>x.lunch_kind==="takeout").length,
      takeoutDinnerDays:dinner.filter(x=>x.dinner_kind==="takeout").length,
      lateMealObservedDays:[...ls.values()].filter(x=>x.late_meal!==null).length,
      lateMealDays:[...ls.values()].filter(x=>x.late_meal===1).length},
    outings:{visits:visitRows.results.length,
      work:visitRows.results.filter(x=>x.category==="work").length,
      bar:visitRows.results.filter(x=>x.category==="bar").length,
      other:visitRows.results.filter(x=>x.category==="other").length}
  };
}
async function compare(req:Request,db:MvpDb,owner:string){
  const q=new URL(req.url).searchParams;
  if([...q.keys()].some(k=>!["aFrom","aTo","bFrom","bTo"].includes(k)))return fail("RANGE",400);
  const a=range(q.get("aFrom"),q.get("aTo"));
  const b=range(q.get("bFrom"),q.get("bTo"));
  if(!a||!b||!(a.to<b.from||b.to<a.from))return fail("RANGE",400);
  return json({a:await comparePeriod(db,owner,a),b:await comparePeriod(db,owner,b),
    disclaimer:"観測データの比較です。欠測を0とせず、体重変化の原因や飲酒の効果は断定しません。"});
}
// Read-only evidence tied to a saved Owner experiment, not an AI outcome verdict.
async function experimentEvidence(req:Request,db:MvpDb,owner:string){
  const q=new URL(req.url).searchParams;
  const id=q.get("id");
  if(q.size!==1||typeof id!=="string"||!uuid.test(id))return fail("PAYLOAD",400);
  const experiment=await db.prepare(
    "SELECT starts_on AS startsOn,ends_on AS endsOn FROM behavior_experiments "+
    "WHERE owner_id=? AND id=? LIMIT 1")
    .bind(owner,id.toLowerCase()).first<{startsOn:string;endsOn:string}>();
  if(!experiment)return fail("NOT_FOUND",404);
  const {startsOn,endsOn}=experiment;
  const currentDay=today();
  if(!validCalendarDay(startsOn)||!validCalendarDay(endsOn)||startsOn>endsOn||
    (millis(endsOn)-millis(startsOn))/dayMs>90)return fail("RANGE",422);
  if(startsOn>currentDay)return json({
    id:id.toLowerCase(),status:"not_started",asOf:currentDay,plannedFrom:startsOn,
    plannedTo:endsOn,before:null,during:null,
    disclaimer:"開始前の計測値は作成しません。実測データだけを比較します。"
  });
  const through=endsOn<currentDay?endsOn:currentDay;
  const n=Math.round((millis(through)-millis(startsOn))/dayMs)+1;
  if(n<1||n>91)return fail("RANGE",422);
  const baselineFrom=new Date(millis(startsOn)-n*dayMs).toISOString().slice(0,10);
  const baselineTo=new Date(millis(startsOn)-dayMs).toISOString().slice(0,10);
  if(!validDay(baselineFrom)||!validDay(baselineTo))return fail("RANGE",422);
  const before=await comparePeriod(db,owner,{from:baselineFrom,to:baselineTo,days:n});
  const during=await comparePeriod(db,owner,{from:startsOn,to:through,days:n});
  return json({id:id.toLowerCase(),status:endsOn<=currentDay?"finished":"in_progress",
    asOf:currentDay,plannedFrom:startsOn,plannedTo:endsOn,before,during,
    disclaimer:"同日数の実測記録を並べた観察結果です。記録なし≠0、飲酒有無≠杯数。因果効果や継続・修正・終了の本人判定は自動で決めません。"});
}

const manualSourcesSql=manualDrinkSources.map(()=>"?").join(",");
async function listDrinks(req:Request,db:MvpDb,owner:string){
  const q=new URL(req.url).searchParams;
  if([...q.keys()].some(k=>!["from","to"].includes(k)))return fail("RANGE",400);
  const p=range(q.get("from")??new Date(Date.now()+9*3600000-29*dayMs).toISOString().slice(0,10),
    q.get("to")??today(),60);
  if(!p)return fail("RANGE",400);
  const [a,b]=dateBounds(p);
  const rows=await db.prepare("SELECT source_row_key AS key,observed_at AS observedAt,"+
    " drink_kind AS storedKind,drink_variant AS variant,source_id AS sourceId,"+
    " alcohol,cups,volume_ml AS volumeMl,abv_pct AS abvPct,size_label AS size"+
    " FROM drink_entries WHERE owner_id=? AND source_id IN ("+manualSourcesSql+")"+
    " AND unixepoch(observed_at)>=? AND unixepoch(observed_at)<?"+
    " ORDER BY unixepoch(observed_at) DESC,id DESC LIMIT 501"
  ).bind(owner,...manualDrinkSources,a,b).all<{
    key:string;observedAt:string;storedKind:StoredDrinkKind;variant:string|null;sourceId:string;
    alcohol:number;cups:number;volumeMl:number|null;abvPct:number|null;size:DrinkSize|null
  }>();
  if(rows.results.length>500)return fail("TOO_MANY",422);
  return json({from:p.from,to:p.to,entries:rows.results.map(row=>({
    key:row.key,observedAt:row.observedAt,
    kind:publicDrinkKind(row.storedKind,row.variant,row.sourceId),
    alcohol:row.alcohol,cups:row.cups,volumeMl:row.volumeMl,abvPct:row.abvPct,size:row.size
  }))});
}
type StoredDrink={
  observedAt:string;storedKind:StoredDrinkKind;variant:"beer"|null;sourceId:string;
  cups:number;volumeMl:number|null;abvPct:number|null;size:DrinkSize|null;
};
const publicKind=(record:StoredDrink):Kind=>
  publicDrinkKind(record.storedKind,record.variant,record.sourceId);
const validSize=(s:unknown):s is DrinkSize|null=>s===null||isDrinkSize(s);
const optionalAmount=(p:Record<string,unknown>,key:string,otherwise:unknown):unknown=>
  Object.prototype.hasOwnProperty.call(p,key)?p[key]:otherwise;
async function writeDrink(req:Request,db:MvpDb,owner:string,p:Record<string,unknown>){
  if(typeof p.key!=="string"||!uuid.test(p.key))return fail("KEY");
  const key=p.key.toLowerCase();
  // Fixed allowlist avoids conflating arbitrary source records with manually
  // created drink entries. A duplicated key across subtypes fails closed.
  const oldRows=await db.prepare(
    "SELECT observed_at AS observedAt,drink_kind AS storedKind,drink_variant AS variant,"+
    " source_id AS sourceId,cups,volume_ml AS volumeMl,abv_pct AS abvPct,size_label AS size"+
    " FROM drink_entries WHERE owner_id=? AND source_row_key=?"+
    " AND source_id IN ("+manualSourcesSql+") LIMIT 2"
  ).bind(owner,key,...manualDrinkSources).all<StoredDrink>();
  if(oldRows.results.length>1)return fail("CONFLICT",409);
  const old=oldRows.results[0]??null;
  if(req.method==="DELETE"){
    if(!old)return fail("NOT_FOUND",404);
    if(p.expectedObservedAt!==old.observedAt||p.expectedKind!==publicKind(old))return fail("CONFLICT",409);
    const change=await db.prepare("DELETE FROM drink_entries WHERE owner_id=? AND source_id=?"+
      " AND source_row_key=? AND observed_at=? AND drink_kind=? AND drink_variant IS ?"+
      " AND cups=? AND size_label IS ? AND volume_ml IS ? AND abv_pct IS ?")
      .bind(owner,old.sourceId,key,old.observedAt,old.storedKind,old.variant,old.cups,
        old.size,old.volumeMl,old.abvPct).run();
    return change.meta?.changes===1?json({status:"deleted",key}):fail("CONFLICT",409);
  }
  if(!isDrinkKind(p.kind)||!validObserved(p.observedAt))return fail("DRINK");
  const kind=p.kind,at=p.observedAt,alcohol=kind==="non_alcohol"?0:1;
  const storedKind=storedDrinkKind(kind),variant=drinkVariant(kind);
  const sourceId=drinkSourceId(kind);
  const cups=optionalAmount(p,"cups",old&&req.method==="PATCH"?old.cups:1);
  const volumeMl=optionalAmount(p,"volumeMl",old&&req.method==="PATCH"?old.volumeMl:null);
  const abvPct=optionalAmount(p,"abvPct",
    old&&req.method==="PATCH"&&kind!=="non_alcohol"?old.abvPct:null);
  const size=optionalAmount(p,"size",old&&req.method==="PATCH"?old.size:null);
  if(!validSize(size)||!validDrinkAmounts(kind,cups,volumeMl,abvPct))return fail("DRINK_AMOUNT");
  if(req.method==="POST"){
    if(old){
      return old.observedAt===at&&publicKind(old)===kind&&old.cups===cups&&
        old.volumeMl===volumeMl&&old.abvPct===abvPct&&old.size===size
        ?json({status:"saved",key}):fail("CONFLICT",409);
    }
    await db.prepare("INSERT OR IGNORE INTO drink_entries"+
      "(id,owner_id,observed_at,drink_kind,drink_variant,alcohol,cups,volume_ml,abv_pct,size_label,source_id,source_row_key)"+
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind("manual:drink:"+key,owner,at,storedKind,variant,alcohol,cups,volumeMl,abvPct,size,sourceId,key).run();
    const current=await db.prepare(
      "SELECT observed_at AS observedAt,drink_kind AS storedKind,drink_variant AS variant,"+
      " source_id AS sourceId,cups,volume_ml AS volumeMl,abv_pct AS abvPct,size_label AS size"+
      " FROM drink_entries WHERE owner_id=? AND source_id=? AND source_row_key=?"
    ).bind(owner,sourceId,key).first<StoredDrink>();
    return current?.observedAt===at && current.storedKind===storedKind &&
      current.variant===variant && current.cups===cups &&
      current.volumeMl===volumeMl && current.abvPct===abvPct && current.size===size
      ?json({status:"saved",key}):fail("CONFLICT",409);
  }
  if(req.method==="PATCH"){
    if(!old)return fail("NOT_FOUND",404);
    if(p.expectedObservedAt!==old.observedAt||p.expectedKind!==publicKind(old)||
       (p.expectedCups!==undefined&&p.expectedCups!==old.cups)||
       (p.expectedVolumeMl!==undefined&&p.expectedVolumeMl!==old.volumeMl)||
       (p.expectedAbvPct!==undefined&&p.expectedAbvPct!==old.abvPct)||
       (p.expectedSize!==undefined&&p.expectedSize!==old.size))return fail("CONFLICT",409);
    const changed=await db.prepare(
      "UPDATE drink_entries SET observed_at=?,drink_kind=?,drink_variant=?,alcohol=?,cups=?,"+
      " volume_ml=?,abv_pct=?,size_label=?,source_id=?"+
      " WHERE owner_id=? AND source_id=? AND source_row_key=?"+
      " AND observed_at=? AND drink_kind=? AND drink_variant IS ?"+
      " AND cups=? AND volume_ml IS ? AND abv_pct IS ? AND size_label IS ?"
    ).bind(at,storedKind,variant,alcohol,cups,volumeMl,abvPct,size,sourceId,
      owner,old.sourceId,key,old.observedAt,old.storedKind,old.variant,old.cups,
      old.volumeMl,old.abvPct,old.size).run();
    return changed.meta?.changes===1?json({status:"updated",key}):fail("CONFLICT",409);
  }
  return fail("METHOD",405);
}
async function experiments(req:Request,db:MvpDb,owner:string){
  if(req.method==="GET"){
    const rows=await db.prepare("SELECT e.id AS id,h.statement AS statement,h.support_text AS supportText,"+
      "h.counterevidence_text AS counterText,h.unknown_text AS unknownText,h.status AS status,"+
      "e.starts_on AS startsOn,e.ends_on AS endsOn,e.target_action AS targetAction,"+
      "e.baseline_text AS baselineText,"+
      "e.outcome_text AS outcomeText,e.user_decision AS decision "+
      "FROM behavior_experiments e JOIN behavior_hypotheses h ON h.id=e.hypothesis_id AND h.owner_id=e.owner_id "+
      "WHERE e.owner_id=? ORDER BY e.starts_on DESC,e.id DESC LIMIT 21").bind(owner)
      .all<{id:string;statement:string;supportText:string|null;counterText:string|null;unknownText:string|null;status:string;startsOn:string;endsOn:string;targetAction:string;baselineText:string|null;outcomeText:string|null;decision:string|null}>();
    if(rows.results.length>20)return fail("TOO_MANY",422);
    return json({experiments:rows.results});
  }
  const p=await body(req);
  if(!p||typeof p.id!=="string"||!uuid.test(p.id))return fail("PAYLOAD",400);
  const id=p.id.toLowerCase();
  if(req.method==="POST"){
    if(p.baselineText!==undefined&&p.baselineText!==null&&
      (typeof p.baselineText!=="string"||p.baselineText.length>1200))return fail("PLAN");
    if(!validText(p.statement)||!validText(p.targetAction)||
      !validCalendarDay(p.startsOn)||!validCalendarDay(p.endsOn)||
      p.startsOn>p.endsOn||p.endsOn>new Date(Date.now()+9*3600000+366*dayMs).toISOString().slice(0,10)||
      (millis(p.endsOn)-millis(p.startsOn))/dayMs>90)return fail("PLAN");
    // Only one live experiment at a time; no duplicate retry creates extra rows.
    const existing=await db.prepare(
      "SELECT id,target_action AS action,baseline_text AS baselineText FROM behavior_experiments "+
      "WHERE id=? AND owner_id=?").bind(id,owner).first<{
        id:string;action:string;baselineText:string|null
      }>();
    // A replay with a different stated goal must not silently report success.
    if(existing)return existing.action===p.targetAction&&
      existing.baselineText===(p.baselineText??null)
      ?json({status:"saved",id}):fail("CONFLICT",409);
    const active=await db.prepare("SELECT id FROM behavior_experiments WHERE owner_id=? AND user_decision IS NULL LIMIT 1")
      .bind(owner).first<{id:string}>();
    if(active)return fail("ACTIVE_EXISTS",409);
    if(!db.batch)return fail("TRANSACTION_UNAVAILABLE",503);
    const textField=(value:unknown)=>typeof value==="string"&&value.length<=1200?value:null;
    await db.batch([
      db.prepare("INSERT INTO behavior_hypotheses (id,owner_id,statement,support_text,counterevidence_text,unknown_text,status,created_at) "+
        "VALUES (?,?,?,?,?,?,'active',?)").bind("h:"+id,owner,p.statement,textField(p.supportText),textField(p.counterText),
          textField(p.unknownText),new Date().toISOString()),
      db.prepare("INSERT INTO behavior_experiments (id,owner_id,hypothesis_id,starts_on,ends_on,target_action,baseline_text) "+
        "VALUES (?,?,?,?,?,?,?)").bind(id,owner,"h:"+id,p.startsOn,p.endsOn,p.targetAction,textField(p.baselineText))
    ]);
    return json({status:"saved",id});
  }
  if(req.method==="PUT"){
    // Correct only the Owner's undecided plan: no hypothesis rewrite or
    // measurement updates. Original visible values are a compare-and-swap gate.
    const permitted=["id","targetAction","startsOn","endsOn",
      "expectedTargetAction","expectedStartsOn","expectedEndsOn",
      "baselineText","expectedBaselineText"];
    const hasOwn=(key:string)=>Object.prototype.hasOwnProperty.call(p,key);
    const editingGoal=hasOwn("baselineText")||hasOwn("expectedBaselineText");
    const validNote=(value:unknown)=>value===null||
      (typeof value==="string"&&value.length<=1200);
    if(Object.keys(p).some(key=>!permitted.includes(key))||
      (editingGoal&&(!hasOwn("baselineText")||!hasOwn("expectedBaselineText")||
        !validNote(p.baselineText)||!validNote(p.expectedBaselineText)))||
      !validText(p.targetAction)||!validText(p.expectedTargetAction)||
      !validCalendarDay(p.startsOn)||!validCalendarDay(p.endsOn)||
      !validCalendarDay(p.expectedStartsOn)||!validCalendarDay(p.expectedEndsOn)||
      p.startsOn>p.endsOn||
      p.endsOn>new Date(Date.now()+9*3600000+366*dayMs).toISOString().slice(0,10)||
      (millis(p.endsOn)-millis(p.startsOn))/dayMs>90)return fail("PLAN");
    const current=await db.prepare(
      "SELECT target_action AS targetAction,starts_on AS startsOn,ends_on AS endsOn,"+
      "baseline_text AS baselineText,user_decision AS decision FROM behavior_experiments WHERE id=? AND owner_id=?"
    ).bind(id,owner).first<{targetAction:string;startsOn:string;endsOn:string;baselineText:string|null;decision:string|null}>();
    if(!current)return fail("NOT_FOUND",404);
    if(current.decision!==null)return fail("ALREADY_DECIDED",409);
    // Older clients omit the note entirely: preserve its current value.
    const goal=editingGoal?p.baselineText as string|null:current.baselineText;
    const expectedGoal=editingGoal?p.expectedBaselineText as string|null:current.baselineText;
    // A lost success response may be retried without changing anything.
    if(current.targetAction===p.targetAction&&current.startsOn===p.startsOn&&
      current.endsOn===p.endsOn&&current.baselineText===goal)return json({status:"unchanged",id});
    if(current.targetAction!==p.expectedTargetAction||
      current.startsOn!==p.expectedStartsOn||
      current.endsOn!==p.expectedEndsOn||current.baselineText!==expectedGoal)return fail("CONFLICT",409);
    const updated=await db.prepare(
      "UPDATE behavior_experiments SET target_action=?,starts_on=?,ends_on=?,baseline_text=? "+
      "WHERE id=? AND owner_id=? AND user_decision IS NULL "+
      "AND target_action=? AND starts_on=? AND ends_on=? AND baseline_text IS ?"
    ).bind(p.targetAction,p.startsOn,p.endsOn,goal,id,owner,
      p.expectedTargetAction,p.expectedStartsOn,p.expectedEndsOn,expectedGoal).run();
    return updated.meta?.changes===1?json({status:"updated",id}):fail("CONFLICT",409);
  }
  if(req.method==="PATCH"){
    const decisions=["continue","revise","stop","unknown"];
    if(!decisions.includes(String(p.decision))||
      typeof p.outcomeText!=="string"||p.outcomeText.length>1200)return fail("DECISION");
    if(!db.batch)return fail("TRANSACTION_UNAVAILABLE",503);
    const current=await db.prepare("SELECT user_decision AS decision FROM behavior_experiments WHERE id=? AND owner_id=?")
      .bind(id,owner).first<{decision:string|null}>();
    if(!current)return fail("NOT_FOUND",404);
    if(current.decision)return fail("ALREADY_DECIDED",409);
    await db.batch([
      db.prepare("UPDATE behavior_experiments SET user_decision=?,outcome_text=? WHERE id=? AND owner_id=? AND user_decision IS NULL")
        .bind(p.decision,p.outcomeText,id,owner),
      db.prepare("UPDATE behavior_hypotheses SET status='closed' WHERE id=? AND owner_id=?")
        .bind("h:"+id,owner),
    ]);
    return json({status:"decided",id});
  }
  return fail("METHOD",405);
}

type MealKind="home"|"restaurant"|"takeout"|null;
type MealFields={day:string;lunchKind:MealKind;dinnerKind:MealKind;lateMeal:0|1|null};
const isMealKind=(x:unknown):x is MealKind=>x===null||x==="home"||x==="restaurant"||x==="takeout";
const isLate=(x:unknown):x is 0|1|null=>x===null||x===0||x===1;
const fields=(p:unknown):p is MealFields=>{
  if(!p||typeof p!=="object"||Array.isArray(p))return false;
  const obj=p as Record<string,unknown>;
  return validDay(obj.day)&&isMealKind(obj.lunchKind)&&
    isMealKind(obj.dinnerKind)&&isLate(obj.lateMeal);
};
type MealRow=MealFields;
async function meals(req:Request,db:MvpDb,owner:string){
  if(req.method==="GET"){
    const q=new URL(req.url).searchParams;
    if([...q.keys()].some(x=>!["from","to"].includes(x)))return fail("RANGE",400);
    const p=range(q.get("from")??new Date(Date.now()+9*3600000-29*dayMs).toISOString().slice(0,10),
      q.get("to")??today(),31);
    if(!p)return fail("RANGE",400);
    const rows=await db.prepare("SELECT local_day AS day,lunch_kind AS lunchKind,dinner_kind AS dinnerKind,late_meal AS lateMeal "+
      "FROM lifestyle_days WHERE owner_id=? AND source_id='manual:meals' AND local_day>=? AND local_day<=? ORDER BY local_day DESC LIMIT 32")
      .bind(owner,p.from,p.to).all<MealRow>();
    if(rows.results.length>31)return fail("TOO_MANY",422);
    return json({entries:rows.results});
  }
  const p=await body(req);
  if(!p||!validDay(p.day))return fail("DAY");
  const day=p.day;
  const current=await db.prepare("SELECT local_day AS day,lunch_kind AS lunchKind,dinner_kind AS dinnerKind,late_meal AS lateMeal "+
    "FROM lifestyle_days WHERE owner_id=? AND source_id='manual:meals' AND local_day=?")
    .bind(owner,day).first<MealRow>();
  const expected=p.expected;
  if(req.method==="DELETE"){
    if(!current)return fail("NOT_FOUND",404);
    if(!fields(expected)||expected.day!==day||expected.lunchKind!==current.lunchKind||
      expected.dinnerKind!==current.dinnerKind||expected.lateMeal!==current.lateMeal)return fail("CONFLICT",409);
    const change=await db.prepare("DELETE FROM lifestyle_days WHERE owner_id=? AND local_day=? AND source_id='manual:meals' "+
      "AND lunch_kind IS ? AND dinner_kind IS ? AND late_meal IS ?")
      .bind(owner,day,expected.lunchKind,expected.dinnerKind,expected.lateMeal).run();
    return change.meta?.changes===1?json({status:"deleted",day}):fail("CONFLICT",409);
  }
  if(req.method!=="PUT")return fail("METHOD",405);
  if(!fields(p))return fail("MEAL_FIELDS");
  if(current){
    if(!fields(expected)||expected.day!==day||expected.lunchKind!==current.lunchKind||
      expected.dinnerKind!==current.dinnerKind||expected.lateMeal!==current.lateMeal)
      return fail("CONFLICT",409);
    const changed=await db.prepare("UPDATE lifestyle_days SET lunch_kind=?,dinner_kind=?,late_meal=? "+
      "WHERE owner_id=? AND local_day=? AND source_id='manual:meals' "+
      "AND lunch_kind IS ? AND dinner_kind IS ? AND late_meal IS ?")
      .bind(p.lunchKind,p.dinnerKind,p.lateMeal,owner,day,
        expected.lunchKind,expected.dinnerKind,expected.lateMeal).run();
    return changed.meta?.changes===1?json({status:"updated",day}):fail("CONFLICT",409);
  }
  if(expected!==null)return fail("CONFLICT",409);
  await db.prepare("INSERT OR IGNORE INTO lifestyle_days "+
    "(owner_id,local_day,lunch_kind,dinner_kind,late_meal,source_id,source_row_key) "+
    "VALUES (?,?,?,?,?,'manual:meals',?)")
    .bind(owner,day,p.lunchKind,p.dinnerKind,p.lateMeal,day).run();
  const row=await db.prepare("SELECT lunch_kind AS lunchKind,dinner_kind AS dinnerKind,late_meal AS lateMeal "+
    "FROM lifestyle_days WHERE owner_id=? AND local_day=? AND source_id='manual:meals'")
    .bind(owner,day).first<Omit<MealRow,"day">>();
  return row?.lunchKind===p.lunchKind&&row.dinnerKind===p.dinnerKind&&row.lateMeal===p.lateMeal
    ?json({status:"saved",day}):fail("CONFLICT",409);
}

type OutingRow={key:string;day:string;category:"work"|"bar"|"other"};
const outingCategory=(x:unknown)=>x==="work"||x==="bar"||x==="other";
async function outings(req:Request,db:MvpDb,owner:string){
  if(req.method==="GET"){
    const q=new URL(req.url).searchParams;
    if([...q.keys()].some(x=>!["from","to"].includes(x)))return fail("RANGE",400);
    const p=range(q.get("from")??new Date(Date.now()+9*3600000-29*dayMs).toISOString().slice(0,10),
      q.get("to")??today(),31);
    if(!p)return fail("RANGE",400);
    const rows=await db.prepare("SELECT source_row_key AS key,local_day AS day,category "+
      "FROM outings WHERE owner_id=? AND source_id='manual:outing' AND local_day>=? AND local_day<=? "+
      "ORDER BY local_day DESC,id DESC LIMIT 501").bind(owner,p.from,p.to).all<OutingRow>();
    if(rows.results.length>500)return fail("TOO_MANY",422);
    return json({entries:rows.results});
  }
  const p=await body(req);
  if(!p||typeof p.key!=="string"||!uuid.test(p.key))return fail("KEY");
  const key=p.key.toLowerCase();
  const old=await db.prepare("SELECT local_day AS day,category FROM outings "+
    "WHERE owner_id=? AND source_id='manual:outing' AND source_row_key=?")
    .bind(owner,key).first<{day:string;category:string}>();
  if(req.method==="DELETE"){
    if(!old)return fail("NOT_FOUND",404);
    if(p.expectedDay!==old.day||p.expectedCategory!==old.category)return fail("CONFLICT",409);
    const change=await db.prepare("DELETE FROM outings WHERE owner_id=? AND source_id='manual:outing' "+
      "AND source_row_key=? AND local_day=? AND category=?")
      .bind(owner,key,old.day,old.category).run();
    return change.meta?.changes===1?json({status:"deleted",key}):fail("CONFLICT",409);
  }
  if(!validDay(p.day)||!outingCategory(p.category))return fail("OUTING");
  if(req.method==="POST"){
    await db.prepare("INSERT OR IGNORE INTO outings(id,owner_id,local_day,category,source_id,source_row_key) "+
      "VALUES (?,?,?,?,'manual:outing',?)")
      .bind("manual:outing:"+key,owner,p.day,p.category,key).run();
    const row=await db.prepare("SELECT local_day AS day,category FROM outings "+
      "WHERE owner_id=? AND source_id='manual:outing' AND source_row_key=?")
      .bind(owner,key).first<{day:string;category:string}>();
    return row?.day===p.day&&row.category===p.category?json({status:"saved",key}):fail("CONFLICT",409);
  }
  if(req.method==="PATCH"){
    if(!old)return fail("NOT_FOUND",404);
    if(p.expectedDay!==old.day||p.expectedCategory!==old.category)return fail("CONFLICT",409);
    const change=await db.prepare("UPDATE outings SET local_day=?,category=? "+
      "WHERE owner_id=? AND source_id='manual:outing' AND source_row_key=? AND local_day=? AND category=?")
      .bind(p.day,p.category,owner,key,old.day,old.category).run();
    return change.meta?.changes===1?json({status:"updated",key}):fail("CONFLICT",409);
  }
  return fail("METHOD",405);
}

const csvSafe=(x:unknown)=>{
  const value=x===null||x===undefined?"":String(x);
  // Prevent formula execution when opened in common spreadsheet programs.
  const safe=/^[=+\-@\t\r]/.test(value)?"'"+value:value;
  return '"'+safe.replace(/"/g,'""')+'"';
};
async function exportCsv(req:Request,db:MvpDb,owner:string):Promise<Response>{
  const q=new URL(req.url).searchParams;
  if([...q.keys()].some(k=>!["from","to"].includes(k))||
    q.getAll("from").length!==1||q.getAll("to").length!==1)return fail("RANGE",400);
  const p=range(q.get("from"),q.get("to"),366);
  if(!p)return fail("RANGE",400);
  const [a,b]=dateBounds(p);
  const parts:unknown[][]=[["record_type","observed_at_or_day","value","unit","source","detail","value_state"]];
  const w=await db.prepare("SELECT measured_at,weight_kg,source_id,source_kind FROM body_measurements "+
    "WHERE owner_id=? AND unixepoch(measured_at)>=? AND unixepoch(measured_at)<? LIMIT 10001").bind(owner,a,b)
    .all<{measured_at:string;weight_kg:number|null;source_id:string;source_kind:string}>();
  for(const x of w.results)parts.push(["weight",x.measured_at,x.weight_kg,"kg",x.source_id,x.source_kind]);
  const steps=await db.prepare("SELECT local_day,steps,source_id FROM activity_daily "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? LIMIT 10001").bind(owner,p.from,p.to)
    .all<{local_day:string;steps:number|null;source_id:string}>();
  for(const x of steps.results)parts.push(["steps",x.local_day,x.steps,"steps",x.source_id,"activity"]);
  const lifestyle=await db.prepare("SELECT local_day,drinking_presence,drink_cups,lunch_kind,dinner_kind,late_meal,steps,source_id "+
    "FROM lifestyle_days WHERE owner_id=? AND local_day>=? AND local_day<=? LIMIT 10001").bind(owner,p.from,p.to)
    .all<{local_day:string;drinking_presence:number|null;drink_cups:number|null;lunch_kind:string|null;dinner_kind:string|null;late_meal:number|null;steps:number|null;source_id:string}>();
  for(const x of lifestyle.results)for(const [key,value] of Object.entries(x)){
    if(!["local_day","source_id"].includes(key))parts.push([key,x.local_day,value,"",x.source_id,"lifestyle"]);
  }
  const drinks=await db.prepare(
    "SELECT observed_at,drink_kind,drink_variant,size_label,alcohol,cups,volume_ml,abv_pct,source_id FROM drink_entries "+
    "WHERE owner_id=? AND unixepoch(observed_at)>=? AND unixepoch(observed_at)<? LIMIT 10001"
  ).bind(owner,a,b).all<D&{source_id:string}>();
  for(const x of drinks.results){
    const label=publicDrinkKind(x.drink_kind,x.drink_variant,x.source_id);
    const assessment=assessDrinkAlcohol({
      kind:label,cups:x.cups,volumeMl:x.volume_ml,abvPct:x.abv_pct,alcohol:x.alcohol
    });
    parts.push(["drink",x.observed_at,x.cups,"ordered_cups",x.source_id,label]);
    parts.push(["drink_size",x.observed_at,x.size_label,"size",x.source_id,label]);
    parts.push(["drink_volume_per_cup",x.observed_at,x.volume_ml,"ml",x.source_id,label]);
    parts.push(["drink_abv",x.observed_at,x.abv_pct,"percent",x.source_id,label]);
    parts.push(["drink_pure_alcohol",x.observed_at,
      pureAlcoholGrams({cups:x.cups,volumeMl:x.volume_ml,abvPct:x.abv_pct,alcohol:x.alcohol}),
      "g",x.source_id,label]);
    parts.push(["drink_estimated_pure_alcohol",x.observed_at,
      assessment.basis==="estimated"?assessment.grams:null,"g",x.source_id,label]);
    parts.push(["drink_alcohol_basis",x.observed_at,assessment.basis,"basis",x.source_id,label]);
    parts.push(["drink_estimate_rule",x.observed_at,assessment.ruleVersion,"version",x.source_id,label]);
  }
  const outings=await db.prepare("SELECT local_day,category,source_id FROM outings "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? LIMIT 10001").bind(owner,p.from,p.to)
    .all<{local_day:string;category:string;source_id:string}>();
  for(const x of outings.results)parts.push(["outing",x.local_day,1,"visit",x.source_id,x.category]);
  if([w,steps,lifestyle,drinks,outings].some(x=>x.results.length>10000))return fail("TOO_MANY",422);
  // Keep the original six columns stable. The seventh disambiguates NULL from an
  // explicitly recorded empty string and from the actual numeric zero.
  const csv="\uFEFF"+parts.map((row,i)=>(i===0?row:
    [...row,row[2]===null||row[2]===undefined?"null":"present"])
    .map(csvSafe).join(",")).join("\r\n")+"\r\n";
  return new Response(csv,{headers:{...headers,"Content-Type":"text/csv; charset=utf-8",
    "Content-Disposition":'attachment; filename="life-log-'+p.from+"-"+p.to+'.csv"'}});
}
export async function handleMvpFeatures(req:Request,db:MvpDb,owner:string,config:MvpConfig={}):Promise<Response>{
  const path=new URL(req.url).pathname;
  const method=req.method;
  const pathMethods:Record<string,string[]>={
    "/api/mvp/compare":["GET"],"/api/mvp/metrics":["GET"],"/api/mvp/lag":["GET"],"/api/mvp/drinks":["GET","POST","PATCH","DELETE"],
    "/api/mvp/experiments":["GET","POST","PUT","PATCH"],"/api/mvp/experiments/evidence":["GET"],"/api/mvp/export":["GET"],
    "/api/mvp/meals":["GET","PUT","DELETE"],"/api/mvp/outings":["GET","POST","PATCH","DELETE"]
  };
  if(!pathMethods[path])return fail("NOT_FOUND",404);
  if(!pathMethods[path].includes(method))return fail("METHOD",405);
  if(method!=="GET"&&!allowWrite(req,config))return fail("WRITE_DISABLED",403);
  try{
    if(path==="/api/mvp/metrics")return await handleAnalysisMetrics(req,db,owner);
    if(path==="/api/mvp/lag")return await handleLagAnalysis(req,db,owner);
    if(path==="/api/mvp/compare")return await compare(req,db,owner);
    if(path==="/api/mvp/drinks")return method==="GET"
      ?await listDrinks(req,db,owner)
      :await writeDrink(req,db,owner,(await body(req))??{});
    if(path==="/api/mvp/experiments")return await experiments(req,db,owner);
    if(path==="/api/mvp/experiments/evidence")return await experimentEvidence(req,db,owner);
    if(path==="/api/mvp/meals")return await meals(req,db,owner);
    if(path==="/api/mvp/outings")return await outings(req,db,owner);
    return await exportCsv(req,db,owner);
  }catch{return fail("DATA_UNAVAILABLE",503);}
}
