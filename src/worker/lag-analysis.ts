/** Read-only Owner-scoped weekly lag evidence, never writes observations. */
import { buildLagEvidence } from "../shared/lag-analysis";
import { type MetricBodyRow,type MetricStepRow,type MetricLifestyleRow,
  type MetricDrinkRow } from "../shared/analysis-metrics";
import { jstDay,parseDay } from "../shared/weight-trend";
import type { MetricDb } from "./analysis-metrics";
const DAY=86400000;
const headers={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
export async function handleLagAnalysis(req:Request,db:MetricDb,owner:string):Promise<Response>{
  if(req.method!=="GET")return json({error:"METHOD"},405);
  const q=new URL(req.url).searchParams;
  if([...q.keys()].some(k=>k!=="asOf")||q.getAll("asOf").length>1)
    return json({error:"RANGE"},400);
  const now=jstDay(Date.now()),asOf=q.get("asOf")??now;
  const end=parseDay(asOf),current=parseDay(now);
  if(end===null||current===null||end>current||end<current-365*DAY)
    return json({error:"RANGE"},400);
  const weekday=new Date(end).getUTCDay();
  const lastSunday=end-(weekday===0?7:weekday)*DAY;
  const from=new Date(lastSunday-83*DAY).toISOString().slice(0,10);
  const until=new Date(lastSunday).toISOString().slice(0,10);
  const lower=Math.floor(Date.parse(from+"T00:00:00+09:00")/1000);
  const upper=Math.floor(Date.parse(until+"T00:00:00+09:00")/1000)+86400;
  try{
    const [bodies,steps,lifestyles,drinks]=await Promise.all([
      db.prepare("SELECT id,measured_at,source_id,source_kind,anomaly_flag,weight_kg,"+
        "body_fat_pct,skeletal_muscle_pct,bmi,visceral_fat_level,bone_mass_kg,"+
        "basal_metabolism_kcal FROM body_measurements "+
        "WHERE owner_id=? AND unixepoch(measured_at)>=? AND unixepoch(measured_at)<? "+
        "ORDER BY measured_at,id LIMIT 10001").bind(owner,lower,upper).all<MetricBodyRow>(),
      db.prepare("SELECT local_day,steps,source_id FROM activity_daily "+
        "WHERE owner_id=? AND local_day>=? AND local_day<=? ORDER BY local_day,source_id LIMIT 10001")
        .bind(owner,from,until).all<MetricStepRow>(),
      db.prepare("SELECT local_day,drinking_presence,source_id FROM lifestyle_days "+
        "WHERE owner_id=? AND local_day>=? AND local_day<=? ORDER BY local_day,source_id LIMIT 10001")
        .bind(owner,from,until).all<MetricLifestyleRow>(),
      db.prepare("SELECT observed_at,drink_kind,drink_variant,source_id,alcohol,cups,volume_ml,abv_pct "+
        "FROM drink_entries WHERE owner_id=? AND unixepoch(observed_at)>=? "+
        "AND unixepoch(observed_at)<? ORDER BY observed_at LIMIT 10001")
        .bind(owner,lower,upper).all<MetricDrinkRow>()
    ]);
    if([bodies,steps,lifestyles,drinks].some(x=>x.results.length>10000))
      return json({error:"TOO_MANY"},422);
    return json(buildLagEvidence({bodies:bodies.results,steps:steps.results,
      lifestyles:lifestyles.results,drinks:drinks.results},asOf));
  }catch{
    return json({error:"DATA_UNAVAILABLE"},503);
  }
}
