import {describe,it,expect} from "vitest";
import { normalizeOfficialCsv } from "../src/shared/source-adapter";
import { previewCsv } from "../src/shared/csv-import";

const eclearHeader="年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ";
const fitHeader=["日付","年","年月","曜日","平日休日","通常運動（分）","カロリー（kcal）",
"距離（m）","ハートポイント","強め運動（分）","平均心拍（bpm）","最大心拍（bpm）",
"最小心拍（bpm）","平均速度（m/s）","最高速度（m/s）","最低速度（m/s）",
"歩数","平均体重（kg）","最高体重（kg）","最低体重（kg）","自転車（分）",
"非アクティブ（分）","ウォーキング（分）","ランニング（分）","自転車（ms・原値）",
"非アクティブ（ms・原値）","ウォーキング（ms・原値）","ランニング（ms・原値）"];
const fitRow=(date:string,steps:string)=>[date,...Array(15).fill(""),steps,...Array(11).fill("")].join(",");
describe("Original Japanese official CSVs are normalized entirely on-device",()=>{
 it("recognizes ECLEAR date/time and preserves weight/fat without inventing a time",async()=>{
  const original="\uFEFF"+eclearHeader+"\r\n2025/01/31,07:42,75.3,22.5,,,,,,\r\n"+
   "2025/01/31,21:04:03,75.1,,,,,,,\r\n";
  const out=normalizeOfficialCsv("eclear",original);
  expect(out.total).toBe(2);
  expect(out.parts).toHaveLength(1);
  const result=await previewCsv("eclear",out.parts[0]);
  expect(result.errors).toEqual([]);
  expect(result.rows.map(x=>[x.timestamp,x.weight,x.fat])).toEqual([
    ["2025-01-31T07:42:00+09:00",75.3,22.5],
    ["2025-01-31T21:04:03+09:00",75.1,null]
  ]);
 });
 it("accepts 2,645 Google Fit daily records split by 40, retaining null vs 0",async()=>{
  const first=new Date("2018-11-29T00:00:00Z").valueOf();
  const values=Array.from({length:2645},(_,i)=>{
    const date=new Date(first+i*86400000).toISOString().slice(0,10);
    return fitRow(date,i===1?"":i===2?"0":"4321");
  });
  const out=normalizeOfficialCsv("fit",fitHeader.join(",")+"\n"+values.join("\n")+"\n");
  expect(out.total).toBe(2645);
  expect(out.missingSteps).toBe(1);
  expect(out.parts).toHaveLength(67);
  const firstPart=await previewCsv("fit",out.parts[0]);
  expect(firstPart.errors).toEqual([]);
  expect(firstPart.rows[1].steps).toBeNull();
  expect(firstPart.rows[2].steps).toBe(0);
  expect(firstPart.rows[3].steps).toBe(4321);
  expect((await previewCsv("fit",out.parts.at(-1)!)).rows).toHaveLength(5);
 });
 it("strictly refuses source mismatch, invented time and repeated same-day Fit rows",()=>{
  expect(()=>normalizeOfficialCsv("fit",eclearHeader+"\n2026/01/01,08:00,75,22,,,,,,\n"))
    .toThrow("CSV_HEADER_MISMATCH");
  expect(()=>normalizeOfficialCsv("eclear",eclearHeader+"\n2026/01/01,,75,22,,,,,,\n"))
    .toThrow("BAD_ECLEAR_TIME");
  expect(()=>normalizeOfficialCsv("fit",fitHeader.join(",")+"\n"+
    fitRow("2026-01-01","100")+"\n"+fitRow("2026-01-01","200")))
    .toThrow("DUPLICATE_DATE_OR_TIMESTAMP");
 });
 it("preserves CSV parser quoting and refuses malformed files",()=>{
  const ec=eclearHeader+'\n2025/04/01,08:00,75,20,,,,,,"note, in quotes"\n';
  const out=normalizeOfficialCsv("eclear",ec);
  expect(out.total).toBe(1);
  expect(()=>normalizeOfficialCsv("eclear",ec.replace('"note, in quotes"','"unclosed')))
    .toThrow("UNCLOSED_CSV_QUOTE");
 });
});
