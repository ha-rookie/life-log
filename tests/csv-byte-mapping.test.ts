import { describe, expect, it } from "vitest";
import { decodeCsvBase64, encodeCsvBytes, hash, hashCsvBytes, previewCsv, previewCsvFileBytes } from "../src/shared/csv-import";

const bytes = (text: string) => new TextEncoder().encode(text);
const BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const withBom = (text: string) => Uint8Array.from([...BOM, ...bytes(text)]);
const lifestyle = "日付,飲酒,歩数\r\n2026/1/2,1,8000\r\n2026/01/03,0,0\r\n";
const eclear = "時刻,骨格筋率,年月日,体重,体脂肪率\n07:30,35.5,2026/01/02,72.4,18.2\n19:12,,2026/01/02,72.1,\n";

describe("Issue #20 Stage 1 — raw-byte Japanese CSV mapping", () => {
  it("preserves exact UTF-8 original bytes, UTF-8 BOM and SHA-256 identity", async () => {
    const raw = bytes(lifestyle), bom = withBom(lifestyle);
    expect(decodeCsvBase64(encodeCsvBytes(raw))).toEqual(raw);
    expect(decodeCsvBase64(encodeCsvBytes(bom))).toEqual(bom);
    expect(await hashCsvBytes(raw)).toBe(await hash(lifestyle));
    expect(await hashCsvBytes(bom)).not.toBe(await hashCsvBytes(raw));
    const a = await previewCsvFileBytes("lifestyle", raw);
    const b = await previewCsvFileBytes("lifestyle", bom);
    expect(a.hash).not.toBe(b.hash);
    expect(a.rows.map(r => ({ day: r.day, presence: r.presence, cups: r.cups, steps: r.steps })))
      .toEqual(b.rows.map(r => ({ day: r.day, presence: r.presence, cups: r.cups, steps: r.steps })));
    expect(a.rows[0]?.key).not.toBe(b.rows[0]?.key);
    const lf = lifestyle.replace(/\r\n/g, "\n");
    expect((await previewCsvFileBytes("lifestyle", bytes(lf))).hash).not.toBe(a.hash);
  });

  it("rejects invalid UTF-8, truncated multi-byte, replacement bytes, UTF-16 and Shift_JIS", async () => {
    for (const input of [
      Uint8Array.from([0xc0, 0xaf]),
      Uint8Array.from([0xe3, 0x81]),
      Uint8Array.from([0xff, 0xfe, 0x44, 0x00]),
      Uint8Array.from([0xfe, 0xff, 0x00, 0x44]),
      Uint8Array.from([0x93, 0xfa, 0x95, 0x74]), // illustrative Shift_JIS bytes
      bytes("\uFEFF" + lifestyle).subarray(1), // truncated initial BOM -> malformed UTF-8
    ]) {
      await expect(previewCsvFileBytes("lifestyle", input)).rejects.toThrow("ENCODING");
    }
    await expect(previewCsvFileBytes("lifestyle", bytes("日付,飲酒\n2026/01/02,1\0")))
      .rejects.toThrow("ENCODING");
    await expect(previewCsvFileBytes("lifestyle", bytes("日付,飲酒\n2026/01/02,\uFEFF1")))
      .rejects.toThrow("ENCODING");
  });

  it("rejects malformed, oversized and noncanonical base64 before decoding to CSV", () => {
    for (const invalid of ["!!!", "YQ", "YQ=", "YQ===", "YR==", "YWJj\n", "A".repeat(90000)]) {
      expect(() => decodeCsvBase64(invalid)).toThrow();
    }
    expect(() => encodeCsvBytes(new Uint8Array(65537))).toThrow("SIZE");
    expect(() => decodeCsvBase64(encodeCsvBytes(new Uint8Array(65536)))).not.toThrow();
    expect(() => decodeCsvBase64(encodeCsvBytes(new Uint8Array(65536)) + "AAAA")).toThrow();
  });

  it("maps Japanese lifestyle columns in any order, preserving unknown cups versus explicit zero", async () => {
    const p = await previewCsvFileBytes("lifestyle", bytes("歩数,飲酒,日付\n8000,1,2026/1/2\n0,0,2026-01-03\n, ,2026-01-04"));
    expect(p.errors).toEqual([]);
    expect(p.total).toBe(3);
    expect(p.rows.map(r => [r.day, r.presence, r.cups, r.steps])).toEqual([
      ["2026-01-02", 1, null, 8000],
      ["2026-01-03", 0, 0, 0],
      ["2026-01-04", null, null, null],
    ]);
  });

  it("maps Japanese ECLEAR date+clock, body fat and skeletal muscle to one target record", async () => {
    const p = await previewCsvFileBytes("eclear", bytes(eclear));
    expect(p.errors).toEqual([]);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({
      line: 2, timestamp: "2026-01-02T07:30:00+09:00",
      weight: 72.4, fat: 18.2, muscle: 35.5,
    });
    expect(p.rows[1]).toMatchObject({
      timestamp: "2026-01-02T19:12:00+09:00", weight: 72.1, fat: null, muscle: null,
    });
    expect(p.rows[0]?.fingerprint).not.toBe(p.rows[1]?.fingerprint);
  });

  it("keeps original canonical English CSV and v1 fingerprint compatibility", async () => {
    const canonical = "measured_at,weight_kg,body_fat_pct\n2026-01-02T07:30:00+09:00,72.4,18.2\n";
    const old = await previewCsv("eclear", canonical);
    const now = await previewCsvFileBytes("eclear", bytes(canonical));
    expect(now).toEqual(old);
    const bom = await previewCsvFileBytes("eclear", withBom(canonical));
    expect(bom.rows[0]?.fingerprint).toBe(old.rows[0]?.fingerprint);
    expect(bom.hash).not.toBe(old.hash);
    await expect(previewCsv("eclear", "\uFEFF" + canonical)).rejects.toThrow("ENCODING");
    const japanese = await previewCsvFileBytes("eclear", bytes("年月日,時刻,体重,体脂肪率\n2026-01-02,07:30,72.4,18.2"));
    expect(japanese.rows[0]?.fingerprint).toBe(old.rows[0]?.fingerprint);
  });

  it("rejects mismatched source, ambiguous/mixed headers, duplicates, unknown and missing headers", async () => {
    for (const csv of [
      "日付,飲酒,飲酒\n2026-01-02,1,1",
      "日付,飲酒,秘密列\n2026-01-02,1,raw",
      "日付,体重\n2026-01-02,72",
      "日付,飲酒,年月日\n2026-01-02,1,2026-01-02",
      "日付,,飲酒\n2026-01-02,1,1",
      "日付,飲酒,日付\n2026-01-02,1,2026-01-02",
    ]) await expect(previewCsvFileBytes("lifestyle", bytes(csv))).rejects.toThrow("HEADER");
    await expect(previewCsvFileBytes("eclear", bytes(lifestyle))).rejects.toThrow("HEADER");
    await expect(previewCsvFileBytes("lifestyle", bytes(eclear))).rejects.toThrow("HEADER");
  });

  it("blocks nonempty lifestyle weight/measurement time instead of silently dropping a second target", async () => {
    const withoutTime = await previewCsvFileBytes("lifestyle", bytes("日付,飲酒,歩数,体重_kg\n2026/01/02,1,10,72.4"));
    expect(withoutTime.errors).toEqual([{ line: 2, code: "MEASUREMENT_TIME_REQUIRED" }]);
    const withTime = await previewCsvFileBytes("lifestyle", bytes("日付,飲酒,体重_kg,測定時刻\n2026/01/02,0,72.4,07:30"));
    expect(withTime.errors).toEqual([{ line: 2, code: "MULTI_TARGET_NOT_ENABLED" }]);
    const emptyWeight = await previewCsvFileBytes("lifestyle", bytes("日付,飲酒,体重_kg,測定時刻\n2026/01/02,0,,"));
    expect(emptyWeight.errors).toEqual([]);
    expect(emptyWeight.rows[0]?.presence).toBe(0);
  });

  it("reports invalid dates, clock, values and blank rows without coercion to zero", async () => {
    const p = await previewCsvFileBytes("lifestyle", bytes(
      "日付,飲酒,歩数\n2026/02/30,1,8\n2026/01/02,2,0\n2026/01/03,0,-2\n2026/01/04,0,2.5\n,,"));
    expect(p.rows).toHaveLength(0);
    expect(p.errors).toEqual([
      { line: 2, code: "VALUE" }, { line: 3, code: "VALUE" },
      { line: 4, code: "VALUE" }, { line: 5, code: "VALUE" },
      { line: 6, code: "COLUMNS" },
    ]);
    const e = await previewCsvFileBytes("eclear", bytes(
      "年月日,時刻,体重,骨格筋率\n2026-01-02,25:00,72.4,32\n2026-01-02,07:30,0,32\n2026-01-02,07:30,72.4,101"));
    expect(e.rows).toHaveLength(0);
    expect(e.errors.map(x => x.code)).toEqual(["VALUE","VALUE","VALUE"]);
  });

  it("preserves physical line numbers when quoted CSV fields contain newlines", async () => {
    const p = await previewCsvFileBytes("lifestyle", bytes(
      '日付,飲酒,歩数\r\n2026/01/02,"1\r\n",10\r\n2026/01/03,1,-9\r\n'));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]?.line).toBe(2);
    expect(p.errors).toEqual([{ line: 4, code: "VALUE" }]);
    await expect(previewCsvFileBytes("lifestyle", bytes('日付,飲酒\n2026/01/02,"1')))
      .rejects.toThrow("UNCLOSED_QUOTE");
  });

  it("enforces 100 data rows and 64 KiB maximum with no silent truncation", async () => {
    const lines = ["日付,飲酒"];
    for (let i = 0; i < 101; i++) lines.push("2026/01/02,1");
    await expect(previewCsvFileBytes("lifestyle", bytes(lines.join("\n"))))
      .rejects.toThrow("TOO_MANY_ROWS");
    await expect(previewCsvFileBytes("lifestyle", new Uint8Array(65537)))
      .rejects.toThrow("SIZE");
  });
});
