import { describe,it,expect } from "vitest";
import { coverageLabel, describeLagEvidence, displayObserved, type LagSummary } from "../src/shared/hypothesis-dashboard";

const hypothesis=(pairedWeeks:number,support:number,counter:number,flat:number,
  verdict:"supporting_observations"|"counter_observations"|"undetermined")=>
  ({pairedWeeks,support,counter,flat,verdict});
const data=(items:LagSummary["lags"]):LagSummary=>({weeks:[],lags:items});
describe("#251 phase-1 observational dashboard",()=>{
  it("requires six valid observed pairs even if source labels are overconfident",()=>{
    const cards=describeLagEvidence(data([{
      lagWeeks:1,stepHypothesis:hypothesis(3,3,0,0,"supporting_observations"),
      alcoholHypothesis:hypothesis(3,3,0,0,"supporting_observations")
    }]));
    expect(cards[0]).toMatchObject({label:"判定保留",pairedWeeks:3,support:3});
    expect(cards[1]).toMatchObject({label:"判定保留",pairedWeeks:0});
  });
  it("distinguishes support, counter and hold for 1/2/4-week lags",()=>{
    const cards=describeLagEvidence(data([
      {lagWeeks:1,stepHypothesis:hypothesis(8,6,2,0,"supporting_observations"),
        alcoholHypothesis:hypothesis(0,0,0,0,"undetermined")},
      {lagWeeks:2,stepHypothesis:hypothesis(8,0,8,0,"counter_observations"),
        alcoholHypothesis:hypothesis(0,0,0,0,"undetermined")},
      {lagWeeks:4,stepHypothesis:hypothesis(7,3,3,1,"undetermined"),
        alcoholHypothesis:hypothesis(0,0,0,0,"undetermined")}
    ]));
    expect(cards.map(x=>x.label)).toEqual(["支持傾向","反証傾向","判定保留"]);
    expect(cards.map(x=>x.lagWeeks)).toEqual([1,2,4]);
  });
  it("rejects malformed counts rather than manufacturing observations",()=>{
    const cards=describeLagEvidence(data([{
      lagWeeks:1,stepHypothesis:hypothesis(8,9,0,0,"supporting_observations"),
      alcoholHypothesis:hypothesis(8,8,0,0,"supporting_observations")
    }]));
    expect(cards[0]).toMatchObject({label:"判定保留",pairedWeeks:0});
  });
  it("distinguishes measured zero from missing and never imputes missing drinking",()=>{
    expect(displayObserved(0," 歩",0)).toBe("0 歩");
    expect(displayObserved(null," kg")).toBe("未取得");
    expect(displayObserved(Number.NaN," g")).toBe("未取得");
    expect(coverageLabel(2,7)).toContain("未取得 5日");
    expect(coverageLabel(-1,7)).toBe("観測状況不明");
  });
});
