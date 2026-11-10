import {describe,it,expect} from "vitest";
import { normalizeOfficialCsv, decodeOfficialCsv, detectOfficialCsvSource, inspectOfficialEclearComposition, partitionOfficialEclearComposition } from "../src/shared/source-adapter";
import { previewCsv } from "../src/shared/csv-import";

const eclearHeader="年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ";
const fitHeader=["日付","年","年月","曜日","平日休日","通常運動（分）","カロリー（kcal）",
"距離（m）","ハートポイント","強め運動（分）","平均心拍（bpm）","最大心拍（bpm）",
"最小心拍（bpm）","平均速度（m/s）","最高速度（m/s）","最低速度（m/s）",
"歩数","平均体重（kg）","最高体重（kg）","最低体重（kg）","自転車（分）",
"非アクティブ（分）","ウォーキング（分）","ランニング（分）","自転車（ms・原値）",
"非アクティブ（ms・原値）","ウォーキング（ms・原値）","ランニング（ms・原値）"];
const fitRow=(date:string,steps:string)=>[date,...Array(15).fill(""),steps,...Array(11).fill("")].join(",");
describe("Actual ECLEAR CSV encoding decoding regression",()=>{
 it("decodes a synthetic CP932/Shift_JIS ECLEAR 10-column fixture from raw bytes",async()=>{
  // Synthetic data only. Header bytes replicate official format; no personal measurements.
  const hex="944e8c8e93fa2c8e9e8d8f2c91cc8f642c91cc8e89966297a62c8d9c8a698bd897a62c424d492c93e091a08e899662838c8378838b2c8d9c97ca2c8aee916291e38ed397ca2c838183820d0a323032352f30312f33312c30373a34322c37352e332c32322e352c2c2c2c2c2c0d0a";
  const raw=Uint8Array.from(hex.match(/../g)!.map(s=>parseInt(s,16)));
  const decoded=decodeOfficialCsv(raw);
  expect(decoded.encoding).toBe("Shift_JIS");
  expect(detectOfficialCsvSource(decoded.text)).toBe("eclear");
  const chunks=normalizeOfficialCsv("eclear",decoded.text);
  expect(chunks.total).toBe(1);
  const p=await previewCsv("eclear",chunks.parts[0]);
  expect(p.errors).toEqual([]);
  expect(p.rows[0]).toMatchObject({timestamp:"2025-01-31T07:42:00+09:00",weight:75.3,fat:22.5});
 });
 it("keeps ordinary UTF-8 source files and optional BOM",()=>{
  const csv=fitHeader.join(",")+"\n"+fitRow("2026-01-01","0")+"\n";
  const bytes=new TextEncoder().encode("\uFEFF"+csv);
  const decoded=decodeOfficialCsv(bytes);
  expect(decoded.encoding).toBe("UTF-8");
  expect(normalizeOfficialCsv("fit",decoded.text).total).toBe(1);
 });
 it("fails closed for malformed multibyte input rather than replacing header characters",()=>{
  expect(()=>decodeOfficialCsv(Uint8Array.of(0x81))).toThrow("CSV_ENCODING_UNSUPPORTED");
  expect(()=>decodeOfficialCsv(new Uint8Array())).toThrow("CSV_SIZE");
 });
});

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

describe("Full-length lifestyle original on Android",()=>{
 it("validates 163 consecutive days in small independently auditable parts",async()=>{
  const start=Date.parse("2025-12-19T00:00:00Z");
  const days=Array.from({length:163},(_,i)=>{
    const day=new Date(start+i*86400000).toISOString().slice(0,10);
    return day+","+(i%3===0?"1,,":"0,0,");
  });
  const original="local_day,drinking_presence,drink_cups,steps\n"+days.join("\n")+"\n";
  expect(detectOfficialCsvSource(original)).toBe("lifestyle");
  const normalized=normalizeOfficialCsv("lifestyle",original);
  expect(normalized.total).toBe(163);
  expect(normalized.parts).toHaveLength(21);
  const valid=await Promise.all(normalized.parts.map(part=>previewCsv("lifestyle",part)));
  expect(valid.every(x=>x.errors.length===0&&x.rows.length>0&&x.rows.length<=8)).toBe(true);
  expect(valid.flatMap(x=>x.rows.map(y=>y.day))).toEqual(days.map(x=>x.slice(0,10)));
  expect(valid.flatMap(x=>x.rows).filter(x=>x.presence===1)).toHaveLength(55);
  expect(valid.flatMap(x=>x.rows).filter(x=>x.presence===0).every(x=>x.cups===0&&x.steps===null)).toBe(true);
 });
 it("rejects repeated days even when they would be in separate upload parts",()=>{
  const start=Date.parse("2025-12-19T00:00:00Z");
  const days=Array.from({length:10},(_,i)=>
    new Date(start+i*86400000).toISOString().slice(0,10)+",0,0,");
  days[9]=days[0];
  expect(()=>normalizeOfficialCsv("lifestyle",
    "local_day,drinking_presence,drink_cups,steps\n"+days.join("\n")+"\n"))
    .toThrow("DUPLICATE_DATE_OR_TIMESTAMP_IN_SOURCE");
 });
});

