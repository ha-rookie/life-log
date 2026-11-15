/** Read-only, observed-only analysis primitives. No medical scores or causal inference. */
import { assessDrinkAlcohol, isDrinkKind, personalAlcoholRule, publicDrinkKind,
  type StoredDrinkKind } from "./drink-measures";
import { isEclearWeightSource, jstDay, parseDay } from "./weight-trend";

export type MetricBodyRow = {
  id:string; measured_at:string; source_id:string; source_kind:string; anomaly_flag:number;
  weight_kg:number|null; body_fat_pct:number|null; skeletal_muscle_pct:number|null;
  bmi:number|null; visceral_fat_level:number|null; bone_mass_kg:number|null;
  basal_metabolism_kcal:number|null
};
export type MetricStepRow = {local_day:string;steps:number|null;source_id:string};
export type MetricLifestyleRow = {local_day:string;drinking_presence:number|null;source_id:string};
export type MetricDrinkRow = {
  observed_at:string;drink_kind:StoredDrinkKind;drink_variant:string|null;
  source_id:string;alcohol:number;cups:number;volume_ml:number|null;abv_pct:number|null
};
export type MetricInput={
  bodies:readonly MetricBodyRow[]; steps:readonly MetricStepRow[];
  lifestyles:readonly MetricLifestyleRow[]; drinks:readonly MetricDrinkRow[]
};
const DAY=86400000;
const rounded=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
const dayBefore=(day:string,n:number)=>new Date(parseDay(day)!-n*DAY).toISOString().slice(0,10);
const fit=(s:string)=>s==="fit"||s==="google_fit"||s==="google-fit"||
  s.startsWith("fit:")||s.startsWith("google_fit:")||s.startsWith("google-fit:")||
  s.startsWith("csv:fit")||s.startsWith("csv:google_fit")||s.startsWith("csv:google-fit");
const bodyRank=(s:string)=>isEclearWeightSource(s)?0:s.startsWith("manual:")?1:9;
const stepRank=(s:string)=>fit(s)?0:s.startsWith("manual:")?1:9;
const valid=(n:number|null,min:number,max:number):n is number=>
  typeof n==="number"&&Number.isFinite(n)&&n>=min&&n<=max;
const fields=["weight_kg","body_fat_pct","skeletal_muscle_pct","bmi",
  "visceral_fat_level","bone_mass_kg","basal_metabolism_kcal"] as const;
