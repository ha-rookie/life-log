import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import styles from "../src/client/styles.css?raw";
import {
  EclearEnrichment,eclearErrorMessage,summarizeEclearPreviews,
  type CompositionPreview
} from "../src/client/EclearEnrichment";

const base:CompositionPreview={
  status:"preview",reviewToken:"synthetic-review-only",
  total:2,newMeasurements:1,enrichMeasurements:1,enrichCells:5,
  sameCells:2,conflictMeasurements:0,missingCells:1,unchangedMeasurements:0,
  classifications:[
    {line:2,status:"enrich",enrichFields:["bmi","boneMassKg"],conflictFields:[]},
    {line:3,status:"new",enrichFields:[],conflictFields:[]}
  ]
};
describe("ECLEAR Stage 2C: Android confirmation presentation (synthetic)",()=>{
  it("renders review entry and never claims that selection automatically saves",()=>{
    const html=renderToStaticMarkup(createElement(EclearEnrichment,{
      parts:["synthetic-part"],filename:"ECLEAR_2026.csv",
      encoding:"Shift_JIS",onSaved:()=>{},onBusyChange:()=>{}
    }));
    expect(html).toContain("体組成の不足項目を補完");
    expect(html).toContain("ECLEAR_2026.csv");
    expect(html).toContain("Shift_JIS");
    expect(html).toContain("不足項目を確認する");
    expect(html).toContain("メモは保存・送信しません");
    expect(html).not.toContain("補完が完了し");
  });
  it("aggregates all preview counters without reinterpreting missing values as zero",()=>{
    expect(summarizeEclearPreviews([base,base])).toMatchObject({
      newMeasurements:2,enrichMeasurements:2,enrichCells:10,
      sameCells:4,conflictMeasurements:0,missingCells:2
    });
    expect(summarizeEclearPreviews([]).missingCells).toBe(0);
  });
  it("explains exact 409/403 failures; unknown commit result stays unconfirmed",()=>{
    expect(eclearErrorMessage(409,"REVIEW_STALE",true)).toContain("もう一度プレビュー");
    expect(eclearErrorMessage(409,"ECLEAR_CONFLICT",true)).toContain("上書きせず");
    expect(eclearErrorMessage(403,"ECLEAR_LOCAL_DISABLED",true)).toContain("無効");
    expect(eclearErrorMessage(undefined,undefined,true)).toContain("未確定");
    expect(eclearErrorMessage(401,undefined,true)).toContain("ログイン");
  });
  it("provides 390px mobile layout rules, no horizontal overflow, 44px actions",()=>{
    expect(styles).toMatch(/\.eclear-summary-grid\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    expect(styles).toMatch(/@media\(max-width:480px\)\{[\s\S]*?\.eclear-summary-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    expect(styles).toMatch(/\.eclear-actions button\{width:100%;flex:auto;min-height:48px\}/);
    expect(styles).toContain("overflow-wrap:anywhere");
  });
});
