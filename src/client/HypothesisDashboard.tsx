import { useCallback, useEffect, useState } from "react";
import { redirectOnExpiredOwnerSession } from "./auth-recovery";
import { buildDailyHypotheses, type DailyObservation } from "../shared/hypothesis-daily";
import { coverageLabel, describeLagEvidence, displayObserved, type LagSummary } from "../shared/hypothesis-dashboard";

type MetricWindow={
  days:number;from:string;to:string;
  weight:{qualifiedMeanKg:number|null;meanKg:number|null;observedDays:number;missingDays:number};
  steps:{mean:number|null;observedDays:number;missingDays:number;explicitZeroDays:number;sources:string[]};
  drinking:{observedDays:number;missingDays:number;recordedAlcoholCups:number;
    enteredG:number;estimatedG:number;unknownCups:number;assumptionVersion:string};
  composition:{latest:{estimatedFatMassKg:number|null;estimatedSkeletalMuscleKg:number|null;
    measuredAt:string;source:string}|null;deviceDerived:boolean};
};
type MetricResponse={
  asOf:string;ruleVersion:string;windows:MetricWindow[];daily?:DailyObservation[];disclaimer:string;
};
type LagResponse=LagSummary&{asOf:string;disclaimer:string;from:string;to:string};
type Snapshot={metrics:MetricResponse;lag:LagResponse};
const ranges=[7,14,28] as const;
function WeekTrend({weeks,field,title,unit}:{weeks:LagSummary["weeks"];
  field:"weightMeanKg"|"stepsMean";title:string;unit:string}){
  const points=weeks.map((week,index)=>({index,day:week.to,value:week[field]}));
  const observed=points.filter((x):x is typeof x&{value:number}=>
    typeof x.value==="number"&&Number.isFinite(x.value));
  if(!observed.length)return <p className="hint">観測なし（欠測を0として描画しません）</p>;
  const min=Math.min(...observed.map(x=>x.value)),max=Math.max(...observed.map(x=>x.value));
  const y=(v:number)=>max===min?46:86-(v-min)/(max-min)*65;
  const x=(index:number)=>12+index*28;
  return <div className="hypothesis-chart">
    <p className="hint">{title}：実際の観測範囲 {displayObserved(min,unit)} ～ {displayObserved(max,unit)} ／ {observed.length}週／{weeks.length}週</p>
    <svg viewBox="0 0 340 102" role="img" aria-label={title+"、過去12週間。線の途切れは未観測です"}>
      <line x1="8" y1="90" x2="332" y2="90" className="hypothesis-axis"/>
      {points.slice(1).map((p,i)=>{
        const prev=points[i];
        return typeof prev.value==="number"&&typeof p.value==="number"
          ?<line key={i} x1={x(prev.index)} y1={y(prev.value)} x2={x(p.index)} y2={y(p.value)}
            className="hypothesis-trend-line"/>:null;
      })}
      {observed.map(p=><circle key={p.day} cx={x(p.index)} cy={y(p.value)} r="3.3" className="hypothesis-trend-point"/>)}
    </svg>
  </div>;
}
export function HypothesisDashboard(){
  const [selected,setSelected]=useState<(typeof ranges)[number]>(7);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState("");
  const load=useCallback(async(signal?:AbortSignal)=>{
    setBusy(true);setError("");
    try{
      const get=async(path:string)=>{
        const r=await fetch(path,{credentials:"same-origin",cache:"no-store",signal});
        if(!signal?.aborted && r.status===403 && await redirectOnExpiredOwnerSession(r))throw Error("LOGIN_REQUIRED");
        if(!r.ok)throw Error("データ取得に失敗しました（HTTP "+r.status+"）");
        return await r.json() as unknown;
      };
      const [rawMetrics,rawLag]=await Promise.all([
        get("/api/mvp/metrics"),get("/api/mvp/lag")]);
      const metrics=rawMetrics as MetricResponse,lag=rawLag as LagResponse;
      if(!metrics||!Array.isArray(metrics.windows)||!lag||
        !Array.isArray(lag.weeks)||!Array.isArray(lag.lags)||metrics.asOf!==lag.asOf)
        throw Error("分析データの形式が一致しません");
      if(!signal?.aborted)setSnapshot({metrics,lag});
    }catch(e){
      if(!signal?.aborted){
        setSnapshot(null);setError(e instanceof Error?e.message:"分析データを取得できません");
      }
    }finally{if(!signal?.aborted)setBusy(false);}
  },[]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);
    return ()=>controller.abort();},[load]);
  const current=snapshot?.metrics.windows.find(w=>w.days===selected);
  const lagCards=snapshot?describeLagEvidence(snapshot.lag):[];
  const dailyEvidence=snapshot?buildDailyHypotheses(snapshot.metrics.daily??[]):null;
  return <section className="panel hypothesis-dashboard" aria-labelledby="hypothesis-title">
    <h2 id="hypothesis-title">生活習慣の仮説検証</h2>
    <p className="hint">記録された事実、支持・反証となる観測、まだ分からないことを区別します。原因や将来の体重は予測しません。</p>
    <div className="hypothesis-controls">
      <div role="group" aria-label="集計期間">
        {ranges.map(n=><button key={n} type="button" aria-pressed={selected===n}
          className={selected===n?"is-selected":""} onClick={()=>setSelected(n)}>{n}日</button>)}
      </div>
      <button type="button" onClick={()=>void load()} disabled={busy}>再取得</button>
    </div>
    {busy&&<p role="status">観測データを読み取り中…</p>}
    {error&&<p role="alert">{error}</p>}
    {snapshot&&current&&<>
      <p className="hint">集計基準日：{snapshot.metrics.asOf}（日本時間）／ {current.from}〜{current.to}。記録を訂正した場合は再取得してください。</p>
      <div className="hypothesis-kpis">
        <div><span>平均体重</span><strong>{displayObserved(selected===7?current.weight.qualifiedMeanKg:current.weight.meanKg," kg")}</strong>
          <small>{coverageLabel(current.weight.observedDays,selected)}{selected===7?" · 4日未満は未取得扱い":""}</small></div>
        <div><span>観測日の平均歩数</span><strong>{displayObserved(current.steps.mean," 歩",0)}</strong>
          <small>{coverageLabel(current.steps.observedDays,selected)} · 実測0歩 {current.steps.explicitZeroDays}日</small></div>
        <div><span>記録した飲酒</span><strong>{current.drinking.recordedAlcoholCups}杯</strong>
          <small>{coverageLabel(current.drinking.observedDays,selected)} · 未登録は禁酒扱いしません</small></div>
        <div><span>参考純アルコール</span><strong>入力値 {displayObserved(current.drinking.enteredG," g")}／簡易推定 {displayObserved(current.drinking.estimatedG," g")}</strong>
          <small>推定不能 {current.drinking.unknownCups}杯 · {current.drinking.assumptionVersion}</small></div>
      </div>
      <h3>過去12週間の観測推移</h3>
      <p className="hint">終了した日本時間の週のみ。ECLEAR体重・Google Fit歩数を優先し、空欄を0にしません。目盛りは各指標の観測範囲です。</p>
      <div className="hypothesis-trends">
        <WeekTrend weeks={snapshot.lag.weeks} field="weightMeanKg" title="週平均体重" unit=" kg"/>
        <WeekTrend weeks={snapshot.lag.weeks} field="stepsMean" title="週平均歩数" unit=" 歩"/>
      </div>
      <details>
        <summary>12週分の根拠と欠測を見る</summary>
        <div className="hypothesis-table-wrap"><table><thead><tr><th>週末日</th><th>平均体重（観測日）</th><th>平均歩数（観測日）</th></tr></thead>
          <tbody>{snapshot.lag.weeks.map(w=><tr key={w.to}><td>{w.to}</td>
            <td>{displayObserved(w.weightMeanKg," kg")}（{w.weightObservedDays}/7）</td>
            <td>{displayObserved(w.stepsMean," 歩",0)}（{w.stepsObservedDays}/7）</td></tr>)}</tbody>
        </table></div>
      </details>
      <h3>仮説別の判定</h3>
      <div className="hypothesis-cards">
        <article><h4>H1 前週の歩数と、後の体重変化</h4>
          <p className="hint">直前の週との差と、その後の週平均体重差を比較。最低6組の符号比較がない場合は判定保留です。</p>
          {lagCards.map(x=><div key={x.lagWeeks} className="hypothesis-lag-row">
            <strong>{x.lagWeeks}週後：{x.label}</strong>
            <span>比較 {x.pairedWeeks}組／支持 {x.support}・反証 {x.counter}・変化なし {x.flat}</span>
          </div>)}
          <p className="hint">支持傾向・反証傾向は探索的な符号の一致であり、統計的有意性や因果関係を示しません。</p>
        </article>
        <article><h4>H2 飲酒日と翌日・翌々日の体重</h4>
          <p><strong>{dailyEvidence?.h2.verdict??"判定保留"}</strong> — 翌日：飲酒 {dailyEvidence?.h2.next1.drinkingPairs??0}組／明示的な非飲酒 {dailyEvidence?.h2.next1.nondrinkingPairs??0}組、
            2日後：飲酒 {dailyEvidence?.h2.next2.drinkingPairs??0}組／非飲酒 {dailyEvidence?.h2.next2.nondrinkingPairs??0}組</p>
          <p className="hint">翌日の平均体重差：飲酒日 {displayObserved(dailyEvidence?.h2.next1.drinkingMeanChangeKg," kg")}、
            非飲酒日 {displayObserved(dailyEvidence?.h2.next1.nondrinkingMeanChangeKg," kg")}。
            {dailyEvidence?.h2.caution}</p></article>
        <article><h4>H3 飲酒翌日の歩数</h4>
          <p><strong>{dailyEvidence?.h3.verdict??"判定保留"}</strong> — 同曜日の観測比較 {dailyEvidence?.h3.sameWeekdayPairs??0}組、
            平均差 {displayObserved(dailyEvidence?.h3.meanDifferenceSteps," 歩",0)}</p>
          <p className="hint">{dailyEvidence?.h3.caution}</p></article>
        <article><h4>H4 推定脂肪量・骨格筋量</h4>
          <p><strong>{dailyEvidence?.h4.verdict??"判定保留"}</strong> — 体組成を同日に測定した
            {dailyEvidence?.h4.observedDays??0}日、比較期間 {dailyEvidence?.h4.spanDays??0}日</p>
          <p>比較可能な場合の機器推定差：脂肪量 {displayObserved(dailyEvidence?.h4.fatDeltaKg," kg")}、
            骨格筋量 {displayObserved(dailyEvidence?.h4.muscleDeltaKg," kg")}、
            体重 {displayObserved(dailyEvidence?.h4.weightDeltaKg," kg")}</p>
          <p className="hint">直近の機器推定：脂肪量 {displayObserved(current.composition.latest?.estimatedFatMassKg," kg")}、
            骨格筋量 {displayObserved(current.composition.latest?.estimatedSkeletalMuscleKg," kg")}。
            {dailyEvidence?.h4.caution}</p></article>
        <article><h4>H5 歩数・飲酒の複合関係</h4>
          <p><strong>判定保留</strong> — 比較可能な日 {dailyEvidence?.h5.observedPairs??0}組。
            4群それぞれ3組以上、合計12組以上の観測がない場合は差を表示しません。</p>
          {dailyEvidence?.h5.qualified&&<div className="hypothesis-table-wrap">
            <p className="hint">本人の観測中央値：歩数 {displayObserved(dailyEvidence.h5.medianSteps," 歩",0)}、
              純アルコール {displayObserved(dailyEvidence.h5.medianAlcoholG," g")}。
              高・低はこの28日間の中央値を基準にしています。</p>
            <table><thead><tr><th>歩数</th><th>飲酒量</th><th>観測組数</th><th>翌日体重差の平均</th></tr></thead>
              <tbody>{dailyEvidence.h5.strata.map(x=><tr key={x.stepGroup+x.drinkGroup}>
                <td>{x.stepGroup==="high"?"高":"低"}</td>
                <td>{x.drinkGroup==="high"?"多":"少"}</td>
                <td>{x.observedPairs}</td><td>{displayObserved(x.meanNextWeightChangeKg," kg")}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          <p className="hint">{dailyEvidence?.h5.reason??"食事・睡眠等の交絡情報が不足しています"}</p>
          <p><a href="#experiment-title">気になる仮説を行動実験で検討する</a></p>
        </article>
      </div>
      <p className="hint">{snapshot.lag.disclaimer} {snapshot.metrics.disclaimer}</p>
    </>}
  </section>;
}
