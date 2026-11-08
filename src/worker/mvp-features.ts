import { isSafeLocalManual, isSafeRemoteManual, type RemoteWriteConfig } from "./manual-entry";

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
const kinds=["highball","green_tea_high","other_alcohol","non_alcohol"] as const;
type Kind=typeof kinds[number];
const isKind=(s:unknown):s is Kind=>typeof s==="string"&&kinds.includes(s as Kind);
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const millis=(date:string)=>Date.parse(date+"T00:00:00Z");
const validDay=(d:unknown):d is string=>typeof d==="string"&&/^\d{4}-\d\d-\d\d$/.test(d)&&
  Number.isFinite(millis(d))&&new Date(millis(d)).toISOString().slice(0,10)===d&&d<=today();
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
type L={local_day:string;drinking_presence:number|null;drink_cups:number|null;lunch_kind:string|null;dinner_kind:string|null;source_id:string};
type D={id:string;observed_at:string;drink_kind:Kind;alcohol:number;cups:number;source_row_key:string};
const priority=(source:string)=>source.startsWith("manual:")?0:source.startsWith("eclear")?1:2;
const prefer=<T extends {source_id:string}>(old:T|undefined,next:T):T=>
  !old||priority(next.source_id)<priority(old.source_id)?next:old;
async function comparePeriod(db:MvpDb,owner:string,p:{from:string;to:string;days:number}){
  const [fromSec,toSec]=dateBounds(p);
  const weights=await db.prepare("SELECT id,measured_at,weight_kg,source_id,anomaly_flag FROM body_measurements "+
    "WHERE owner_id=? AND unixepoch(measured_at)>=? AND unixepoch(measured_at)<? "+
    "ORDER BY unixepoch(measured_at),id LIMIT 10001")
    .bind(owner,fromSec,toSec).all<W>();
  const steps=await db.prepare("SELECT local_day,steps,source_id FROM activity_daily "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? ORDER BY local_day,source_id LIMIT 10001")
    .bind(owner,p.from,p.to).all<S>();
  const lifestyles=await db.prepare("SELECT local_day,drinking_presence,drink_cups,lunch_kind,dinner_kind,source_id FROM lifestyle_days "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? ORDER BY local_day,source_id LIMIT 10001")
    .bind(owner,p.from,p.to).all<L>();
  const drinks=await db.prepare("SELECT id,observed_at,drink_kind,alcohol,cups,source_row_key FROM drink_entries "+
    "WHERE owner_id=? AND unixepoch(observed_at)>=? AND unixepoch(observed_at)<? LIMIT 10001")
    .bind(owner,fromSec,toSec).all<D>();
  if([weights,steps,lifestyles,drinks].some(x=>x.results.length>10000))throw Error("TOO_MANY");
  const measures=new Map<string,W>();
  for(const w of weights.results){
    if(w.weight_kg===null||w.anomaly_flag!==0)continue;
    measures.set(jstDate(w.measured_at),w);
  }
  const observed=[...measures.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const start=observed[0],end=observed.at(-1);
  const days=new Map<string,S>();
  for(const s of steps.results)if(s.steps!==null)days.set(s.local_day,prefer(days.get(s.local_day),s));
  const ls=new Map<string,L>();
  for(const l of lifestyles.results)ls.set(l.local_day,prefer(ls.get(l.local_day),l));
  // Do not impute drinking=0 for unobserved days or convert past 'drank' to one cup.
  const known=[...ls.values()].filter(l=>l.drinking_presence!==null);
  const stepValues=[...days.values()].map(s=>s.steps!).filter(n=>Number.isFinite(n));
  const lunch=[...ls.values()].filter(l=>l.lunch_kind!==null);
  const dinner=[...ls.values()].filter(l=>l.dinner_kind!==null);
  const alcoholCups=drinks.results.filter(x=>x.alcohol===1).reduce((a,x)=>a+x.cups,0);
  const nonAlcoholCups=drinks.results.filter(x=>x.alcohol===0).reduce((a,x)=>a+x.cups,0);
  return {
    from:p.from,to:p.to,calendarDays:p.days,
    weight:{
      startDay:start?.[0]??null,startKg:start?.[1].weight_kg??null,
      endDay:end?.[0]??null,endKg:end?.[1].weight_kg??null,
      deltaKg:start&&end&&observed.length>=2?Number((end[1].weight_kg!-start[1].weight_kg!).toFixed(2)):null,
      observedDays:observed.length,missingDays:p.days-observed.length,
    },
    steps:{mean:stepValues.length?Math.round(stepValues.reduce((a,b)=>a+b,0)/stepValues.length):null,
      observedDays:stepValues.length,missingDays:p.days-stepValues.length,zeroDays:stepValues.filter(x=>x===0).length,
      sources:[...new Set([...days.values()].map(x=>x.source_id))]},
    drinking:{observedDays:known.length,
      drinkingDays:known.filter(x=>x.drinking_presence===1).length,
      nondrinkingDays:known.filter(x=>x.drinking_presence===0).length,
      missingDays:p.days-known.length,
      recordedAlcoholCups:alcoholCups,recordedNonAlcoholCups:nonAlcoholCups,
      cupEntryCount:drinks.results.length},
    meals:{observedLunchDays:lunch.length,observedDinnerDays:dinner.length,
      restaurantLunchDays:lunch.filter(x=>x.lunch_kind==="restaurant").length,
      restaurantDinnerDays:dinner.filter(x=>x.dinner_kind==="restaurant").length,
      takeoutLunchDays:lunch.filter(x=>x.lunch_kind==="takeout").length,
      takeoutDinnerDays:dinner.filter(x=>x.dinner_kind==="takeout").length}
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
async function listDrinks(req:Request,db:MvpDb,owner:string){
  const q=new URL(req.url).searchParams;
  if([...q.keys()].some(k=>!["from","to"].includes(k)))return fail("RANGE",400);
  const p=range(q.get("from")??new Date(Date.now()+9*3600000-29*dayMs).toISOString().slice(0,10),
    q.get("to")??today(),60);
  if(!p)return fail("RANGE",400);
  const [a,b]=dateBounds(p);
  const rows=await db.prepare("SELECT source_row_key AS key,observed_at AS observedAt,drink_kind AS kind,alcohol,cups "+
    "FROM drink_entries WHERE owner_id=? AND source_id='manual:drink' "+
    "AND unixepoch(observed_at)>=? AND unixepoch(observed_at)<? "+
    "ORDER BY unixepoch(observed_at) DESC,id DESC LIMIT 501")
    .bind(owner,a,b).all<{key:string;observedAt:string;kind:Kind;alcohol:number;cups:number}>();
  if(rows.results.length>500)return fail("TOO_MANY",422);
  return json({from:p.from,to:p.to,entries:rows.results});
}
async function writeDrink(req:Request,db:MvpDb,owner:string,p:Record<string,unknown>){
  if(typeof p.key!=="string"||!uuid.test(p.key))return fail("KEY");
  const key=p.key.toLowerCase();
  const old=await db.prepare("SELECT observed_at AS observedAt,drink_kind AS kind FROM drink_entries "+
    "WHERE owner_id=? AND source_id='manual:drink' AND source_row_key=?").bind(owner,key)
    .first<{observedAt:string;kind:Kind}>();
  if(req.method==="DELETE"){
    if(!old)return fail("NOT_FOUND",404);
    if(p.expectedObservedAt!==old.observedAt||p.expectedKind!==old.kind)return fail("CONFLICT",409);
    await db.prepare("DELETE FROM drink_entries WHERE owner_id=? AND source_id='manual:drink' "+
      "AND source_row_key=? AND observed_at=? AND drink_kind=?")
      .bind(owner,key,old.observedAt,old.kind).run();
    return json({status:"deleted",key});
  }
  if(!isKind(p.kind)||!validObserved(p.observedAt))return fail("DRINK");
  const kind=p.kind,at=p.observedAt,alcohol=kind==="non_alcohol"?0:1;
  if(req.method==="POST"){
    await db.prepare("INSERT OR IGNORE INTO drink_entries "+
      "(id,owner_id,observed_at,drink_kind,alcohol,cups,source_id,source_row_key) "+
      "VALUES (?,?,?,?,?,1,'manual:drink',?)")
      .bind("manual:drink:"+key,owner,at,kind,alcohol,key).run();
    const current=await db.prepare("SELECT observed_at AS observedAt,drink_kind AS kind FROM drink_entries "+
      "WHERE owner_id=? AND source_id='manual:drink' AND source_row_key=?").bind(owner,key)
      .first<{observedAt:string;kind:Kind}>();
    return current?.observedAt===at&&current.kind===kind?json({status:"saved",key}):fail("CONFLICT",409);
  }
  if(req.method==="PATCH"){
    if(!old)return fail("NOT_FOUND",404);
    if(p.expectedObservedAt!==old.observedAt||p.expectedKind!==old.kind)return fail("CONFLICT",409);
    const change=await db.prepare("UPDATE drink_entries SET observed_at=?,drink_kind=?,alcohol=? "+
      "WHERE owner_id=? AND source_id='manual:drink' AND source_row_key=? "+
      "AND observed_at=? AND drink_kind=?")
      .bind(at,kind,alcohol,owner,key,old.observedAt,old.kind).run();
    return change.meta?.changes===1?json({status:"updated",key}):fail("CONFLICT",409);
  }
  return fail("METHOD",405);
}
async function experiments(req:Request,db:MvpDb,owner:string){
  if(req.method==="GET"){
    const rows=await db.prepare("SELECT e.id AS id,h.statement AS statement,h.support_text AS supportText,"+
      "h.counterevidence_text AS counterText,h.unknown_text AS unknownText,h.status AS status,"+
      "e.starts_on AS startsOn,e.ends_on AS endsOn,e.target_action AS targetAction,"+
      "e.outcome_text AS outcomeText,e.user_decision AS decision "+
      "FROM behavior_experiments e JOIN behavior_hypotheses h ON h.id=e.hypothesis_id AND h.owner_id=e.owner_id "+
      "WHERE e.owner_id=? ORDER BY e.starts_on DESC,e.id DESC LIMIT 21").bind(owner)
      .all<{id:string;statement:string;supportText:string|null;counterText:string|null;unknownText:string|null;status:string;startsOn:string;endsOn:string;targetAction:string;outcomeText:string|null;decision:string|null}>();
    if(rows.results.length>20)return fail("TOO_MANY",422);
    return json({experiments:rows.results});
  }
  const p=await body(req);
  if(!p||typeof p.id!=="string"||!uuid.test(p.id))return fail("PAYLOAD",400);
  const id=p.id.toLowerCase();
  if(req.method==="POST"){
    if(!validText(p.statement)||!validText(p.targetAction)||
      !validDay(p.startsOn)||!validDay(p.endsOn)||p.startsOn>p.endsOn||
      (millis(p.endsOn)-millis(p.startsOn))/dayMs>90)return fail("PLAN");
    // Only one live experiment at a time; no duplicate retry creates extra rows.
    const existing=await db.prepare("SELECT id,target_action AS action FROM behavior_experiments "+
      "WHERE id=? AND owner_id=?").bind(id,owner).first<{id:string;action:string}>();
    if(existing)return existing.action===p.targetAction?json({status:"saved",id}):fail("CONFLICT",409);
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
const csvSafe=(x:unknown)=>{
  const value=x===null||x===undefined?"":String(x);
  // Prevent formula execution when opened in common spreadsheet programs.
  const safe=/^[=+\-@\t\r]/.test(value)?"'"+value:value;
  return '"'+safe.replace(/"/g,'""')+'"';
};
async function exportCsv(req:Request,db:MvpDb,owner:string):Promise<Response>{
  const q=new URL(req.url).searchParams;
  if([...q.keys()].some(k=>!["from","to"].includes(k)))return fail("RANGE",400);
  const p=range(q.get("from"),q.get("to"),366);
  if(!p)return fail("RANGE",400);
  const [a,b]=dateBounds(p);
  const parts:unknown[][]=[["record_type","observed_at_or_day","value","unit","source","detail"]];
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
  const drinks=await db.prepare("SELECT observed_at,drink_kind,cups,source_id FROM drink_entries "+
    "WHERE owner_id=? AND unixepoch(observed_at)>=? AND unixepoch(observed_at)<? LIMIT 10001").bind(owner,a,b)
    .all<{observed_at:string;drink_kind:string;cups:number;source_id:string}>();
  for(const x of drinks.results)parts.push(["drink",x.observed_at,x.cups,"cups",x.source_id,x.drink_kind]);
  const outings=await db.prepare("SELECT local_day,category,source_id FROM outings "+
    "WHERE owner_id=? AND local_day>=? AND local_day<=? LIMIT 10001").bind(owner,p.from,p.to)
    .all<{local_day:string;category:string;source_id:string}>();
  for(const x of outings.results)parts.push(["outing",x.local_day,1,"visit",x.source_id,x.category]);
  if([w,steps,lifestyle,drinks,outings].some(x=>x.results.length>10000))return fail("TOO_MANY",422);
  const csv="\uFEFF"+parts.map(row=>row.map(csvSafe).join(",")).join("\r\n")+"\r\n";
  return new Response(csv,{headers:{...headers,"Content-Type":"text/csv; charset=utf-8",
    "Content-Disposition":'attachment; filename="life-log-'+p.from+"-"+p.to+'.csv"'}});
}
export async function handleMvpFeatures(req:Request,db:MvpDb,owner:string,config:MvpConfig={}):Promise<Response>{
  const path=new URL(req.url).pathname;
  const method=req.method;
  const pathMethods:Record<string,string[]>={
    "/api/mvp/compare":["GET"],"/api/mvp/drinks":["GET","POST","PATCH","DELETE"],
    "/api/mvp/experiments":["GET","POST","PATCH"],"/api/mvp/export":["GET"]
  };
  if(!pathMethods[path])return fail("NOT_FOUND",404);
  if(!pathMethods[path].includes(method))return fail("METHOD",405);
  if(method!=="GET"&&!allowWrite(req,config))return fail("WRITE_DISABLED",403);
  try{
    if(path==="/api/mvp/compare")return await compare(req,db,owner);
    if(path==="/api/mvp/drinks")return method==="GET"
      ?await listDrinks(req,db,owner)
      :await writeDrink(req,db,owner,(await body(req))??{});
    if(path==="/api/mvp/experiments")return await experiments(req,db,owner);
    return await exportCsv(req,db,owner);
  }catch{return fail("DATA_UNAVAILABLE",503);}
}