describe("Unique date-only historical weight CSV",()=>{
 it("recognizes and splits 100 date-only weights with strict day validation",async()=>{
  const base=Date.parse("2020-05-28T00:00:00Z");
  const days=Array.from({length:100},(_,n)=>
    new Date(base+n*86400000).toISOString().slice(0,10)+",73.40");
  const normalized=normalizeOfficialCsv("weight_day",
    "local_day,weight_kg\n"+days.join("\n")+"\n");
  expect(normalized.total).toBe(100);
  expect(normalized.parts).toHaveLength(3);
  const checked=await Promise.all(normalized.parts.map(chunk=>previewCsv("weight_day",chunk)));
  expect(checked.every(p=>p.errors.length===0&&p.rows.length<=40)).toBe(true);
  expect(checked.flatMap(p=>p.rows).every(r=>!r.timestamp&&r.weight===73.4)).toBe(true);
 });
 it("rejects duplicated days even when split across chunks",()=>{
  const original="local_day,weight_kg\n2020-05-28,73.4\n2020-05-28,74\n";
  expect(()=>normalizeOfficialCsv("weight_day",original))
    .toThrow("DUPLICATE_DATE_OR_TIMESTAMP_IN_SOURCE");
 });
});

describe("CSV picker automatic source recognition",()=>{
 it("recognizes supported original and normalized headers",()=>{
  expect(detectOfficialCsvSource("\uFEFF"+eclearHeader+"\n")).toBe("eclear");
  expect(detectOfficialCsvSource(fitHeader.join(",")+"\n"+fitRow("2026-01-01","100"))).toBe("fit");
  expect(detectOfficialCsvSource("measured_at,weight_kg,body_fat_pct\n")).toBe("eclear");
  expect(detectOfficialCsvSource("local_day,steps\n")).toBe("fit");
  expect(detectOfficialCsvSource("local_day,weight_kg\n")).toBe("weight_day");
  expect(detectOfficialCsvSource("local_day,drinking_presence,drink_cups,steps\n")).toBe("lifestyle");
 });
 it("does not guess unsupported CSV headers",()=>{
  expect(detectOfficialCsvSource("local_day,weight\n2026-01-01,80\n")).toBeNull();
  expect(detectOfficialCsvSource("other,steps\n2026-01-01,120\n")).toBeNull();
 });
});


describe("ECLEAR seven body-composition fields (Stage 1, browser-only, synthetic)",()=>{
  const csv=(rows:string[],header=eclearHeader)=>header+"\n"+rows.join("\n")+"\n";
  it("parses measured JST times and all seven numbers without returning personal memo",async()=>{
    const data=csv([
      '2025/02/01,07:42,75.3,20.5,36.1,23.8,7.5,2.9,1570,"quoted, memo"',
      "2025/02/01,21:30:12,75.1,,,,,,,",
    ]);
    const records=inspectOfficialEclearComposition(data);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      measuredAt:"2025-02-01T07:42:00+09:00",
      weightKg:75.3,bodyFatPct:20.5,skeletalMusclePct:36.1,
      bmi:23.8,visceralFatLevel:7.5,boneMassKg:2.9,basalMetabolismKcal:1570
    });
    expect(records[1]).toEqual({
      measuredAt:"2025-02-01T21:30:12+09:00",
      weightKg:75.1,bodyFatPct:null,skeletalMusclePct:null,
      bmi:null,visceralFatLevel:null,boneMassKg:null,basalMetabolismKcal:null
    });
    expect(JSON.stringify(records)).not.toContain("quoted");
    // Existing approved CSV API/fingerprint is still the original 3-column v1 format.
    const normalized=normalizeOfficialCsv("eclear",data);
    expect(normalized.parts[0].split("\n")[0]).toBe("measured_at,weight_kg,body_fat_pct");
    const preview=await previewCsv("eclear",normalized.parts[0]);
    expect(preview.errors).toEqual([]);
    expect(preview.rows.map(r=>[r.timestamp,r.weight,r.fat])).toEqual([
      ["2025-02-01T07:42:00+09:00",75.3,20.5],
      ["2025-02-01T21:30:12+09:00",75.1,null],
    ]);
  });

  it("preserves explicit zero separately from missing values and accepts alternate viscera kanji",()=>{
    const alternate=eclearHeader.replace("内蔵脂肪レベル","内臓脂肪レベル");
    const values=inspectOfficialEclearComposition(csv([
      "2026/01/02,06:10,80,0,0,0,0,0,0,",
      "2026/01/03,06:10,80,,,,,,,",
    ],alternate));
    expect(values[0]).toMatchObject({
      bodyFatPct:0,skeletalMusclePct:0,bmi:0,
      visceralFatLevel:0,boneMassKg:0,basalMetabolismKcal:0
    });
    expect(values[1]).toMatchObject({
      bodyFatPct:null,skeletalMusclePct:null,bmi:null,
      visceralFatLevel:null,boneMassKg:null,basalMetabolismKcal:null
    });
  });

  it("uses existing Shift_JIS decoder, rejects forged header and duplicate exact timestamp",()=>{
    const raw=new TextEncoder().encode(csv([
      "2025/01/31,07:42,75.3,22.5,30,23,6,3,1600,"
    ]));
    expect(inspectOfficialEclearComposition(new TextDecoder("utf-8").decode(raw))).toHaveLength(1);
    expect(()=>inspectOfficialEclearComposition(csv([
      "2025/01/31,07:42,75,20,30,23,6,3,1600,"
    ],eclearHeader.replace("骨格筋率","筋肉量")))).toThrow("CSV_HEADER_MISMATCH");
    expect(()=>inspectOfficialEclearComposition(csv([
      "2025/01/31,07:42,75,20,30,23,6,3,1600,",
      "2025/01/31,07:42:00,74,20,30,23,6,3,1600,"
    ]))).toThrow("DUPLICATE_DATE_OR_TIMESTAMP_IN_SOURCE");
  });

  it.each([
    ["invalid day","2026/02/30,08:01,75,20,30,23,6,3,1600,"],
    ["invalid time","2026/03/01,25:01,75,20,30,23,6,3,1600,"],
    ["zero weight","2026/03/01,08:01,0,20,30,23,6,3,1600,"],
    ["negative BMI","2026/03/01,08:01,75,20,30,-23,6,3,1600,"],
    ["over 100% muscle","2026/03/01,08:01,75,20,101,23,6,3,1600,"],
    ["invalid fat","2026/03/01,08:01,75,101,30,23,6,3,1600,"],
    ["scientific notation","2026/03/01,08:01,75,20,30,23,6,3,1e3,"],
    ["wrong columns","2026/03/01,08:01,75,20,30,23,6,3,1600"],
    ["unclosed quote",'2026/03/01,08:01,75,20,30,23,6,3,1600,"unclosed'],
  ])("rejects %s without silently coercing measurements",(_label,row)=>{
    expect(()=>inspectOfficialEclearComposition(csv([row]))).toThrow();
  });

  it("retains source CSV size and NUL rejection, without saving or calling DB",()=>{
    expect(()=>inspectOfficialEclearComposition(eclearHeader+"\n"+"x".repeat(2_000_001))).toThrow();
    expect(()=>inspectOfficialEclearComposition(csv([
      "2026/03/01,08:01,75,20,30,23,6,3,1600,\0"
    ]))).toThrow("FILE_SIZE_OR_ENCODING");
  });
});


