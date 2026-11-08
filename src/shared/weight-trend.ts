export type TrendDay = {
  day: string;
  weightKg: number | null;
  measuredAt: string | null;
  source: "実測" | "ECLEAR" | "手入力" | null;
  measuredDaysInWindow: number;
  average7Kg: number | null;
};
export type WeightTrend = {
  from: string;
  to: string;
  timezone: "Asia/Tokyo";
  goal: { lowKg: number; highKg: number; targetDate: string };
  days: TrendDay[];
  measuredDays: number;
  missingDays: number;
  excludedAnomaly: number;
  excludedNonMeasured: number;
};
export type Measurement = {
  id: string;
  measured_at: string;
  weight_kg: number | null;
  source_kind: string;
  source_id?: string;
  anomaly_flag: number;
};
const DAY_MS = 86_400_000;
const JST_MS = 9 * 3_600_000;
/** User-confirmed canonical historical weight source (2026-11-08). */
export const isEclearWeightSource=(s:string|undefined):boolean=>
  s==="eclear"||s?.startsWith("csv:eclear")===true||s?.startsWith("eclear:")===true;
const weightRank=(s:string|undefined):number=>
  isEclearWeightSource(s)?0:s?.startsWith("manual:")?1:2;
const allowedWeight=(s:string|undefined):boolean=>
  s===undefined||s==="synthetic"||weightRank(s)<2;
export const DEFAULT_GOAL = { lowKg: 75, highKg: 76, targetDate: "2026-12-22" } as const;
export function parseDay(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const time = Date.parse(day + "T00:00:00.000Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : null;
}
export function jstDay(ms: number): string {
  return new Date(ms + JST_MS).toISOString().slice(0, 10);
}
export function dateRange(from: string, to: string): { start: number; end: number; days: number } | null {
  const start = parseDay(from), end = parseDay(to);
  if (start === null || end === null || end < start) return null;
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > 366) return null;
  return { start, end, days };
}
export function defaultRange(now: number): { from: string; to: string } {
  const to = jstDay(now);
  const end = parseDay(to)!;
  return { from: new Date(end - 29 * DAY_MS).toISOString().slice(0, 10), to };
}
export function parseTrendRange(url: URL, now = Date.now()): { from: string; to: string } | null {
  const params = [...url.searchParams.keys()];
  if (params.some(k => k !== "from" && k !== "to") || new Set(params).size !== params.length) return null;
  if (params.length === 0) return defaultRange(now);
  const from = url.searchParams.get("from"), to = url.searchParams.get("to");
  return from && to && dateRange(from, to) ? { from, to } : null;
}
export function buildWeightTrend(
  rows: readonly Measurement[], from: string, to: string,
): WeightTrend {
  const range = dateRange(from, to);
  if (!range) throw new Error("INVALID_RANGE");
  const chosen = new Map<string, { ms: number; row: Measurement }>();
  let excludedAnomaly = 0, excludedNonMeasured = 0;
  for (const row of rows) {
    const ms = Date.parse(row.measured_at);
    if (!Number.isFinite(ms)) continue;
    const day = jstDay(ms);
    if (day < from || day > to) continue;
    // Legacy CSV/XLSX/TXT weight is reference-only, never an automatic fallback.
    // Explicit manual readings remain eligible where ECLEAR has no measurement.
    if (!allowedWeight(row.source_id)) continue;
    if (row.anomaly_flag !== 0 || row.weight_kg === null ||
        !Number.isFinite(row.weight_kg) || row.weight_kg <= 0 || row.weight_kg >= 500) {
      excludedAnomaly++;
      continue;
    }
    if (row.source_kind !== "measured") { excludedNonMeasured++; continue; }
    const old = chosen.get(day);
    if (!old || weightRank(row.source_id)<weightRank(old.row.source_id) ||
      (weightRank(row.source_id)===weightRank(old.row.source_id) &&
       (ms > old.ms || (ms === old.ms && row.id > old.row.id)))) {
      chosen.set(day, { ms, row });
    }
  }
  const days: TrendDay[] = [];
  let measuredDays = 0;
  for (let i = 0; i < range.days; i++) {
    const day = new Date(range.start + i * DAY_MS).toISOString().slice(0, 10);
    const found = chosen.get(day);
    if (found) measuredDays++;
    days.push({
      day, weightKg: found ? found.row.weight_kg : null,
      measuredAt: found ? found.row.measured_at : null,
      source: !found ? null : isEclearWeightSource(found.row.source_id) ? "ECLEAR" :
        found.row.source_id?.startsWith("manual:") ? "手入力" : "実測",
      measuredDaysInWindow: 0, average7Kg: null,
    });
  }
  return {
    from, to, timezone: "Asia/Tokyo", goal: { ...DEFAULT_GOAL }, days,
    measuredDays, missingDays: range.days - measuredDays, excludedAnomaly, excludedNonMeasured,
  };
}
export function addSevenDayAverage(trend: WeightTrend, prefetch: readonly Measurement[] = []): WeightTrend {
  // Preceding six days are included for the first requested day's seven-day window.
  const start = parseDay(trend.from)!;
  const preFrom = new Date(start - 6 * DAY_MS).toISOString().slice(0, 10);
  const pref = buildWeightTrend(prefetch, preFrom, trend.from).days.slice(0, -1);
  const all = [...pref, ...trend.days];
  const offset = pref.length;
  const days = trend.days.map((item, i) => {
    const window = all.slice(Math.max(0, i + offset - 6), i + offset + 1);
    const valid = window.filter(x => x.weightKg !== null);
    const n = valid.length;
    const average = n >= 4
      ? Math.round(valid.reduce((sum, x) => sum + (x.weightKg ?? 0), 0) / n * 100) / 100
      : null;
    return { ...item, measuredDaysInWindow: n, average7Kg: average };
  });
  return { ...trend, days };
}

