/** Non-causal descriptive comparisons on canonical observed JST days only. */
export type DailyObservation={
  day:string;weightKg:number|null;steps:number|null;
  estimatedFatMassKg:number|null;estimatedSkeletalMuscleKg:number|null;
  drinkingStatus:"yes"|"no"|"unknown";alcoholG:number|null;unknownCups:number;
};
const measured=(v:number|null):v is number=>typeof v==="number"&&Number.isFinite(v);
const round=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const mean=(v:number[])=>v.length?round(v.reduce((a,b)=>a+b,0)/v.length):null;
type Trend="支持傾向"|"反証傾向"|"判定保留";
export function buildDailyHypotheses(daily:readonly DailyObservation[]){
  if(daily.length>28||daily.some((x,i)=>i>0&&daily[i-1].day>=x.day))
    throw Error("INVALID_OBSERVATION_DAYS");
  const paired=(after:number)=>{
    const yes:number[]=[],no:number[]=[];
    for(let i=0;i+after<daily.length;i++){
      const a=daily[i],b=daily[i+after];
      if(a.drinkingStatus==="unknown"||!measured(a.weightKg)||!measured(b.weightKg)||
        Date.parse(b.day+"T00:00:00Z")-Date.parse(a.day+"T00:00:00Z")!==after*86400000)continue;
      const delta=round(b.weightKg-a.weightKg);
      (a.drinkingStatus==="yes"?yes:no).push(delta);
    }
    return {drinkingPairs:yes.length,nondrinkingPairs:no.length,
      drinkingMeanChangeKg:mean(yes),nondrinkingMeanChangeKg:mean(no)};
  };
  const next1=paired(1),next2=paired(2);
  // Paired observations are NOT independent; require evidence on both delays.
  const qualified=[next1,next2].every(p=>p.drinkingPairs>=4&&p.nondrinkingPairs>=4);
  const deltas=[next1,next2].map(p=>p.drinkingMeanChangeKg===null||
    p.nondrinkingMeanChangeKg===null?null:
      round(p.drinkingMeanChangeKg-p.nondrinkingMeanChangeKg));
  const h2:Trend=!qualified||deltas.some(x=>x===null)?"判定保留":
    deltas.every(x=>x!==null&&x>0.2)?"支持傾向":
    deltas.every(x=>x!==null&&x< -0.2)?"反証傾向":"判定保留";
  const nextSteps:number[]=[];
  for(let i=0;i+1<daily.length;i++){
    const source=daily[i],observed=daily[i+1];
    if(source.drinkingStatus!=="yes"||!measured(observed.steps)||
      Date.parse(observed.day+"T00:00:00Z")-Date.parse(source.day+"T00:00:00Z")!==86400000)continue;
    const weekday=new Date(observed.day+"T00:00:00Z").getUTCDay();
    const controls:number[]=[];
    for(let j=0;j+1<daily.length;j++){
      if(daily[j].drinkingStatus!=="no"||!measured(daily[j+1].steps))continue;
      if(new Date(daily[j+1].day+"T00:00:00Z").getUTCDay()===weekday)
        controls.push(daily[j+1].steps!);
    }
    if(controls.length>=2)nextSteps.push(round(observed.steps-
      controls.reduce((a,b)=>a+b,0)/controls.length));
  }
  const low=nextSteps.filter(v=>v<0).length,high=nextSteps.filter(v=>v>0).length;
  const h3:Trend=nextSteps.length<4||low+high<4?"判定保留":
    low/(low+high)>=0.75?"支持傾向":
    high/(low+high)>=0.75?"反証傾向":"判定保留";
  const bia=daily.filter(d=>measured(d.weightKg)&&measured(d.estimatedFatMassKg)&&
    measured(d.estimatedSkeletalMuscleKg));
  const first=bia[0],last=bia.at(-1);
  const span=first&&last?Math.round((Date.parse(last.day+"T00:00:00Z")-
    Date.parse(first.day+"T00:00:00Z"))/86400000):0;
  const adequate=!!first&&!!last&&bia.length>=3&&span>=14;
  // H5: four complete *descriptive* strata, never a regression or safety verdict.
  const pairedComposite:{steps:number;alcoholG:number;nextWeightChangeKg:number}[]=[];
  for(let i=0;i+1<daily.length;i++){
    const observed=daily[i],next=daily[i+1];
    if(observed.drinkingStatus==="unknown"||observed.unknownCups>0||
      !measured(observed.alcoholG)||!measured(observed.steps)||
      !measured(observed.weightKg)||!measured(next.weightKg)||
      Date.parse(next.day+"T00:00:00Z")-Date.parse(observed.day+"T00:00:00Z")!==86400000)
      continue;
    pairedComposite.push({steps:observed.steps,alcoholG:observed.alcoholG,
      nextWeightChangeKg:round(next.weightKg-observed.weightKg)});
  }
  const median=(values:number[]):number|null=>{
    if(!values.length)return null;
    const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
    return sorted.length%2?sorted[mid]:round((sorted[mid-1]+sorted[mid])/2);
  };
  const medianSteps=median(pairedComposite.map(x=>x.steps));
  const medianAlcoholG=median(pairedComposite.map(x=>x.alcoholG));
  const strata=([["low","low"],["low","high"],["high","low"],["high","high"]] as const)
    .map(([stepGroup,drinkGroup])=>{
      const matches=pairedComposite.filter(x=>medianSteps!==null&&medianAlcoholG!==null&&
        (x.steps>medianSteps?"high":"low")===stepGroup&&
        (x.alcoholG>medianAlcoholG?"high":"low")===drinkGroup);
      return {stepGroup,drinkGroup,observedPairs:matches.length,
        meanNextWeightChangeKg:mean(matches.map(x=>x.nextWeightChangeKg))};
    });
  const sufficientComposite=pairedComposite.length>=12&&
    new Set(pairedComposite.map(x=>x.steps)).size>1&&
    new Set(pairedComposite.map(x=>x.alcoholG)).size>1&&
    strata.every(x=>x.observedPairs>=3);
  return {
    h2:{verdict:h2,next1,next2,relativeDifferenceKg:deltas,
      caution:"水分・塩分・食事などは未調整。0.2kgは表示用の探索的閾値で因果・有意差ではありません。"},
    h3:{verdict:h3,sameWeekdayPairs:nextSteps.length,
      lowerStepPairs:low,higherStepPairs:high,meanDifferenceSteps:mean(nextSteps),
      caution:"同じ曜日の明示的な非飲酒翌日だけを基準にし、未登録日は対照に含めません。"},
    h4:{verdict:"判定保留" as Trend,qualified:adequate,observedDays:bia.length,
      spanDays:span,from:first?.day??null,to:last?.day??null,
      weightDeltaKg:adequate?round(last!.weightKg!-first!.weightKg!):null,
      fatDeltaKg:adequate?round(last!.estimatedFatMassKg!-first!.estimatedFatMassKg!):null,
      muscleDeltaKg:adequate?round(last!.estimatedSkeletalMuscleKg!-first!.estimatedSkeletalMuscleKg!):null,
      caution:"家庭用BIAの推定値であり、観測変化は脂肪・筋肉の実際の増減を確定しません。"},
    h5:{verdict:"判定保留" as Trend,qualified:sufficientComposite,
      observedPairs:pairedComposite.length,medianSteps,medianAlcoholG,
      strata:sufficientComposite?strata:strata.map(x=>({...x,meanNextWeightChangeKg:null})),
      reason:"日次の4群比較は記述的な観測に限ります。摂取エネルギー・睡眠・水分など未測定の交絡があり、多変量因果分析や体重予測は行いません。"}
  };
}