describe("ECLEAR Stage 2C client-only 40-row partition (synthetic)",()=>{
  it("does not send any memo, preserves seven numbers and explicit zero vs NULL",()=>{
    const csv=eclearHeader+"\n"+
      '2026/01/02,07:40,75,0,0,23.5,7,2.9,1570,"private, very sensitive memo"\n'+
      "2026/01/02,21:40,74.9,,,,,,,\n";
    const out=partitionOfficialEclearComposition(csv);
    expect(out).toMatchObject({total:2,missingCells:6});
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]).not.toContain("private");
    expect(out.parts[0]).not.toContain("sensitive");
    const decoded=inspectOfficialEclearComposition(out.parts[0]);
    expect(decoded[0]).toMatchObject({bodyFatPct:0,skeletalMusclePct:0,
      bmi:23.5,visceralFatLevel:7,boneMassKg:2.9,basalMetabolismKcal:1570});
    expect(decoded[1]).toMatchObject({measuredAt:"2026-01-02T21:40:00+09:00",
      bodyFatPct:null,skeletalMusclePct:null});
  });
  it("partitions parsed records, not text lines, so quoted multi-line memo never leaks",()=>{
    const rows=Array.from({length:81},(_,i)=>{
      const date=new Date(Date.parse("2026-01-01T00:00:00Z")+i*86400000).toISOString().slice(0,10).replaceAll("-","/");
      return date+',07:40,75,25,36,23.5,7,3,1700,"private memo, first line'+
        (i===0?"\nsecond line":"")+'"';
    });
    const result=partitionOfficialEclearComposition(eclearHeader+"\n"+rows.join("\n")+"\n");
    expect(result.total).toBe(81);
    expect(result.parts).toHaveLength(3);
    expect(result.parts.map(x=>inspectOfficialEclearComposition(x).length)).toEqual([40,40,1]);
    expect(result.parts.join("")).not.toContain("private memo");
    expect(result.parts.join("")).not.toContain("second line");
  });
  it("rejects duplicate timestamp and invalid ECLEAR before producing any network payload",()=>{
    const repeated=eclearHeader+"\n2026/01/02,07:40,75,25,36,23.5,7,3,1700,\n"+
      "2026/01/02,07:40:00,75,25,36,23.5,7,3,1700,\n";
    expect(()=>partitionOfficialEclearComposition(repeated)).toThrow("DUPLICATE_DATE_OR_TIMESTAMP_IN_SOURCE");
    expect(()=>partitionOfficialEclearComposition(
      eclearHeader+"\n2026/01/02,07:40,75,25,36,-1,7,3,1700,\n")).toThrow();
  });
});
