/** Display-only interpretation of Owner-scoped observational lag evidence. No causal claims. */
export type Verdict = "supporting_observations"|"counter_observations"|"undetermined";
export type LagHypothesis = {
  pairedWeeks:number;support:number;counter:number;flat:number;verdict:Verdict;
};
export type LagWindow = {
  lagWeeks:number;stepHypothesis:LagHypothesis;alcoholHypothesis:LagHypothesis;
};
export type LagSummary = {
  weeks:readonly {from:string;to:string;weightMeanKg:number|null;weightObservedDays:number;
    stepsMean:number|null;stepsObservedDays:number}[];
  lags:readonly LagWindow[];
};
export type LagCard = {
  lagWeeks:number;label:"支持傾向"|"反証傾向"|"判定保留";
  pairedWeeks:number;support:number;counter:number;flat:number;
};
export function describeLagEvidence(data:LagSummary):LagCard[]{
  if(!Array.isArray(data.lags))return [];
  return ([1,2,4] as const).map(lag=>{
    const item=data.lags.find(x=>x.lagWeeks===lag)?.stepHypothesis;
    const counts=[item?.pairedWeeks,item?.support,item?.counter,item?.flat];
    const valid=counts.every(x=>Number.isInteger(x)&&x!>=0)&&
      item!.support+item!.counter+item!.flat===item!.pairedWeeks;
    const verdict=valid&&item!.pairedWeeks>=6?item!.verdict:"undetermined";
    return {
      lagWeeks:lag,
      label:verdict==="supporting_observations"?"支持傾向":
        verdict==="counter_observations"?"反証傾向":"判定保留",
      pairedWeeks:valid?item!.pairedWeeks:0,
      support:valid?item!.support:0,
      counter:valid?item!.counter:0,
      flat:valid?item!.flat:0
    };
  });
}
export const displayObserved=(value:number|null|undefined,unit:string,digits=1):string=>
  typeof value==="number"&&Number.isFinite(value)
    ?value.toLocaleString("ja-JP",{maximumFractionDigits:digits})+unit:"未取得";
export const coverageLabel=(count:number,days:number)=>
  Number.isInteger(count)&&Number.isInteger(days)&&count>=0&&count<=days&&days>0
    ?count+"日／"+days+"日（未取得 "+(days-count)+"日）":"観測状況不明";
