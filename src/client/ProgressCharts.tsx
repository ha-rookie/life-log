import { useEffect, useMemo, useState } from "react";
import { redirectOnExpiredOwnerSession } from "./auth-recovery";
import { rangeForGranularity, type WeightTrend, type TrendGranularity } from "../shared/weight-trend";
import type { StepsTrend } from "../worker/steps-trend";

type Metric="weight"|"steps";
type Point={key:string;label:string;value:number|null;count:number};
type ChartState=
  |{kind:"loading"}|{kind:"error"}
  |{kind:"ok";weight:WeightTrend;steps:StepsTrend};
const formats:Record<TrendGranularity,string>={day:"30日",week:"12週",month:"12か月"};
const labels:Record<Metric,string>={weight:"体重",steps:"歩数"};
const dayMs=86400000;
const fmt=(n:number,metric:Metric)=>
  metric==="weight"?n.toFixed(1)+" kg":Math.round(n).toLocaleString("ja-JP")+" 歩";
function keyFor(day:string,granularity:TrendGranularity):string{
  if(granularity==="day")return day;
  if(granularity==="month")return day.slice(0,7);
  const ms=Date.parse(day+"T00:00:00Z");
  const weekday=(new Date(ms).getUTCDay()+6)%7;
  return new Date(ms-weekday*dayMs).toISOString().slice(0,10);
}
function labelFor(key:string,granularity:TrendGranularity):string{
  if(granularity==="month")return key.slice(5,7)+"月";
  return key.slice(5).replace("-","/");
}
export function groupProgress(
  days:readonly {day:string;value:number|null}[],granularity:TrendGranularity
):Point[]{
  if(granularity==="day")return days.map(d=>({
    key:d.day,label:labelFor(d.day,granularity),value:d.value,count:d.value===null?0:1
  }));
  const groups=new Map<string,{sum:number;count:number}>();
  for(const d of days){
    const key=keyFor(d.day,granularity);
    const current=groups.get(key)??{sum:0,count:0};
    if(d.value!==null){current.sum+=d.value;current.count++;}
    groups.set(key,current);
  }
  return [...groups].map(([key,v])=>({
    key,label:labelFor(key,granularity),count:v.count,
    value:v.count>0?v.sum/v.count:null
  }));
}
function Graph({metric,points}:{metric:Metric;points:Point[]}){
  const values=points.map(p=>p.value).filter((n):n is number=>n!==null);
  if(!values.length)return <p className="progress-empty">この期間の{labels[metric]}記録はありません。記録がない日を0とは扱いません。</p>;
  const accent=metric==="weight"?"#087c76":"#c17a2a";
  const min=metric==="steps"?0:Math.floor((Math.min(...values)-.5)*2)/2;
  const max=metric==="steps"?Math.max(...values,1)*1.12:Math.ceil((Math.max(...values)+.5)*2)/2;
  const ceiling=max<=min?min+1:max;
  const y=(v:number)=>132-(v-min)/(ceiling-min)*105;
  const left=42,right=318,width=right-left;
  const x=(i:number)=>left+(points.length===1?width/2:i*width/(points.length-1));
  const barWidth=Math.min(22,Math.max(3,(width/Math.max(points.length,1))*.62));
  const paths:string[]=[];
  let current="";
  if(metric==="weight"){
    points.forEach((p,i)=>{
      if(p.value===null){if(current)paths.push(current);current="";return;}
      const xy=x(i).toFixed(2)+","+y(p.value).toFixed(2);
      current+=(current?" L":"M")+xy;
    });
    if(current)paths.push(current);
  }
  const first=points[0],middle=points[Math.floor((points.length-1)/2)],last=points.at(-1)!;
  return <div className="progress-chart">
    <svg viewBox="0 0 340 164" width="100%" role="img"
      aria-label={labels[metric]+"の推移。"+points.length+"期間中、記録のある期間"+
        points.filter(p=>p.value!==null).length+"。欠測を0に置き換えません。"}>
      <title>{labels[metric]}の推移（記録のない日は空白）</title>
      {[min,(min+ceiling)/2,ceiling].map((v,i)=><g key={i}>
        <line x1={left} x2={right} y1={y(v)} y2={y(v)}
          stroke="#d9e5e0" strokeDasharray="3 5"/>
        <text x={left-8} y={y(v)+3.5} textAnchor="end" fill="#667b7a" fontSize="10">
          {metric==="weight"?v.toFixed(1):Math.round(v).toLocaleString("ja-JP")}
        </text>
      </g>)}
      {metric==="steps"&&points.map((p,i)=>p.value===null?null:
        <rect key={p.key} x={x(i)-barWidth/2}
          y={p.value===0?129:y(p.value)}
          width={barWidth} height={Math.max(3,132-(p.value===0?129:y(p.value)))}
          rx={Math.min(3,barWidth/3)} fill={accent}>
          <title>{p.label+" "+fmt(p.value,metric)+"（記録 "+p.count+"日）"}</title>
        </rect>)}
      {metric==="weight"&&<>
        {paths.map((d,i)=><path key={i} d={d} fill="none" stroke={accent}
          strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round"/>)}
        {points.map((p,i)=>p.value===null?null:
          <circle key={p.key} cx={x(i)} cy={y(p.value)}
            r={points.length>20?2.5:4} fill={accent}>
            <title>{p.label+" "+fmt(p.value,metric)+"（記録 "+p.count+"日）"}</title>
          </circle>)}
      </>}
      <text x={left} y="154" fontSize="10.5" fill="#64777b">{first.label}</text>
      {points.length>4&&<text x={(left+right)/2} y="154" textAnchor="middle"
        fontSize="10.5" fill="#64777b">{middle.label}</text>}
      <text x={right} y="154" textAnchor="end" fontSize="10.5" fill="#64777b">{last.label}</text>
    </svg>
  </div>;
}
function MetricPanel({metric,points,range}:{metric:Metric;points:Point[];range:string}){
  const valid=points.filter(p=>p.value!==null);
  const mean=valid.length?valid.reduce((sum,p)=>sum+p.value!*p.count,0)/
    valid.reduce((sum,p)=>sum+p.count,0):null;
  return <div className={"progress-metric progress-"+metric}>
    <div className="progress-metric-heading">
      <div>
        <span className="progress-metric-label">{labels[metric]}</span>
        <h3>{metric==="weight"?"体重の変化":"活動量の変化"}</h3>
      </div>
      <div className="progress-average">
        <span>期間平均</span>
        <strong>{mean===null?"—":fmt(mean,metric)}</strong>
      </div>
    </div>
    <Graph metric={metric} points={points}/>
    <p className="progress-footnote">{range} · 観測{valid.reduce((n,p)=>n+p.count,0)}日
      {metric==="steps"?" · 歩数はGoogle Fitを優先":" · 体重はECLEARを優先"}</p>
    <details className="progress-table">
      <summary>{labels[metric]}の期間別データを見る</summary>
      <div className="progress-table-scroll" tabIndex={0}>
        <table><thead><tr><th scope="col">期間</th><th scope="col">{labels[metric]}</th><th scope="col">記録日数</th></tr></thead>
          <tbody>{points.map(p=><tr key={p.key}>
            <th scope="row">{p.label}</th><td>{p.value===null?"欠測":fmt(p.value,metric)}</td>
            <td>{p.count}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </div>;
}
export function ProgressCharts({view,refreshEpoch=0}:{
  view:"home"|"analysis";refreshEpoch?:number
}){
  const [unit,setUnit]=useState<TrendGranularity>("day");
  const [selected,setSelected]=useState<Metric>("weight");
  const [state,setState]=useState<ChartState>({kind:"loading"});
  const range=useMemo(()=>rangeForGranularity(unit,Date.now()),[unit]);
  useEffect(()=>{
    const abort=new AbortController();
    setState({kind:"loading"});
    const q=new URLSearchParams(range).toString();
    const options:RequestInit={credentials:"same-origin",cache:"no-store",signal:abort.signal};
    Promise.all([fetch("/api/weight/trend?"+q,options),fetch("/api/steps/trend?"+q,options)])
      .then(async([w,s])=>{
        if(!abort.signal.aborted){
          if(w.status===403 && await redirectOnExpiredOwnerSession(w))throw Error("LOGIN_REQUIRED");
          if(s.status===403 && await redirectOnExpiredOwnerSession(s))throw Error("LOGIN_REQUIRED");
        }
        if(!w.ok||!s.ok)throw Error("API");
        const [weight,steps]=await Promise.all([w.json() as Promise<WeightTrend>,s.json() as Promise<StepsTrend>]);
        if(weight.from!==range.from||weight.to!==range.to||
          steps.from!==range.from||steps.to!==range.to)throw Error("RANGE");
        if(!abort.signal.aborted)setState({kind:"ok",weight,steps});
      }).catch(()=>{if(!abort.signal.aborted)setState({kind:"error"});});
    return ()=>abort.abort();
  },[range,refreshEpoch]);
  const weight=state.kind==="ok"?groupProgress(state.weight.days.map(d=>({
    day:d.day,value:d.weightKg
  })),unit):[];
  const steps=state.kind==="ok"?groupProgress(state.steps.days.map(d=>({
    day:d.day,value:d.steps
  })),unit):[];
  const showBoth=view==="analysis";
  const caption=unit==="day"?"直近30日":unit==="week"?"直近12週":"直近12か月";
  return <section className={"panel progress-section progress-view-"+view} aria-label="体重・歩数の推移">
    <div className="progress-heading">
      <div><p className="card-kicker">YOUR PROGRESS</p>
        <h2>{showBoth?"体重と歩数の変化":"最近の変化"}</h2>
        <p className="hint">記録から分かることだけを表示します。</p>
      </div>
      <div className="progress-period" role="group" aria-label="グラフの期間">
        {(["day","week","month"] as const).map(value=>
          <button key={value} type="button" aria-pressed={unit===value}
            onClick={()=>setUnit(value)}>{formats[value]}</button>)}
      </div>
    </div>
    {!showBoth&&<div className="progress-switch" role="group" aria-label="表示するグラフ">
      {(["weight","steps"] as const).map(value=>
        <button type="button" key={value} aria-pressed={selected===value}
          onClick={()=>setSelected(value)}>{labels[value]}</button>)}
    </div>}
    {state.kind==="loading"&&<p className="progress-loading" role="status">グラフを読み込んでいます…</p>}
    {state.kind==="error"&&<p className="notice-error" role="alert">
      推移データを取得できません。通信状態とログインを確認してください。
    </p>}
    {state.kind==="ok"&&<div className={showBoth?"progress-dual":"progress-single"} aria-live="polite">
      {(showBoth||selected==="weight")&&<MetricPanel metric="weight" points={weight} range={caption}/>}
      {(showBoth||selected==="steps")&&<MetricPanel metric="steps" points={steps} range={caption}/>}
    </div>}
  </section>;
}