const ranges:Record<typeof fields[number],[number,number]>={
  weight_kg:[0.01,499.99],body_fat_pct:[0,100],skeletal_muscle_pct:[0,100],
  bmi:[1,100],visceral_fat_level:[0,100],bone_mass_kg:[0,30],
  basal_metabolism_kcal:[1,10000]
};
const composition=(row:MetricBodyRow)=>{
  const cells=Object.fromEntries(fields.map(f=>[
    f,valid(row[f],...ranges[f])?row[f]:null
  ])) as Record<typeof fields[number],number|null>;
  const weight=cells.weight_kg,fat=cells.body_fat_pct,muscle=cells.skeletal_muscle_pct;
  return {
    ...cells,
    estimatedFatMassKg:weight!==null&&fat!==null?rounded(weight*fat/100):null,
    estimatedSkeletalMuscleKg:weight!==null&&muscle!==null?rounded(weight*muscle/100):null,
    estimatedFatFreeMassKg:weight!==null&&fat!==null?rounded(weight*(1-fat/100)):null,
    calculatedBmi:null,estimatedFmi:null,
    measuredAt:row.measured_at,source:row.source_id,
    sourceKind:row.source_kind,precision:"consumer_BIA_estimate" as const
  };
};
export function buildAnalysisMetrics(input:MetricInput,asOf:string){
  if(parseDay(asOf)===null)throw Error("METRICS_DATE");
  const first=dayBefore(asOf,27);
  const bodies=new Map<string,MetricBodyRow>();
  let excludedAnomalies=0,excludedUnsupported=0;
  for(const row of input.bodies){
    const time=Date.parse(row.measured_at);
    if(!Number.isFinite(time))continue;
    const day=jstDay(time);
    if(day<first||day>asOf)continue;
    if(row.anomaly_flag!==0){excludedAnomalies++;continue;}
    if(row.source_kind!=="measured"||bodyRank(row.source_id)>1){
      excludedUnsupported++;continue;
    }
    const current=bodies.get(day);
    if(!current||bodyRank(row.source_id)<bodyRank(current.source_id)||
      (bodyRank(row.source_id)===bodyRank(current.source_id)&&
       (time>Date.parse(current.measured_at)||
        (time===Date.parse(current.measured_at)&&row.id>current.id))))
      bodies.set(day,row);
  }
  const steps=new Map<string,MetricStepRow>();
  for(const row of input.steps){
    if(parseDay(row.local_day)===null||row.local_day<first||row.local_day>asOf||
      !Number.isInteger(row.steps)||row.steps===null||row.steps<0||
      stepRank(row.source_id)>1)continue;
    const current=steps.get(row.local_day);
    if(!current||stepRank(row.source_id)<stepRank(current.source_id)||
      (stepRank(row.source_id)===stepRank(current.source_id)&&row.source_id<current.source_id))
      steps.set(row.local_day,row);
  }
  const stated=new Map<string,MetricLifestyleRow>();
  for(const row of input.lifestyles){
    if(parseDay(row.local_day)===null||row.local_day<first||row.local_day>asOf||
      (row.drinking_presence!==0&&row.drinking_presence!==1))continue;
    const current=stated.get(row.local_day);
    if(!current||(row.source_id.startsWith("manual:")&&!current.source_id.startsWith("manual:")))
      stated.set(row.local_day,row);
  }
  const drinks=new Map<string,MetricDrinkRow[]>();
  for(const row of input.drinks){
    const epoch=Date.parse(row.observed_at);
    if(!Number.isFinite(epoch))continue;
    const day=jstDay(epoch);
    if(day<first||day>asOf)continue;
    const existing=drinks.get(day)??[];existing.push(row);drinks.set(day,existing);
  }
  const windows=([7,14,28] as const).map(n=>{
    const from=dayBefore(asOf,n-1);
    const selectedBody=[...bodies].filter(([day])=>day>=from)
      .sort((a,b)=>a[0].localeCompare(b[0]));
    const weightValues=selectedBody.map(([,row])=>row.weight_kg)
      .filter((x):x is number=>valid(x,...ranges.weight_kg));
    const selectedSteps=[...steps].filter(([day])=>day>=from);
    const stepValues=selectedSteps.map(([,row])=>row.steps!);
    const latest=selectedBody.at(-1);
    const fieldObservedDays=Object.fromEntries(fields.map(field=>[
      field,selectedBody.filter(([,row])=>valid(row[field],...ranges[field])).length
    ])) as Record<typeof fields[number],number>;
    const dayDrinks=[...drinks].filter(([day])=>day>=from);
    const entries=dayDrinks.flatMap(([,rows])=>rows);
    const assessed=entries.map(row=>{
      const kind=publicDrinkKind(row.drink_kind,row.drink_variant,row.source_id);
      return isDrinkKind(kind)?assessDrinkAlcohol({kind,cups:row.cups,
        volumeMl:row.volume_ml,abvPct:row.abv_pct,alcohol:row.alcohol}):null;
    });
    const enteredG=assessed.reduce((a,x)=>a+(x?.basis==="entered"?(x.grams??0):0),0);
    const estimatedG=assessed.reduce((a,x)=>a+(x?.basis==="estimated"?(x.grams??0):0),0);
    const unknownCups=assessed.reduce((a,x)=>a+(x?.unknownCups??0),0);
    const evidenceDays=new Set([
      ...[...stated.keys()].filter(d=>d>=from),
      ...dayDrinks.map(([d])=>d)
    ]);
    const explicitYes=new Set([
      ...[...stated].filter(([d,r])=>d>=from&&r.drinking_presence===1).map(([d])=>d),
      ...dayDrinks.filter(([,rows])=>rows.some(r=>r.alcohol===1)).map(([d])=>d)
    ]);
    const explicitNo=[...stated].filter(([d,r])=>d>=from&&r.drinking_presence===0&&!explicitYes.has(d)).length;
    return {
      days:n,from,to:asOf,
      weight:{
        observedDays:weightValues.length,missingDays:n-weightValues.length,
        meanKg:weightValues.length?rounded(weightValues.reduce((a,b)=>a+b,0)/weightValues.length):null,
        // A seven-day trend requires 4 distinct daily measurements in 7 calendar days.
        qualifiedMeanKg:n===7&&weightValues.length>=4
          ?rounded(weightValues.reduce((a,b)=>a+b,0)/weightValues.length):null,
        latest:latest&&valid(latest[1].weight_kg,...ranges.weight_kg)
          ?{day:latest[0],kg:latest[1].weight_kg,source:latest[1].source_id}:null
      },
      composition:{
        fieldObservedDays,
        latest:latest?composition(latest[1]):null,
        deviceDerived:true
      },
      steps:{
        observedDays:stepValues.length,missingDays:n-stepValues.length,
        explicitZeroDays:stepValues.filter(v=>v===0).length,
        mean:stepValues.length?Math.round(stepValues.reduce((a,b)=>a+b,0)/stepValues.length):null,
        sources:[...new Set(selectedSteps.map(([,r])=>r.source_id))]
      },
      drinking:{
        observedDays:evidenceDays.size,missingDays:n-evidenceDays.size,
        drinkingDays:explicitYes.size,explicitNondrinkingDays:explicitNo,
        recordedAlcoholCups:entries.filter(r=>r.alcohol===1).reduce((a,r)=>a+r.cups,0),
        recordedNonAlcoholCups:entries.filter(r=>r.alcohol===0).reduce((a,r)=>a+r.cups,0),
        enteredG:rounded(enteredG),estimatedG:rounded(estimatedG),unknownCups,
        assumptionVersion:personalAlcoholRule,
        gramsAre:"entered_or_personal_estimate_not_lab_verified" as const
      }
    };
  });
  return {
    asOf,timezone:"Asia/Tokyo" as const,ruleVersion:"metrics-2026-11-15-v1" as const,
    sourcePriority:{weight:"ECLEAR_then_manual",steps:"Google_Fit_then_manual"},
    excluded:{anomalyRows:excludedAnomalies,unsupportedBodyRows:excludedUnsupported},
    windows,
    disclaimer:"欠測は0ではありません。体組成は家庭用計測器の推定値、アルコール量は入力値または個人用の簡易推定です。原因・将来の体重を断定しません。"
  };
}
