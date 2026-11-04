import { describe, expect, it } from "vitest";
import { previewCsv, csvSha256, CsvIssue } from "../src/shared/csv-import";

const lifestyle = "日付,歩数,体重_kg,飲酒\r\n2026/01/02,,72.4,1\r\n2026/01/03,0,,0\r\n2026/01/04,,,";
const eclear = '年月日,時刻,体重,体脂肪率,骨格筋率,メモ\n2026/01/02,08:05,72.1,22.0,30.5,"test, ""synthetic"""\n2026/01/02,21:05,72.5,,,\n';

describe("synthetic lifestyle/ECLEAR CSV parse and preview", () => {
  it("keeps missing different from zero and drinking presence different from count", () => {
    const view = previewCsv("\uFEFF" + lifestyle);
    expect(view.kind).toBe("lifestyle");
    expect(view.errors).toEqual([]);
    expect(view.totalRows).toBe(3);
    expect(view.rows[0]).toMatchObject({kind:"lifestyle",localDay:"2026-01-02",steps:null,weightKg:72.4,drinkingPresence:1,drinkCups:null});
    expect(view.rows[1]).toMatchObject({kind:"lifestyle",localDay:"2026-01-03",steps:0,weightKg:null,drinkingPresence:0,drinkCups:0});
    expect(view.rows[2]).toMatchObject({steps:null,weightKg:null,drinkingPresence:null,drinkCups:null});
  });
  it("parses quoted commas, CRLF, same-day distinct measuring times without collapsing them", () => {
    const view = previewCsv(eclear);
    expect(view.errors).toEqual([]);
    expect(view.rows).toHaveLength(2);
    expect(view.rows[0]).toMatchObject({kind:"eclear",measuredAt:"2026-01-02T08:05:00+09:00",weightKg:72.1,bodyFatPct:22});
    expect(view.rows[1]).toMatchObject({kind:"eclear",measuredAt:"2026-01-02T21:05:00+09:00",bodyFatPct:null});
  });
  it("rejects malformed rows without silently dropping invalid records", () => {
    const v = previewCsv("日付,歩数,飲酒\n2026-02-30,1,0\n2026-01-02,-1,1\n2026-01-03,42,8\n2026-01-02,12,1");
    expect(v.rows).toHaveLength(1);
    expect(v.errors.map(e => e.code)).toEqual(["INVALID_DATE","INVALID_NUMBER","INVALID_ROW"]);
    expect(previewCsv("日付,飲酒\n2026-01-01,0\n2026-01-01,0").errors[0].code).toBe("DUPLICATE_IN_FILE");
  });
  it("rejects unknown or inconsistent CSV formats, excessive rows and malformed quoting", () => {
    for (const csv of [
      '日付,飲酒\n"2026-01-01,0',
      "x,y\n1,2",
      "年月日,体重\n2026-01-01,72",
      "日付,飲酒,飲酒\n2026-01-01,0,0",
    ]) expect(() => previewCsv(csv)).toThrow(CsvIssue);
    const many = "日付,飲酒\n"+Array.from({length:31},(_,i)=>"2026-02-"+String(i+1).padStart(2,"0")+",0").join("\n");
    expect(() => previewCsv(many)).toThrow("TOO_MANY_ROWS");
  });
  it("hashes exact CSV text for server-side revalidation", async () => {
    expect(await csvSha256(lifestyle)).toMatch(/^[a-f0-9]{64}$/);
    expect(await csvSha256(lifestyle)).toBe(await csvSha256(lifestyle));
    expect(await csvSha256(lifestyle+" ")).not.toBe(await csvSha256(lifestyle));
  });
});
