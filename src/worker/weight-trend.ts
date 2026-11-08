import {
  addSevenDayAverage, buildWeightTrend, dateRange, jstDay, parseDay, parseTrendRange,
  type Measurement,
} from "../shared/weight-trend";

type Statement = {
  bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> };
};
export type TrendDb = { prepare(sql: string): Statement };
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const LIMIT = 2001;
const DAY_MS = 86_400_000;
const JST_MS = 9 * 3_600_000;

export async function handleWeightTrend(request: Request, db: TrendDb, ownerId: string): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "METHOD" }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
  }
  const range = parseTrendRange(new URL(request.url));
  if (!range || !dateRange(range.from, range.to)) {
    return Response.json({ error: "INVALID_RANGE" }, { status: 400, headers: HEADERS });
  }
  // Reject future requests as well as invalid ranges, not just in the UI.
  if (range.to > jstDay(Date.now())) {
    return Response.json({ error: "INVALID_RANGE" }, { status: 400, headers: HEADERS });
  }
  const from = parseDay(range.from)!;
  const to = parseDay(range.to)!;
  // Inclusive first day plus six earlier calendar days; exclusive day after end.
  const startSeconds = Math.floor((from - 6 * DAY_MS - JST_MS) / 1000);
  const endSeconds = Math.floor((to + DAY_MS - JST_MS) / 1000);
  try {
    // Explicit owner scope, bounded time, stable tie-break, hard cap.
    // SQLite unixepoch handles timestamps with timezone offsets.
    const result = await db.prepare(
      "SELECT id, measured_at, weight_kg, source_id, source_kind, anomaly_flag " +
      "FROM body_measurements WHERE owner_id = ? " +
      "AND unixepoch(measured_at) >= ? AND unixepoch(measured_at) < ? " +
      "ORDER BY unixepoch(measured_at) ASC, id ASC LIMIT ?"
    ).bind(ownerId, startSeconds, endSeconds, LIMIT).all<Measurement>();
    if (result.results.length >= LIMIT) {
      return Response.json({ error: "TOO_MANY_MEASUREMENTS" }, { status: 422, headers: HEADERS });
    }
    const first = buildWeightTrend(result.results, range.from, range.to);
    const preFrom = new Date(from - 6 * DAY_MS).toISOString().slice(0, 10);
    const pref = result.results.filter(row => {
      const ms = Date.parse(row.measured_at);
      if (!Number.isFinite(ms)) return false;
      const day = new Date(ms + JST_MS).toISOString().slice(0, 10);
      return day >= preFrom && day < range.from;
    });
    const trend = addSevenDayAverage(first, pref);
    return Response.json(trend, { headers: HEADERS });
  } catch {
    return Response.json({ error: "DATA_UNAVAILABLE" }, { status: 503, headers: HEADERS });
  }
}
