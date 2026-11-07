import { dateRange, jstDay, parseDay } from "../shared/weight-trend";

/** This gate is independent of the CSV-import toggle; never enable in remote Workers. */
export function isSafeLocalManual(request: Request, flag?: string): boolean {
  if (flag !== "true" || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (request.headers.get("Origin") !== url.origin) return false;
  const site = request.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin";
}

export type ManualDb = {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
};
type WeightRow = { key: string; measuredAt: string; weightKg: number };
type StepRow = { day: string; steps: number };
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const json = (x: unknown, status = 200) => Response.json(x, { status, headers: HEADERS });
const error = (code: string, status = 422) => json({ error: code }, status);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_WEIGHT = "manual:weight";
const SOURCE_STEPS = "manual:steps";
const JST_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):00\+09:00$/;
const stepValid = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 300000;
const weightValid = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 && n < 500;
const validDay = (day: unknown): day is string =>
  typeof day === "string" && parseDay(day) !== null && day <= jstDay(Date.now());
const validTime = (time: unknown): time is string => {
  if (typeof time !== "string") return false;
  const match = JST_DATE_TIME.exec(time);
  return !!match && parseDay(match[1]) !== null &&
    Number.isFinite(Date.parse(time)) && Date.parse(time) <= Date.now() + 60000;
};
const validKey = (key: unknown): key is string => typeof key === "string" && UUID.test(key);
async function payload(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return null;
  if (Number(request.headers.get("Content-Length") ?? 0) > 2048) return null;
  let text: string;
  try { text = await request.text(); }
  catch { return null; }
  if (new TextEncoder().encode(text).length > 2048) return null;
  try {
    const p: unknown = JSON.parse(text);
    return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : null;
  } catch { return null; }
}
async function weight(db: ManualDb, owner: string, key: string) {
  return db.prepare(
    "SELECT source_row_key AS key, measured_at AS measuredAt, weight_kg AS weightKg "
    + "FROM body_measurements WHERE owner_id=? AND source_id=? AND source_row_key=?"
  ).bind(owner, SOURCE_WEIGHT, key).first<WeightRow>();
}
async function step(db: ManualDb, owner: string, day: string) {
  return db.prepare("SELECT local_day AS day,steps FROM activity_daily "
    + "WHERE owner_id=? AND source_id=? AND local_day=?")
    .bind(owner, SOURCE_STEPS, day).first<StepRow>();
}
async function conflictingSteps(db: ManualDb, owner: string, day: string): Promise<boolean> {
  const result = await db.prepare(
    "SELECT 1 AS found FROM activity_daily WHERE owner_id=? AND local_day=? "
    + "AND source_id<>? AND steps IS NOT NULL "
    + "UNION ALL SELECT 1 FROM lifestyle_days WHERE owner_id=? AND local_day=? "
    + "AND steps IS NOT NULL LIMIT 1"
  ).bind(owner, day, SOURCE_STEPS, owner, day).first<{ found: number }>();
  return result !== null;
}
const NO_OTHER_STEPS =
  "NOT EXISTS(SELECT 1 FROM activity_daily WHERE owner_id=? AND local_day=? "
  + "AND source_id<>? AND steps IS NOT NULL) AND "
  + "NOT EXISTS(SELECT 1 FROM lifestyle_days WHERE owner_id=? AND local_day=? AND steps IS NOT NULL)";

async function readEntries(request: Request, db: ManualDb, owner: string): Promise<Response> {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some(k => k !== "from" && k !== "to") || new Set(keys).size !== keys.length) return error("RANGE", 400);
  const to = url.searchParams.get("to") ?? jstDay(Date.now());
  const today = parseDay(to);
  const from = url.searchParams.get("from") ??
    new Date(today! - 29 * 86400000).toISOString().slice(0, 10);
  const bounds = dateRange(from, to);
  if (!bounds || bounds.days > 31 || to > jstDay(Date.now())) return error("RANGE", 400);
  const start = Math.floor((bounds.start - 9 * 3600000) / 1000);
  const end = Math.floor((bounds.end + 86400000 - 9 * 3600000) / 1000);
  const weights = await db.prepare(
    "SELECT source_row_key AS key,measured_at AS measuredAt,weight_kg AS weightKg "
    + "FROM body_measurements WHERE owner_id=? AND source_id=? "
    + "AND unixepoch(measured_at)>=? AND unixepoch(measured_at)<? "
    + "ORDER BY unixepoch(measured_at) DESC LIMIT 501"
  ).bind(owner, SOURCE_WEIGHT, start, end).all<WeightRow>();
  const steps = await db.prepare(
    "SELECT local_day AS day,steps FROM activity_daily "
    + "WHERE owner_id=? AND source_id=? AND local_day>=? AND local_day<=? "
    + "ORDER BY local_day DESC LIMIT 501"
  ).bind(owner, SOURCE_STEPS, from, to).all<StepRow>();
  if (weights.results.length > 500 || steps.results.length > 500) return error("TOO_MANY", 422);
  return json({ from, to, weights: weights.results, steps: steps.results });
}