/** Chart granularity is a view concern: the API still returns actual JST daily observations. */
export type TrendGranularity = "day" | "week" | "month";
export type TrendPeriod = {
  key: string;
  label: string;
  from: string;
  to: string;
  meanKg: number | null;
  observedDays: number;
  calendarDays: number;
};

/** A convenient window, never a persisted change to the user's measurements. */
export function rangeForGranularity(scale: TrendGranularity, now = Date.now()): { from: string; to: string } {
  const to = jstDay(now);
  if (scale === "day") return defaultRange(now);
  const current = parseDay(to)!;
  if (scale === "month") {
    const utc = new Date(current);
    const from = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth() - 11, 1))
      .toISOString().slice(0, 10);
    return { from, to };
  }
  // 12 calendar weeks, Monday as the first weekday.
  const weekday = (new Date(current).getUTCDay() + 6) % 7;
  const monday = current - (weekday + 11 * 7) * DAY_MS;
  return { from: new Date(monday).toISOString().slice(0, 10), to };
}

function mondayOf(day: string): string {
  const utc = parseDay(day)!;
  const weekday = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - weekday * DAY_MS).toISOString().slice(0, 10);
}

/** Bound user-selected windows to the configured graph density and to JST today. */
export function rangeFitsGranularity(
  scale: TrendGranularity, from: string, to: string, now = Date.now(),
): boolean {
  const range = dateRange(from, to);
  if (!range || to > jstDay(now)) return false;
  if (scale === "day") return range.days <= 30;
  if (scale === "week") {
    const start = parseDay(mondayOf(from))!;
    const end = parseDay(mondayOf(to))!;
    return (end - start) / (7 * DAY_MS) < 12;
  }
  const fm = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7));
  const tm = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  return tm - fm < 12;
}

/** Move by the displayed block, without inventing future or partial-month rows. */
export function moveGranularityRange(
  scale: TrendGranularity, current: { from: string; to: string },
  direction: -1 | 1, now = Date.now(),
): { from: string; to: string } | null {
  if (!rangeFitsGranularity(scale, current.from, current.to, now)) return null;
  const today = parseDay(jstDay(now))!;
  const start = parseDay(current.from)!;
  const end = parseDay(current.to)!;
  let nextStart: number;
  let nextEnd: number;
  if (scale === "day") {
    const days = dateRange(current.from, current.to)!.days;
    nextStart = direction === -1 ? start - days * DAY_MS : end + DAY_MS;
    nextEnd = nextStart + (days - 1) * DAY_MS;
  } else if (scale === "week") {
    const first = parseDay(mondayOf(current.from))!;
    const last = parseDay(mondayOf(current.to))!;
    const weeks = Math.round((last - first) / (7 * DAY_MS)) + 1;
    nextStart = direction === -1 ? first - weeks * 7 * DAY_MS : last + 7 * DAY_MS;
    nextEnd = nextStart + (weeks * 7 - 1) * DAY_MS;
  } else {
    const first = new Date(Date.UTC(Number(current.from.slice(0,4)), Number(current.from.slice(5,7))-1,1));
    const last = new Date(Date.UTC(Number(current.to.slice(0,4)), Number(current.to.slice(5,7))-1,1));
    const months = (last.getUTCFullYear()-first.getUTCFullYear())*12 + last.getUTCMonth()-first.getUTCMonth()+1;
    const startMonth = direction === -1
      ? new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth()-months, 1))
      : new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth()+1, 1));
    nextStart = startMonth.getTime();
    nextEnd = Date.UTC(startMonth.getUTCFullYear(),startMonth.getUTCMonth()+months,1)-DAY_MS;
  }
  if (nextStart > today) return null;
  const result = {
    from: new Date(nextStart).toISOString().slice(0,10),
    to: new Date(Math.min(nextEnd,today)).toISOString().slice(0,10),
  };
  return rangeFitsGranularity(scale,result.from,result.to,now) ? result : null;
}

/**
 * Every JST day contributes at most one valid body-weight measurement.
 * A period's mean is the arithmetic average of its *observed days*, not a
 * daily-weighted average across duplicated source rows or fabricated zeros.
 * Empty weeks/months remain explicit gaps (meanKg = null).
 */
export function groupTrendDays(days: readonly TrendDay[], scale: "week" | "month"): TrendPeriod[] {
  const grouped = new Map<string, TrendPeriod & { sum: number }>();
  for (const day of days) {
    const key = scale === "month" ? day.day.slice(0, 7) : mondayOf(day.day);
    let period = grouped.get(key);
    if (!period) {
      period = {
        key,
        label: scale === "month" ? key.replace("-", "/") : key.slice(5).replace("-", "/") + "週",
        from: day.day, to: day.day, meanKg: null, observedDays: 0, calendarDays: 0, sum: 0,
      };
      grouped.set(key, period);
    }
    period.calendarDays++;
    period.to = day.day;
    if (day.weightKg !== null) {
      period.sum += day.weightKg;
      period.observedDays++;
    }
  }
  return [...grouped.values()].map(({ sum, ...period }) => ({
    ...period,
    meanKg: period.observedDays > 0
      ? Math.round((sum / period.observedDays + Number.EPSILON) * 100) / 100
      : null,
  }));
}
