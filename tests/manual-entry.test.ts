import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy } from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { verifyOwner } from "../src/worker/auth";
import { isSafeLocalManual } from "../src/worker/manual-entry";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManualEntry } from "../src/client/ManualEntry";

type Statement = {
  bind(...values: unknown[]): Statement;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};
type LocalDb = { prepare(sql: string): Statement };
const AUTH = {
  ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
  ACCESS_AUD: "synthetic-test-audience",
  OWNER_EMAIL: "owner@example.invalid",
};
const LOCAL = "http://127.0.0.1:8787";
const KEY = "00000000-0000-4000-8000-000000000001";
const KEY2 = "00000000-0000-4000-8000-000000000002";
const WEIGHT = { key: KEY, measuredAt: "2026-11-01T08:32:00+09:00", weightKg: 75.1 };
type Outcome = { status?: string; error?: string; row?: unknown; weights?: unknown[]; steps?: unknown[] };
describe("Issue #29: synthetic owner-only manual weight/steps and independent local gate", () => {
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: LocalDb }>>>;
  let db: LocalDb;
  let sign: (email: string) => Promise<string>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "local", alg: "RS256" }] });
    sign = (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "local" })
      .setIssuer("https://" + AUTH.ACCESS_TEAM_DOMAIN).setAudience(AUTH.ACCESS_AUD)
      .setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    platform = await getPlatformProxy<{ DB: LocalDb }>({
      configPath: "wrangler.jsonc", remoteBindings: false, persist: false,
    });
    db = platform.env.DB;
    const cleaned = schema.split("\n").filter(x => !x.trimStart().startsWith("--")).join("\n");
    for (const statement of cleaned.split(";").map(x => x.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }, 100_000);
  afterAll(async () => { await platform?.dispose(); }, 60_000);
  beforeEach(async () => {
    for (const table of ["import_row_audit", "activity_daily", "body_measurements",
      "lifestyle_days", "import_jobs", "owners"]) {
      await db.prepare("DELETE FROM " + table).run();
    }
    await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?),(?,?)")
      .bind("owner", "2026-01-01", "other", "2026-01-01").run();
  });
  function env(flag?: string) {
    const prepare = vi.fn((sql: string) => db.prepare(sql));
    const assets = vi.fn(async () => new Response("private"));
    const result = { ...AUTH, MANUAL_ENTRY_LOCAL_ONLY: flag,
      DB: { prepare }, ASSETS: { fetch: assets } } as unknown as Env;
    return { result, prepare, assets };
  }
  function worker() { return createHandler((r,e) => verifyOwner(r,e,keys)); }
  async function req(path: string, method: string, body?: unknown, email = AUTH.OWNER_EMAIL,
    opts: { origin?: string | null; site?: string | null; token?: string | null; host?: string } = {}) {
    const root = opts.host ?? LOCAL;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const origin = opts.origin === undefined ? root : opts.origin;
    if (origin !== null) headers.Origin = origin;
    const site = opts.site === undefined ? "same-origin" : opts.site;
    if (site !== null) headers["Sec-Fetch-Site"] = site;
    if (opts.token !== null) headers["Cf-Access-Jwt-Assertion"] = opts.token ?? await sign(email);
    return new Request(root + path, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function send(path: string, method: string, body?: unknown, flag: string | null = "true",
    email = AUTH.OWNER_EMAIL, opts = {}) {
    const e = env(flag ?? undefined);
    const res = await worker().fetch(await req(path,method,body,email,opts),e.result);
    const raw = await res.text();
    let bodyResult: Outcome;
    try { bodyResult = JSON.parse(raw) as Outcome; }
    catch { bodyResult = { error: raw }; }
    return { status:res.status, body:bodyResult, queries:e.prepare.mock.calls };
  }
  async function rows(table: "body_measurements" | "activity_daily" | "lifestyle_days") {
    return (await db.prepare("SELECT COUNT(*) AS n FROM "+table).first<{n:number}>())?.n ?? 0;
  }
  it("validates the manual-only gate independently of the CSV opt-in", async () => {
    const request = await req("/api/manual/weight","POST",WEIGHT);
    expect(isSafeLocalManual(request,"true")).toBe(true);
    for (const flag of [null,"","false","TRUE","1"]) {
      const got = await send("/api/manual/weight","POST",WEIGHT,flag);
      expect(got.status).toBe(403);
      expect(got.queries).toHaveLength(0);
    }
    const wrong = [
      { origin:null }, { origin:"http://127.0.0.1:9999" },
      { origin:"null" }, { site:"cross-site" },{ site:"none" },
      { host:"https://example.invalid" },
    ];
    for (const opt of wrong) {
      const e = env("true");
      const result = await worker().fetch(await req("/api/manual/weight","POST",WEIGHT,
        AUTH.OWNER_EMAIL,opt),e.result);
      expect(result.status).toBe(403);
      expect(e.prepare).not.toHaveBeenCalled();
    }
    const e = env("true");
    e.result.IMPORT_LOCAL_ONLY = "true";
    e.result.MANUAL_ENTRY_LOCAL_ONLY = undefined;
    expect((await worker().fetch(await req("/api/manual/weight","POST",WEIGHT),e.result)).status).toBe(403);
    expect(e.prepare).not.toHaveBeenCalled();
    expect(await rows("body_measurements")).toBe(0);
  }, 100_000);
  it("blocks unsigned and other-owner JWTs before all DB reads or writes", async () => {
    for (const opt of [{ token:null }, { token:"forged" }]) {
      const e=env("true");
      const res=await worker().fetch(await req("/api/manual/weight","POST",WEIGHT,
        AUTH.OWNER_EMAIL,opt),e.result);
      expect(res.status).toBe(403);
      expect(e.prepare).not.toHaveBeenCalled();
    }
    const result=await send("/api/manual/weight","POST",WEIGHT,"true","other@example.invalid");
    expect(result.status).toBe(403);
    expect(result.queries).toHaveLength(0);
  });
  it("writes real timestamp, replays same idempotency key, corrects/cancels only manual weights", async () => {
    const first=await send("/api/manual/weight","POST",WEIGHT);
    expect(first.status).toBe(200);
    expect(first.body.row).toMatchObject(WEIGHT);
    const again=await send("/api/manual/weight","POST",WEIGHT);
    expect(again.status).toBe(200);
    expect(await rows("body_measurements")).toBe(1);
    const different=await send("/api/manual/weight","POST",{...WEIGHT,weightKg:78});
    expect(different.status).toBe(409);
    expect(await rows("body_measurements")).toBe(1);
    const trend=await send("/api/weight/trend?from=2026-11-01&to=2026-11-02","GET");
    expect(trend.status).toBe(200);
    expect((trend.body as any).days.map((x:any)=>x.weightKg)).toEqual([75.1,null]);
    const edited=await send("/api/manual/weight","PATCH",{...WEIGHT,weightKg:75.6});
    expect(edited.status).toBe(200);
    const next=await send("/api/weight/trend?from=2026-11-01&to=2026-11-02","GET");
    expect((next.body as any).days[0].weightKg).toBe(75.6);
    const deleted=await send("/api/manual/weight","DELETE",{key:KEY});
    expect(deleted.status).toBe(200);
    expect(await rows("body_measurements")).toBe(0);
    expect((await send("/api/manual/weight","DELETE",{key:KEY})).status).toBe(404);
  }, 100_000);
  it("does not alter CSV-imported weight records by supplied IDs", async () => {
    await db.prepare("INSERT INTO body_measurements "
      + "(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) VALUES (?,?,?,?,?,?,?)")
      .bind("csv-measure","owner","2026-11-01T08:32:00+09:00",74,"csv:eclear",KEY,"measured").run();
    const result=await send("/api/manual/weight","PATCH",{...WEIGHT,weightKg:77});
    expect(result.status).toBe(404);
    expect((await send("/api/manual/weight","DELETE",{key:KEY})).status).toBe(404);
    const row=await db.prepare("SELECT weight_kg AS kg FROM body_measurements WHERE id=?")
      .bind("csv-measure").first<{kg:number}>();
    expect(row?.kg).toBe(74);
  });
  it("supports 0 steps, same-day identical replays, explicit optimistic corrections and cancel", async () => {
    const first=await send("/api/manual/steps","POST",{day:"2026-11-01",steps:0});
    expect(first.status).toBe(200);
    expect(first.body.row).toEqual({day:"2026-11-01",steps:0});
    expect((await send("/api/manual/steps","POST",{day:"2026-11-01",steps:0})).status).toBe(200);
    expect((await send("/api/manual/steps","POST",{day:"2026-11-01",steps:200})).status).toBe(409);
    expect(await rows("activity_daily")).toBe(1);
    expect((await send("/api/manual/steps","PUT",{day:"2026-11-01",steps:1500,expectedSteps:0})).status).toBe(200);
    expect((await send("/api/manual/steps","PUT",{day:"2026-11-01",steps:2500,expectedSteps:0})).status).toBe(409);
    const listing=await send("/api/manual/records?from=2026-11-01&to=2026-11-03","GET");
    expect(listing.status).toBe(200);
    expect(listing.body.steps).toEqual([{day:"2026-11-01",steps:1500}]);
    expect((await send("/api/manual/steps","DELETE",{day:"2026-11-01",expectedSteps:0})).status).toBe(409);
    expect((await send("/api/manual/steps","DELETE",{day:"2026-11-01",expectedSteps:1500})).status).toBe(200);
    expect(await rows("activity_daily")).toBe(0);
  }, 100_000);
  it("never overwrites another activity or CSV lifestyle source on the same day", async () => {
    await db.prepare("INSERT INTO activity_daily "
      + "(id,owner_id,local_day,steps,source_id,source_row_key) VALUES (?,?,?,?,?,?)")
      .bind("imported","owner","2026-11-01",1200,"csv:fit","fit:1").run();
    const blocked=await send("/api/manual/steps","POST",{day:"2026-11-01",steps:1500});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("SOURCE_CONFLICT");
    const old=await db.prepare("SELECT steps FROM activity_daily WHERE id='imported'").first<{steps:number}>();
    expect(old?.steps).toBe(1200);
    await db.prepare("INSERT INTO lifestyle_days "
      + "(owner_id,local_day,steps,source_id,source_row_key) VALUES (?,?,?,?,?)")
      .bind("owner","2026-11-02",0,"csv:lifestyle","lifestyle:2").run();
    expect((await send("/api/manual/steps","POST",{day:"2026-11-02",steps:2300})).status).toBe(409);
    expect(await rows("activity_daily")).toBe(1);
    expect(await rows("lifestyle_days")).toBe(1);
  });
  it("rejects missing/fabricated weight times, invalid steps and excessive/future dates", async () => {
    for (const measuredAt of ["2026-11-01","2026-11-01T00:00:00Z",
      "2026-11-01T08:32:00+08:00","2099-01-01T08:32:00+09:00"]) {
      expect((await send("/api/manual/weight","POST",{...WEIGHT,key:KEY2,measuredAt})).status).toBe(422);
    }
    for (const steps of [-1,1.5,300001,null]) {
      expect((await send("/api/manual/steps","POST",{day:"2026-11-01",steps})).status).toBe(422);
    }
    expect((await send("/api/manual/steps","POST",{day:"2099-01-01",steps:0})).status).toBe(422);
    expect((await send("/api/manual/records?from=2025-01-01&to=2026-01-01","GET")).status).toBe(400);
    expect(await rows("body_measurements")).toBe(0);
    expect(await rows("activity_daily")).toBe(0);
  });
  it("renders required 390px-entry inputs with explicit datetime and no optimistic success", () => {
    const html=renderToStaticMarkup(createElement(ManualEntry,{onSaved:()=>{}}));
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('type="number"');
    expect(html).toContain("体重を記録");
    expect(html).toContain("歩数を記録");
    expect(html).toContain("ローカル開発環境");
    expect(html).toContain("時刻不明の体重は登録せず");
  });
});