async function modifyWeight(method: string, p: Record<string, unknown>, db: ManualDb, owner: string): Promise<Response> {
  if (!validKey(p.key)) return error("KEY");
  const key = p.key.toLowerCase();
  if (method === "DELETE") {
    const old = await weight(db, owner, key);
    if (!old) return error("NOT_FOUND", 404);
    await db.prepare("DELETE FROM body_measurements "
      + "WHERE owner_id=? AND source_id=? AND source_row_key=?")
      .bind(owner, SOURCE_WEIGHT, key).run();
    return json({ status: "deleted", key });
  }
  if (!validTime(p.measuredAt) || !weightValid(p.weightKg)) return error("MEASUREMENT");
  const timestamp = p.measuredAt;
  const kg = p.weightKg;
  if (method === "POST") {
    await db.prepare(
      "INSERT OR IGNORE INTO body_measurements "
      + "(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) "
      + "VALUES (?,?,?,?,?,?,?)"
    ).bind("manual:weight:" + key, owner, timestamp, kg, SOURCE_WEIGHT, key, "measured").run();
    const current = await weight(db, owner, key);
    if (!current || current.measuredAt !== timestamp || current.weightKg !== kg) return error("CONFLICT", 409);
    return json({ status: "saved", row: current });
  }
  if (method === "PATCH") {
    const current = await weight(db, owner, key);
    if (!current) return error("NOT_FOUND", 404);
    await db.prepare(
      "UPDATE body_measurements SET measured_at=?,weight_kg=? "
      + "WHERE owner_id=? AND source_id=? AND source_row_key=?"
    ).bind(timestamp, kg, owner, SOURCE_WEIGHT, key).run();
    return json({ status: "updated", row: { key, measuredAt: timestamp, weightKg: kg } });
  }
  return error("METHOD", 405);
}

async function modifySteps(method: string, p: Record<string, unknown>, db: ManualDb, owner: string): Promise<Response> {
  if (!validDay(p.day)) return error("DAY");
  const day = p.day;
  if (method !== "DELETE" && !stepValid(p.steps)) return error("STEPS");
  if (method !== "POST" && !stepValid(p.expectedSteps)) return error("EXPECTED_STEPS");
  if (await conflictingSteps(db, owner, day)) return error("SOURCE_CONFLICT", 409);
  const id = "manual:steps:" + owner + ":" + day;
  if (method === "POST") {
    await db.prepare(
      "INSERT OR IGNORE INTO activity_daily "
      + "(id,owner_id,local_day,steps,source_id,source_row_key) "
      + "SELECT ?,?,?,?,?,? WHERE " + NO_OTHER_STEPS
    ).bind(id, owner, day, p.steps, SOURCE_STEPS, day,
      owner, day, SOURCE_STEPS, owner, day).run();
    const current = await step(db, owner, day);
    if (await conflictingSteps(db, owner, day) || !current || current.steps !== p.steps) {
      return error("CONFLICT", 409);
    }
    return json({ status: "saved", row: current });
  }
  if (method === "PUT") {
    await db.prepare(
      "UPDATE activity_daily SET steps=? WHERE owner_id=? AND source_id=? "
      + "AND local_day=? AND steps=? AND " + NO_OTHER_STEPS
    ).bind(p.steps, owner, SOURCE_STEPS, day, p.expectedSteps,
      owner, day, SOURCE_STEPS, owner, day).run();
    const current = await step(db, owner, day);
    if (!current) return error("NOT_FOUND", 404);
    if (await conflictingSteps(db, owner, day) || current.steps !== p.steps) return error("CONFLICT", 409);
    return json({ status: "updated", row: current });
  }
  if (method === "DELETE") {
    await db.prepare(
      "DELETE FROM activity_daily WHERE owner_id=? AND source_id=? "
      + "AND local_day=? AND steps=? AND " + NO_OTHER_STEPS
    ).bind(owner, SOURCE_STEPS, day, p.expectedSteps,
      owner, day, SOURCE_STEPS, owner, day).run();
    if (await step(db, owner, day)) return error("CONFLICT", 409);
    return json({ status: "deleted", day });
  }
  return error("METHOD", 405);
}

export async function handleManualEntry(
  request: Request, db: ManualDb, owner: string, localFlag?: string,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === "/api/manual/records") {
    if (method !== "GET") return error("METHOD", 405);
    try { return await readEntries(request, db, owner); }
    catch { return error("DATA_UNAVAILABLE", 503); }
  }
  const weightRoute = path === "/api/manual/weight";
  const stepRoute = path === "/api/manual/steps";
  if (!weightRoute && !stepRoute) return error("NOT_FOUND", 404);
  const allowed = weightRoute ? ["POST", "PATCH", "DELETE"] : ["POST", "PUT", "DELETE"];
  if (!allowed.includes(method)) return error("METHOD", 405);
  // This test is BEFORE any D1 prepare, and cannot be enabled via a request header.
  if (!isSafeLocalManual(request, localFlag)) return error("MANUAL_LOCAL_DISABLED", 403);
  const data = await payload(request);
  if (!data) return error("PAYLOAD", 400);
  try {
    return weightRoute
      ? await modifyWeight(method, data, db, owner)
      : await modifySteps(method, data, db, owner);
  } catch { return error("DATA_UNAVAILABLE", 503); }
}
