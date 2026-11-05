// Pure, deterministic weight-trend model for MVP-α / Issue #25.
// Every day is a calendar day in Asia/Tokyo (UTC+09, no DST).
export const MAX_TREND_DAYS = 366;
export const MAX_TREND_ROWS = 2000;
export const MIN_MEASURED_DAYS_FOR_AVERAGE = 4;

export interface MeasurementRow {
  id: string;
  measured_at: string;
  weight_kg: number | null;
  source_id: string;
  source_kind: string;
  anomaly_flag: number;
}
export interface TrendDay {
  day: string;
  weightKg: number | null;
  measuredAt: string | null;
  source: "ECLEAR" | "その他";
  observations: number;
  excludedAnomalies: number;
  excludedNonMeasured: number;
  average7Kg: number | null;
  observed7Days: number;
}
export interface WeightTrend {
  from: string;
  to: string;
  timezone: "Asia/Tokyo";
  representativeMethod: "last_measured_timestamp_then_id";
  averageMethod: "7_calendar_days_min_4_observed";
  observedDays: number;
  missingDays: number;
  excludedAnomalies: number;
  excludedNonMeasured: number;
  days: TrendDay[];
}
const DAY_MS = 86_400_000;
const TOKYO_MS = 9 * 3_600_000;
const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export function dayNumber(day: string): number {
  const match = dayPattern.exec(day);
  if (!match) throw Error("DATE");
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (y < 1900 || y > 2100) throw Error("DATE");
  const value = Date.UTC(y, m - 1, d);
  if (new Date(value).toISOString().slice(0, 10) !== day) throw Error("DATE");
  return Math.floor(value / DAY_MS);
}
export function dayText(dayNumberUtc: number): string {
  return new Date(dayNumberUtc * DAY_MS).toISOString().slice(0, 10);
}
export function tokyoDay(instant: string): string | null {
  if (!timestampPattern.test(instant)) return null;
  const millis = Date.parse(instant);
  if (!Number.isFinite(millis)) return null;
  const iso = new Date(millis + TOKYO_MS).toISOString();
  return iso.slice(0, 10);
}
export function todayTokyo(now = Date.now()): string {
  return new Date(now + TOKYO_MS).toISOString().slice(0, 10);
}
export function startInstantJst(day: string): number {
  return dayNumber(day) * DAY_MS - TOKYO_MS;
}
function labelForSource(source: string): "ECLEAR" | "その他" {
  return source === "eclear" || source === "csv:eclear" ? "ECLEAR" : "その他";
}

// Use the raw records only in memory. Do NOT include IDs, arbitrary source
// identifiers, fingerprints, owner IDs, or source-row keys in API output.
export function summarizeWeightTrend(
  records: MeasurementRow[], from: string, to: string,
): WeightTrend {
  const start = dayNumber(from), end = dayNumber(to);
  if (end < start || end - start + 1 > MAX_TREND_DAYS) throw Error("RANGE");
  const fetchedStart = start - 6;
  type DayBucket = {
    eligible: Array<MeasurementRow & { epoch: number }>;
    excludedAnomalies: number;
    excludedNonMeasured: number;
  };
  const buckets = new Map<number, DayBucket>();
  for (const row of records) {
    const day = tokyoDay(row.measured_at);
    if (!day) continue;
    const n = dayNumber(day);
    if (n < fetchedStart || n > end) continue;
    let bucket = buckets.get(n);
    if (!bucket) {
      bucket = { eligible: [], excludedAnomalies: 0, excludedNonMeasured: 0 };
      buckets.set(n, bucket);
    }
    if (row.source_kind !== "measured") { bucket.excludedNonMeasured++; continue; }
    if (row.anomaly_flag !== 0 || row.weight_kg === null
      || !Number.isFinite(row.weight_kg) || row.weight_kg <= 0 || row.weight_kg >= 500) {
      bucket.excludedAnomalies++;
      continue;
    }
    bucket.eligible.push({ ...row, epoch: Date.parse(row.measured_at) });
  }
  const representatives = new Map<number, MeasurementRow>();
  for (const [n, bucket] of buckets) {
    bucket.eligible.sort((a, b) => a.epoch - b.epoch || a.id.localeCompare(b.id, "en"));
    const latest = bucket.eligible[bucket.eligible.length - 1];
    if (latest) representatives.set(n, latest);
  }

  const days: TrendDay[] = [];
  let observedDays = 0, excludedAnomalies = 0, excludedNonMeasured = 0;
  for (let n = start; n <= end; n++) {
    const chosen = representatives.get(n);
    const bucket = buckets.get(n);
    let sum = 0, observed7Days = 0;
    for (let k = n - 6; k <= n; k++) {
      const candidate = representatives.get(k);
      if (candidate?.weight_kg !== null && candidate?.weight_kg !== undefined) {
        observed7Days++;
        sum += candidate.weight_kg;
      }
    }
    if (chosen) observedDays++;
    excludedAnomalies += bucket?.excludedAnomalies ?? 0;
    excludedNonMeasured += bucket?.excludedNonMeasured ?? 0;
    days.push({
      day: dayText(n),
      weightKg: chosen?.weight_kg ?? null,
      measuredAt: chosen?.measured_at ?? null,
      source: labelForSource(chosen?.source_id ?? ""),
      observations: bucket?.eligible.length ?? 0,
      excludedAnomalies: bucket?.excludedAnomalies ?? 0,
      excludedNonMeasured: bucket?.excludedNonMeasured ?? 0,
      // Never manufacture an observation on a missing day.
      average7Kg: chosen && observed7Days >= MIN_MEASURED_DAYS_FOR_AVERAGE
        ? Math.round((sum / observed7Days) * 100) / 100 : null,
      observed7Days,
    });
  }
  return {
    from, to, timezone: "Asia/Tokyo",
    representativeMethod: "last_measured_timestamp_then_id",
    averageMethod: "7_calendar_days_min_4_observed",
    observedDays,
    missingDays: days.length - observedDays,
    excludedAnomalies,
    excludedNonMeasured,
    days,
  };
}
