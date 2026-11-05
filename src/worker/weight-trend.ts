import {
  dayNumber, dayText, MAX_TREND_DAYS, MAX_TREND_ROWS,
  startInstantJst, summarizeWeightTrend, todayTokyo,
  type MeasurementRow,
} from "../shared/weight-trend";

export interface TrendDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}
const secure = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const error = (code: string, status: number) =>
  Response.json({ error: code }, { status, headers: secure });

export async function handleWeightTrend(request: Request, db: TrendDb, ownerId: string): Promise<Response> {
  if (request.method !== "GET")
    return Response.json({ error: "METHOD" }, { status: 405, headers: { ...secure, Allow: "GET" } });
  try {
    const params = new URL(request.url).searchParams;
    const entries = [...params.keys()];
    if (entries.some(k => k !== "from" && k !== "to")
      || new Set(entries).size !== entries.length
      || params.has("from") !== params.has("to")) return error("INVALID_RANGE", 400);

    const to = params.has("to") ? params.get("to")! : todayTokyo();
    const from = params.has("from") ? params.get("from")! : dayText(dayNumber(to) - 89);
    let start: number, end: number;
    try { start = dayNumber(from); end = dayNumber(to); }
    catch { return error("INVALID_RANGE", 400); }
    if (end < start || end - start + 1 > MAX_TREND_DAYS)
      return error("INVALID_RANGE", 400);

    // unixepoch() converts explicit timezone offsets to one comparable instant.
    // The WHERE clause is bounded to user-selected range plus 6 JST prefetch days,
    // so the first displayed 7-day mean is not biased by the range selector.
    const low = Math.floor(startInstantJst(dayText(start - 6)) / 1000);
    const high = Math.floor(startInstantJst(dayText(end + 1)) / 1000);
    const result = await db.prepare(
      "SELECT id, measured_at, weight_kg, source_id, source_kind, anomaly_flag "
      + "FROM body_measurements WHERE owner_id = ? "
      + "AND unixepoch(measured_at) >= ? AND unixepoch(measured_at) < ? "
      + "ORDER BY unixepoch(measured_at) ASC, id ASC LIMIT ?"
    ).bind(ownerId, low, high, MAX_TREND_ROWS + 1).all<MeasurementRow>();
    if (result.results.length > MAX_TREND_ROWS) return error("RANGE_TOO_DENSE", 422);
    return Response.json(summarizeWeightTrend(result.results, from, to), { headers: secure });
  } catch {
    // Never leak SQL, owner identifiers or health data in errors.
    return error("DATA_UNAVAILABLE", 503);
  }
}
