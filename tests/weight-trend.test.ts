import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PeriodPlot, TrendPlot, WeightTrendPanel } from "../src/client/WeightTrend";
import {
  addSevenDayAverage, buildWeightTrend, dateRange, defaultRange, groupTrendDays, parseTrendRange, rangeForGranularity,
  type Measurement,
} from "../src/shared/weight-trend";
const row = (day: string, kg: number | null, id = day, extras: Partial<Measurement> = {}): Measurement => ({
  id, measured_at: day + "T08:00:00+09:00", weight_kg: kg,
  source_kind: "measured", anomaly_flag: 0, ...extras,
});
describe("Issue #25: JST daily trend and calendar seven-day average", () => {
  it("rejects invalid dates, excess ranges and ambiguous query parameters", () => {
    expect(dateRange("2026-02-30", "2026-03-02")).toBeNull();
    expect(dateRange("2026-01-03", "2026-01-02")).toBeNull();
    expect(dateRange("2025-01-01", "2026-12-31")).toBeNull();
    expect(dateRange("2026-01-01", "2026-01-01")?.days).toBe(1);
    expect(parseTrendRange(new URL("https://x.invalid/?from=2026-01-01"))).toBeNull();
    expect(parseTrendRange(new URL("https://x.invalid/?from=2026-01-01&to=2026-01-02&to=2026-01-03"))).toBeNull();
    expect(parseTrendRange(new URL("https://x.invalid/?from=2026-01-01&to=2026-01-02&owner=other"))).toBeNull();
    expect(defaultRange(Date.parse("2026-11-05T15:01:00Z")).to).toBe("2026-11-06");
  });
  it("chooses latest actual JST observation, stable ID tie-break, never fabricates missing days", () => {
    const trend = buildWeightTrend([
      row("2026-01-01", 73, "a"),
      row("2026-01-01", 74, "z"),
      row("2026-01-01", 99, "ignored", { source_kind: "reported" }),
      row("2026-01-01", 999, "bad", { anomaly_flag: 1 }),
      row("2026-01-02", 72, "night", { measured_at: "2026-01-01T16:00:00Z" }),
      row("2026-01-02", 77, "wrongday", { measured_at: "2026-01-01T14:59:59Z" }),
    ], "2026-01-01", "2026-01-03");
    expect(trend.days.map(d => d.weightKg)).toEqual([77, 72, null]);
    expect(trend.measuredDays).toBe(2);
    expect(trend.missingDays).toBe(1);
    expect(trend.excludedAnomaly).toBe(1);
    expect(trend.excludedNonMeasured).toBe(1);
    expect(trend.days[0].source).toBe("実測");
    expect(trend.days[2].measuredAt).toBeNull();
  });
  it("uses calendar days and six-day prefetch; 1-3 observations are insufficient", () => {
    const pre = [row("2026-01-01", 70),row("2026-01-02", 71),row("2026-01-03", 72)];
    const requested = [row("2026-01-04", 73),row("2026-01-06", 75)];
    const trend = addSevenDayAverage(buildWeightTrend(requested,"2026-01-04","2026-01-09"),pre);
    expect(trend.days[0].measuredDaysInWindow).toBe(4);
    expect(trend.days[0].average7Kg).toBe(71.5);
    expect(trend.days[2].measuredDaysInWindow).toBe(5);
    expect(trend.days[2].average7Kg).toBe(72.2);
    expect(trend.days[5].measuredDaysInWindow).toBe(3);
    expect(trend.days[5].average7Kg).toBeNull();
    expect(trend.days[1].weightKg).toBeNull();
    const few = addSevenDayAverage(buildWeightTrend(pre,"2026-01-01","2026-01-03"));
    expect(few.days.every(d=>d.average7Kg===null)).toBe(true);
  });
  it("renders isolated 7-day average points and keyboard-scrollable chart at 390px CSS contract", async () => {
    const observations = [
      row("2026-01-01", 70), row("2026-01-02", 71),
      row("2026-01-03", 72), row("2026-01-04", 73),
    ];
    const days = addSevenDayAverage(buildWeightTrend(observations, "2026-01-01", "2026-01-04")).days;
    expect(days.filter(d => d.average7Kg !== null)).toHaveLength(1);
    const html = renderToStaticMarkup(createElement(TrendPlot, { days, goalLow: 75, goalHigh: 76 }));
    expect(html).toContain('role="region"');
    expect(html).toContain('class="trend-viewport"');
    expect(html).toContain('class="trend-fixed-axis"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/tabindex="0"/i);
    expect(html).toContain('role="img"');
    expect((html.match(/class="average-point"/g) ?? [])).toHaveLength(1);
    expect(html).toContain("左右にスクロール");
    // Under a 390px viewport, the parent panel has approximately 312px of
    // inner width; the 680px SVG therefore scrolls instead of shrinking
    // its axis font below an accessible reading size.
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>("node:fs");
    const styles = readFileSync("src/client/styles.css", "utf8");
    expect(styles).toMatch(/\.trend-scroll,\.trend-table-scroll\{overflow-x:auto;max-width:100%\}/);
    expect(styles).toMatch(/\.trend-scroll svg\{[^}]*min-width:680px;/);
  });

  it("expands the 90-day plot so daily points and axis labels retain legible spacing", () => {
    const trend = buildWeightTrend(
      [row("2026-11-06", 78.3)], "2026-08-09", "2026-11-06",
    );
    expect(trend.days).toHaveLength(90);
    const markup = renderToStaticMarkup(createElement(TrendPlot, {
      days: trend.days, goalLow: 75, goalHigh: 76,
    }));
    expect(markup).toContain('viewBox="0 0 1496 230"');
    expect(markup).toMatch(/min-width:\s*1413px/);
    expect(markup).toContain("11/06");
  });


  it("switches to 12 calendar months within the API 366-day limit, including a year boundary", () => {
    const now = Date.parse("2026-11-05T15:01:00Z"); // Nov 6 in Japan
    const monthRange = rangeForGranularity("month", now);
    expect(monthRange).toEqual({ from: "2025-12-01", to: "2026-11-06" });
    expect(dateRange(monthRange.from,monthRange.to)?.days).toBeLessThanOrEqual(366);
    const weekly = rangeForGranularity("week",now);
    expect(weekly.to).toBe("2026-11-06");
    expect(weekly.from).toBe("2026-05-11"); // Monday, 26 calendar weeks
    expect(rangeForGranularity("day", now)).toEqual(defaultRange(now));
  });

  it("groups monthly by calendar month, averaging one daily representative and retaining missing months", () => {
    const range = {from:"2025-12-01",to:"2026-11-06"};
    const rows = [
      row("2025-12-30",70,"first"),
      row("2025-12-30",100,"second"), // same-day representative is latest stable ID
      row("2026-01-01",74),row("2026-01-03",78),
      row("2026-11-06",80),
    ];
    const periods = groupTrendDays(buildWeightTrend(rows,range.from,range.to).days,"month");
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({
      key:"2025-12",meanKg:100,observedDays:1,calendarDays:31,
    });
    expect(periods[1]).toMatchObject({
      key:"2026-01",meanKg:76,observedDays:2,calendarDays:31,
    });
    expect(periods[2]).toMatchObject({
      key:"2026-02",meanKg:null,observedDays:0,calendarDays:28,
    });
    expect(periods[11]).toMatchObject({
      key:"2026-11",meanKg:80,observedDays:1,calendarDays:6,
    });
    const html=renderToStaticMarkup(createElement(PeriodPlot,{
      periods,granularity:"month",goalLow:75,goalHigh:76,
    }));
    expect(html).toContain('viewBox="0 0 360 230"');
    expect(html).toContain('class="trend-month-fit"');
    expect(html).toContain("12か月");
    expect(html).toContain("2025/12");
    expect(html).toContain("2026/11");
    expect((html.match(/<circle/g)??[])).toHaveLength(3);
  });

  it("uses Monday-start calendar weeks and does not connect missing weeks", () => {
    const trend = buildWeightTrend([
      row("2025-12-31",72),row("2026-01-01",74),row("2026-01-10",77),
    ],"2025-12-29","2026-01-18");
    const weekly=groupTrendDays(trend.days,"week");
    expect(weekly.map(p=>p.key)).toEqual(["2025-12-29","2026-01-05","2026-01-12"]);
    expect(weekly.map(p=>p.meanKg)).toEqual([73,77,null]);
    expect(weekly.map(p=>p.observedDays)).toEqual([2,1,0]);
    const html=renderToStaticMarkup(createElement(PeriodPlot,{
      periods:weekly,granularity:"week",goalLow:75,goalHigh:76,
    }));
    expect(html).toContain("週ごとの平均体重");
    expect(html).toContain('tabindex="0"');
  });

  it("renders all three viewing controls and monthly non-scroll CSS on narrow devices", async () => {
    const html=renderToStaticMarkup(createElement(WeightTrendPanel));
    expect(html).toContain('aria-label="グラフの表示単位"');
    expect(html).toContain('aria-pressed="true"');
    for(const label of [">日</button>",">週</button>",">月</button>"]) expect(html).toContain(label);
    const { readFileSync }=await vi.importActual<{readFileSync(path:string,enc:string):string}>("node:fs");
    const css=readFileSync("src/client/styles.css","utf8");
    expect(css).toContain(".trend-month-fit>svg{display:block;width:100%;max-width:100%;min-width:0;height:auto}");
    expect(css).toContain(".trend-period-table .trend-table{width:100%;min-width:0}");
  });

  it("returns full empty days and excludes null, anomaly and non-measured", () => {
    const t=buildWeightTrend([
      row("2026-02-01",null),row("2026-02-02",70,"anomaly",{anomaly_flag:1}),
      row("2026-02-03",71,"estimated",{source_kind:"estimated"}),
    ],"2026-02-01","2026-02-04");
    expect(t.days).toHaveLength(4);
    expect(t.measuredDays).toBe(0);
    expect(t.missingDays).toBe(4);
    expect(t.excludedAnomaly).toBe(2);
    expect(t.excludedNonMeasured).toBe(1);
  });
});
