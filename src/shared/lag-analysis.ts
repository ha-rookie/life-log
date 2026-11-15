/** Exploratory, non-overlapping complete JST weeks. Not a causal or predictive model. */
import { buildAnalysisMetrics,type MetricInput } from "./analysis-metrics";
import { parseDay } from "./weight-trend";
const DAY=86400000;
const day=(ms:number)=>new Date(ms).toISOString().slice(0,10);
const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
const outcome=(pairs:readonly {direction:"support"|"counter"|"flat"}[])=>{
  const support=pairs.filter(p=>p.direction==="support").length;
  const counter=pairs.filter(p=>p.direction==="counter").length;
  const flat=pairs.length-support-counter;
  const directional=support+counter;
  // An exploratory sign-count heuristic, NEVER a p-value or clinical inference.
  const verdict=pairs.length<6||directional<6?"undetermined":
    support/directional>=0.75?"supporting_observations":
    counter/directional>=0.75?"counter_observations":"undetermined";
  return {pairedWeeks:pairs.length,support,counter,flat,verdict,
    interpretation:"探索的な符号一致です。統計的有意性・因果効果・将来予測ではありません。"};
};
export function buildLagEvidence(input:MetricInput,asOf:string){
  const ms=parseDay(asOf);
  if(ms===null)throw Error("LAG_DATE");
  // A requested Sunday is never used as a completed day without verified end-of-day.
  const weekday=new Date(ms).getUTCDay();
  const daysBack=weekday===0?7:weekday;
  const lastSunday=ms-daysBack*DAY;
  const weeks=Array.from({length:12},(_,i)=>{
    const finish=lastSunday-(11-i)*7*DAY;
    const from=day(finish-6*DAY),to=day(finish);
    const metrics=buildAnalysisMetrics(input,to).windows[0];
    const measured=metrics.weight.qualifiedMeanKg;
    return {
      from,to,weightMeanKg:measured,weightObservedDays:metrics.weight.observedDays,
      stepsMean:metrics.steps.mean,stepsObservedDays:metrics.steps.observedDays,
      alcoholEnteredG:metrics.drinking.enteredG,alcoholEstimatedG:metrics.drinking.estimatedG,
      alcoholUnknownCups:metrics.drinking.unknownCups,
      drinkingObservedDays:metrics.drinking.observedDays,
      drinkingMissingDays:metrics.drinking.missingDays,
      ruleVersion:metrics.drinking.assumptionVersion
    };
  });
  const lags=([1,2,4] as const).map(lagWeeks=>{
    const stepPairs:{from:string;to:string;outcomeFrom:string;outcomeTo:string;
      changeSteps:number;weightDeltaKg:number;direction:"support"|"counter"|"flat"}[]=[];
    const drinkPairs:{from:string;to:string;outcomeFrom:string;outcomeTo:string;
      changeAlcoholG:number;weightDeltaKg:number;personalEstimateUsed:boolean;
      direction:"support"|"counter"|"flat"}[]=[];
    for(let i=1;i+lagWeeks<weeks.length;i++){
      const previous=weeks[i-1],current=weeks[i];
      const before=weeks[i+lagWeeks-1],after=weeks[i+lagWeeks];
      if(before.weightMeanKg===null||after.weightMeanKg===null)continue;
      const delta=round(after.weightMeanKg-before.weightMeanKg);
      if(current.stepsObservedDays>=4&&previous.stepsObservedDays>=4&&
        current.stepsMean!==null&&previous.stepsMean!==null){
        const change=current.stepsMean-previous.stepsMean;
        const product=change*delta;
        stepPairs.push({from:current.from,to:current.to,
          outcomeFrom:after.from,outcomeTo:after.to,changeSteps:change,
          weightDeltaKg:delta,direction:product<0?"support":product>0?"counter":"flat"});
      }
      if(current.drinkingObservedDays>=4&&previous.drinkingObservedDays>=4&&
        current.alcoholUnknownCups===0&&previous.alcoholUnknownCups===0){
        const change=round(current.alcoholEnteredG+current.alcoholEstimatedG-
          previous.alcoholEnteredG-previous.alcoholEstimatedG);
        const product=change*delta;
        drinkPairs.push({from:current.from,to:current.to,
          outcomeFrom:after.from,outcomeTo:after.to,changeAlcoholG:change,
          weightDeltaKg:delta,personalEstimateUsed:
            current.alcoholEstimatedG>0||previous.alcoholEstimatedG>0,
          direction:product>0?"support":product<0?"counter":"flat"});
      }
    }
    return {
      lagWeeks,
      stepHypothesis:{...outcome(stepPairs),pairs:stepPairs},
      alcoholHypothesis:{...outcome(drinkPairs),pairs:drinkPairs},
      warning:"飲酒・歩数と体重の時差は交絡・水分変動・測定欠測の影響を受けます。"
    };
  });
  return {
    asOf,timezone:"Asia/Tokyo" as const,window:"12_completed_nonoverlapping_weeks" as const,
    from:weeks[0].from,to:weeks.at(-1)!.to,
    weeks,lags,
    assumptions:{
      minWeightDays:4,minStepsDays:4,minDrinkingObservedDays:4,
      minPairedWeeksForDirectionalLabel:6,signAgreementFraction:0.75,
      alcoholRuleVersion:weeks[0].ruleVersion
    },
    disclaimer:"これは探索的な観測上の符号比較です。食事量・睡眠・曜日・体内水分などを統制しておらず、因果・予測・有意差を示しません。記録なしと0は別です。"
  };
}
