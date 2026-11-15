import {describe,it,expect} from "vitest";
import {buildDailyHypotheses,type DailyObservation} from "../src/shared/hypothesis-daily";
const day=(i:number)=>new Date(Date.parse("2026-10-01T00:00:00Z")+i*86400000).toISOString().slice(0,10);
const rows=(count=28):DailyObservation[]=>Array.from({length:count},(_,i)=>({
  day:day(i),weightKg:75,steps:i%5===0?0:7000+i*10,
  estimatedFatMassKg:null,estimatedSkeletalMuscleKg:null,
  drinkingStatus:"unknown",alcoholG:null,unknownCups:0
}));
describe("#255 observed-only daily hypothesis evidence",()=>{
  it("does not equate unknown drinking, missing weights or 0 steps with abstinence",()=>{
    const values=rows();
    values[0].drinkingStatus="yes";values[0].weightKg=76;
    values[1].weightKg=null;
    const v=buildDailyHypotheses(values);
    expect(v.h2.next1.drinkingPairs).toBe(0);
    expect(v.h2.next1.nondrinkingPairs).toBe(0);
    expect(v.h2.verdict).toBe("判定保留");
    expect(v.h3.verdict).toBe("判定保留");
    expect(values[0].steps).toBe(0);
    expect(v.h5.reason).toContain("交絡");
  });
  it("counts only explicitly recorded drinking and non-drinking with observed weight",()=>{
    const values=rows();
    for(let i=0;i<18;i++)values[i].drinkingStatus=i%2===0?"yes":"no";
    const v=buildDailyHypotheses(values);
    expect(v.h2.next1.drinkingPairs).toBe(9);
    expect(v.h2.next1.nondrinkingPairs).toBe(9);
    expect(v.h2.next1.drinkingMeanChangeKg).toBe(0);
    expect(v.h2.verdict).toBe("判定保留");
    expect(v.h2.relativeDifferenceKg).toEqual([0,0]);
  });
  it("reports same weekday evidence only if controls exist, without causality",()=>{
    const values=rows();
    values.forEach((row,i)=>{row.drinkingStatus=i%7===0?"yes":"no";});
    const v=buildDailyHypotheses(values);
    expect(v.h3.sameWeekdayPairs).toBeGreaterThan(0);
    expect(v.h3.sameWeekdayPairs).toBeLessThanOrEqual(4);
    expect(v.h3.caution).toContain("明示的な非飲酒");
  });
  it("shows device-derived deltas only with three same-day BIA observations spanning 14+ days",()=>{
    const values=rows();
    for(const i of [0,14,27]){
      values[i].estimatedFatMassKg=20-i*0.1;
      values[i].estimatedSkeletalMuscleKg=26+i*0.02;
      values[i].weightKg=75-i*0.15;
    }
    const v=buildDailyHypotheses(values);
    expect(v.h4).toMatchObject({qualified:true,observedDays:3,spanDays:27,
      verdict:"判定保留"});
    expect(v.h4.fatDeltaKg).toBeCloseTo(-2.7);
    expect(v.h4.weightDeltaKg).toBeCloseTo(-4.05);
    values[14].estimatedFatMassKg=null;
    expect(buildDailyHypotheses(values).h4.fatDeltaKg).toBeNull();
  });
  it("rejects unsorted and oversized input rather than analyzing ambiguous dates",()=>{
    const values=rows();
    values.reverse();
    expect(()=>buildDailyHypotheses(values)).toThrow("INVALID_OBSERVATION_DAYS");
    expect(()=>buildDailyHypotheses(rows(29))).toThrow("INVALID_OBSERVATION_DAYS");
  });
});
