/** Owner-only GET metrics; read-only D1 queries, no persistence/backfill. */
import { buildAnalysisMetrics, type MetricBodyRow, type MetricStepRow,
  type MetricLifestyleRow, type MetricDrinkRow } from "../shared/analysis-metrics";
import { jstDay,parseDay } from "../shared/weight-trend";

type Statement={bind(...args:unknown[]):{
  all<T>():Promise<{results:T[]}>
}};
export type MetricDb={prepare(sql:string):Statement};
const privateHeaders={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const response=(value:unknown,status=200)=>Response.json(value,{status,headers:privateHeaders});
const DAY=86400000;
export async function handleAnalysisMetrics(req:Request,db:MetricDb,owner:string):Promise<Response>{
  if(req.method!=="GET")return response({error:"METHOD"},405);
  const q=new URL(req.url).searchParams;
  if([...q.keys()].some(k=>k!=="asOf")||q.getAll("asOf").length>1)
    return response({error:"RANGE"},400);
  const today=jstDay(Date.now());
  const asOf=q.get("asOf")??today;
  const end=parseDay(asOf),current=parseDay(today);
  if(end===null||current===null||end>current||end<current-365*DAY)
    return response({error:"RANGE"},400);
  const from=new Date(end-27*DAY).toISOString().slice(0,10);
  const min=Math.floor(Date.parse(from+"T00:00:00+09:00")/1000);
  const max=Math.floor(Date.parse(asOf+"T00:00:00+09:00")/1000)+86400;
  try{
    const [bodies,steps,lifestyles,drinks]=await Promise.all([
      db.prepare("SELECT id,measured_at,source_id,source_kind,anomaly_flag,weight_kg,"+
        "body_fat_pct,skeletal_muscle_pct,bmi,visceral_fat_level,bone_mass_kg,"+
        "basal_metabolism_kcal FROM body_measurements "+
        "WHERE owner_id=? AND unixepoch(measured_at)>=? AND unixepoch(measured_at)<? "+
        "ORDER BY measured_at,id LIMIT 10001").bind(owner,min,max).all<MetricBodyRow>(),
      db.prepare("SELECT local_day,steps,source_id FROM activity_daily "+
        "WHERE owner_id=? AND local_day>=? AND local_day<=? "+
        "ORDER BY local_day,source_id LIMIT 10001").bind(owner,from,asOf).all<MetricStepRow>(),
      db.prepare("SELECT local_day,drinking_presence,source_id FROM lifestyle_days "+
        "WHERE owner_id=? AND local_day>=? AND local_day<=? "+
        "ORDER BY local_day,source_id LIMIT 10001").bind(owner,from,asOf).all<MetricLifestyleRow>(),
      db.prepare("SELECT observed_at,drink_kind,drink_variant,source_id,alcohol,cups,volume_ml,abv_pct "+
        "FROM drink_entries WHERE owner_id=? AND unixepoch(observed_at)>=? "+
        "AND unixepoch(observed_at)<? ORDER BY observed_at LIMIT 10001")
        .bind(owner,min,max).all<MetricDrinkRow>()
    ]);
    if([bodies,steps,lifestyles,drinks].some(x=>x.results.length>10000))
      return response({error:"TOO_MANY"},422);
    return response(buildAnalysisMetrics({
      bodies:bodies.results,steps:steps.results,lifestyles:lifestyles.results,drinks:drinks.results
    },asOf));
  }catch{
    return response({error:"DATA_UNAVAILABLE"},503);
  }
}
