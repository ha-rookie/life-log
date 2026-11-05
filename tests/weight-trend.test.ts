import { describe, expect, it } from "vitest";
import { goalGapLabel } from "../src/client/WeightTrend";
import {
  dayNumber, dayText, startInstantJst, summarizeWeightTrend, todayTokyo, tokyoDay,
  type MeasurementRow,
} from "../src/shared/weight-trend";

const row = (id: string, measured_at: string, weight_kg: number | null,
  overrides: Partial<MeasurementRow> = {}): MeasurementRow => ({
  id, measured_at, weight_kg, source_id: "csv:eclear",
  source_kind: "measured", anomaly_flag: 0, ...overrides,
});

describe("MVP-α: deterministic daily weight trends in Asia/Tokyo", () => {
  it("validates real Gregorian days without accepting rollover and spans year boundaries", () => {
    expect(dayNumber("2024-02-29") + 1).toBe(dayNumber("2024-03-01"));
    expect(dayText(dayNumber("2026-01-01") - 1)).toBe("2025-12-31");
    for (const invalid of ["", "2026-2-01", "2026-02-30", "2025-02-29",
      "2026-13-01", "2026-00-01", "1899-12-31", "2101-01-01", "2026/01/01"]) {
      expect(() => dayNumber(invalid)).toThrow("DATE");
    }
  });

  it("handles JST midnight using explicit source offsets and deterministic Tokyo today", () => {
    expect(tokyoDay("2026-01-01T15:00:00Z")).toBe("2026-01-02");
    expect(tokyoDay("2026-01-01T14:59:59Z")).toBe("2026-01-01");
    expect(tokyoDay("2026-01-02T00:01:00+09:00")).toBe("2026-01-02");
    expect(tokyoDay("2026-01-01T10:00:00-05:00")).toBe("2026-01-02");
    expect(tokyoDay("2026-01-02")).toBeNull();
    expect(todayTokyo(Date.parse("2026-01-01T15:00:00Z"))).toBe("2026-01-02");
    expect(startInstantJst("2026-01-02")).toBe(Date.parse("2026-01-01T15:00:00Z"));
  });

  it("chooses the last eligible actual measurement on a day, ties broken stably by id", () => {
    const input = [
      row("a", "2026-01-02T07:00:00+09:00", 72.1),
      row("b", "2026-01-02T20:00:00+09:00", 72.8),
      row("z", "2026-01-02T20:00:00+09:00", 72.9),
      row("c", "2026-01-02T22:00:00+09:00", 80, { anomaly_flag: 1 }),
      row("d", "2026-01-02T23:00:00+09:00", 90, { source_kind: "estimated" }),
      row("outside", "2026-01-01T07:00:00+09:00", 70),
    ];
    const t = summarizeWeightTrend(input, "2026-01-02", "2026-01-02");
    expect(t.days).toHaveLength(1);
    expect(t.days[0]).toMatchObject({
      weightKg: 72.9, measuredAt: "2026-01-02T20:00:00+09:00",
      observations: 3, excludedAnomalies: 1, excludedNonMeasured: 1,
      source: "ECLEAR", average7Kg: null, observed7Days: 2,
    });
    expect(t.observedDays).toBe(1);
    expect(t.missingDays).toBe(0);
  });

  it("retains NULL for missing days, requiring four real observed days for mean", () => {
    const data = [
      row("1", "2026-01-01T07:00:00+09:00", 72),
      row("2", "2026-01-02T07:00:00+09:00", 73),
      row("3", "2026-01-04T07:00:00+09:00", 74),
      row("4", "2026-01-05T07:00:00+09:00", 75),
    ];
    const t = summarizeWeightTrend(data, "2026-01-01", "2026-01-07");
    expect(t.observedDays).toBe(4);
    expect(t.missingDays).toBe(3);
    expect(t.days.map(x => x.weightKg)).toEqual([72,73,null,74,75,null,null]);
    expect(t.days[3].average7Kg).toBeNull(); // three observed days
    expect(t.days[4].observed7Days).toBe(4);
    expect(t.days[4].average7Kg).toBe(73.5);
    expect(t.days[5].average7Kg).toBeNull(); // missing day is never synthetic observation
    expect(t.days[5].observed7Days).toBe(4);
  });

  it("uses six days of prefetch for first displayed moving average", () => {
    const input = [
      row("a", "2025-12-27T07:00:00+09:00", 70),
      row("b", "2025-12-29T07:00:00+09:00", 72),
      row("c", "2025-12-31T07:00:00+09:00", 74),
      row("d", "2026-01-02T07:00:00+09:00", 76),
    ];
    const t = summarizeWeightTrend(input, "2026-01-02", "2026-01-03");
    expect(t.observedDays).toBe(1);
    expect(t.days[0].observed7Days).toBe(4);
    expect(t.days[0].average7Kg).toBe(73);
    expect(t.days[1].weightKg).toBeNull();
  });

  it("excludes reported and estimated weights, abnormal flags and invalid values without leaking IDs", () => {
    const t = summarizeWeightTrend([
      row("x", "2026-01-02T07:00:00+09:00", 72.1, { source_kind: "reported" }),
      row("y", "2026-01-02T09:00:00+09:00", 73, { anomaly_flag: 1 }),
      row("z", "2026-01-02T10:00:00+09:00", null),
      row("n", "2026-01-02T11:00:00+09:00", 72.4, { source_id: "SENSITIVE_SOURCE_ID" }),
    ], "2026-01-02", "2026-01-02");
    expect(t.observedDays).toBe(1);
    expect(t.excludedAnomalies).toBe(1);
    expect(t.excludedMissingValues).toBe(1);
    expect(t.excludedNonMeasured).toBe(1);
    expect(t.days[0].weightKg).toBe(72.4);
    expect(t.days[0].source).toBe("その他");
    expect(JSON.stringify(t)).not.toContain("SENSITIVE_SOURCE_ID");
    expect(JSON.stringify(t)).not.toContain('"id"');
  });

  it("shows the latest actual body weight's numerical distance from editable goal range", () => {
    const result = summarizeWeightTrend([
      row("d1", "2026-01-02T07:00:00+09:00", 76.5),
      row("d2", "2026-01-03T07:00:00+09:00", 73.2),
    ], "2026-01-02", "2026-01-03");
    expect(goalGapLabel(result, 75, 76)).toContain("目標下限より 1.8 kg低い");
    expect(goalGapLabel(result, 73, 74)).toContain("現在の表示目標範囲内");
    expect(goalGapLabel(result, 70, 72)).toContain("目標上限より 1.2 kg高い");
    expect(goalGapLabel(summarizeWeightTrend([], "2026-01-02", "2026-01-03"), 75, 76))
      .toContain("比較できる実測なし");
  });

  it("rejects reversed or greater than 366-day range before any calculation", () => {
    expect(() => summarizeWeightTrend([], "2026-01-03", "2026-01-02")).toThrow("RANGE");
    expect(() => summarizeWeightTrend([], "2024-01-01", "2025-01-03")).toThrow("RANGE");
    expect(summarizeWeightTrend([], "2024-01-01", "2024-12-31").days).toHaveLength(366);
  });

  it("represents empty data, all flagged data and valid sub-kilogram precision without inventing points", () => {
    expect(summarizeWeightTrend([], "2026-01-01", "2026-01-02").days.map(x => x.weightKg))
      .toEqual([null, null]);
    const invalid = summarizeWeightTrend([
      row("flag", "2026-01-02T07:00:00+09:00", 72, { anomaly_flag: 1 }),
    ], "2026-01-01", "2026-01-02");
    expect(invalid.observedDays).toBe(0);
    expect(invalid.days[1].excludedAnomalies).toBe(1);
    expect(invalid.days[1].weightKg).toBeNull();
  });
});
