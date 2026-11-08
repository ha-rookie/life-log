import { dateRange, defaultRange, jstDay, parseDay } from "../shared/weight-trend";

type Entry={local_day:string;steps:number|null;source_id:string};
type Statement={bind(...values:unknown[]):{all<T>():Promise<{results:T[]}>}};
export type StepsTrendDb={prepare(sql:string):Statement};
export type StepDay={day:string;steps:number|null;source:"Google Fit"|"手入力"|null};
export type StepsTrend={
  from:string;to:string;timezone:"Asia/Tokyo";days:StepDay[];
  observedDays:number;missingDays:number;zeroDays:number;meanSteps:number|null;
};
const HEADERS={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const reply=(data:unknown,code=200)=>Response.json(data,{status:code,headers:HEADERS});
const DAY_MS=86400000;
export function isFitSource(s:string):boolean {
  return s==="fit"||s==="google_fit"||s==="google-fit"||
    s.startsWith("fit:")||s.startsWith("google_fit:")||s.startsWith("google-fit:")||
    s.startsWith("csv:fit")||s.startsWith("csv:google_fit")||s.startsWith("csv:google-fit");
}
export function buildStepsTrend(rows:readonly Entry[],from:string,to:string):StepsTrend {
  const range=dateRange(from,to);
  if(!range)throw Error("INVALID_RANGE");
  const chosen=new Map<string,{steps:number;rank:number;source:"Google Fit"|"手入力"}>();
  for(const row of rows){
    if(row.steps===null||!Number.isSafeInteger(row.steps)||row.steps<0||
      row.local_day<from||row.local_day>to)continue;
    const rank=isFitSource(row.source_id)?0:row.source_id.startsWith("manual:")?1:2;
    if(rank===2)continue;
    const previous=chosen.get(row.local_day);
    if(!previous||rank<previous.rank){
      chosen.set(row.local_day,{
        steps:row.steps,rank,source:rank===0?"Google Fit":"手入力",
      });
    }
  }
  const days:StepDay[]=Array.from({length:range.days},(_,i)=>{
    const day=new Date(range.start+i*DAY_MS).toISOString().slice(0,10);
    const found=chosen.get(day);
    return {day,steps:found?.steps??null,source:found?.source??null};
  });
  const observed=days.filter(x=>x.steps!==null);
  return {
    from,to,timezone:"Asia/Tokyo",days,
    observedDays:observed.length,missingDays:range.days-observed.length,
    zeroDays:observed.filter(x=>x.steps===0).length,
    meanSteps:observed.length?Math.round(observed.reduce((sum,x)=>sum+x.steps!,0)/observed.length):null,
  };
}
export async function handleStepsTrend(request:Request,db:StepsTrendDb,owner:string):Promise<Response> {
  if(request.method!=="GET")return reply({error:"METHOD"},405);
  const url=new URL(request.url);
  if([...url.searchParams.keys()].some(k=>k!=="from"&&k!=="to")||
    url.searchParams.getAll("from").length>1||url.searchParams.getAll("to").length>1)
    return reply({error:"INVALID_RANGE"},400);
  let from:string,to:string;
  if(!url.search){
    const range=defaultRange(Date.now());
    from=range.from;to=range.to;
  }else{
    from=url.searchParams.get("from")??"";
    to=url.searchParams.get("to")??"";
  }
  const window=dateRange(from,to);
  if(!window||to>jstDay(Date.now())||parseDay(from)===null)return reply({error:"INVALID_RANGE"},400);
  try{
    const result=await db.prepare(
      "SELECT local_day,steps,source_id FROM activity_daily "+
      "WHERE owner_id=? AND local_day>=? AND local_day<=? "+
      "ORDER BY local_day,source_id LIMIT 10001"
    ).bind(owner,from,to).all<Entry>();
    if(result.results.length>10000)return reply({error:"TOO_MANY_RECORDS"},422);
    return reply(buildStepsTrend(result.results,from,to));
  }catch{
    return reply({error:"DATA_UNAVAILABLE"},503);
  }
}
