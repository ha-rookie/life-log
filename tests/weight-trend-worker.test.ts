import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { verifyOwner } from "../src/worker/auth";
import type { MeasurementRow } from "../src/shared/weight-trend";

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
};
type LocalDb = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
};
const AUTH = {
  ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
  ACCESS_AUD: "synthetic-trend-audience",
  OWNER_EMAIL: "owner@example.invalid",
};
const endpoint = "https://example.invalid/api/weight/trend";
type TrendResponse = {
  observedDays: number; missingDays: number; excludedAnomalies: number;
  days: {day:string;weightKg:number|null;average7Kg:number|null;observed7Days:number;
    measuredAt:string|null;source:string;observations:number}[];
};

describe("Issue #25 signed owner-only trend GET on ephemeral local Wrangler D1", () => {
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: LocalDb }>>>;
  let db: LocalDb;
  let keys: ReturnType<typeof createLocalJWKSet>;
  let token: string, otherToken: string;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "synthetic-trend", alg: "RS256" }] });
    const sign = (email: string) => new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-trend" })
      .setIssuer("https://" + AUTH.ACCESS_TEAM_DOMAIN)
      .setAudience(AUTH.ACCESS_AUD)
      .setIssuedAt().setExpirationTime("5m")
      .sign(pair.privateKey);
    token = await sign(AUTH.OWNER_EMAIL);
    otherToken = await sign("other@example.invalid");
    platform = await getPlatformProxy<{ DB: LocalDb }>({
      configPath: "wrangler.jsonc", remoteBindings: false, persist: false,
    });
    db = platform.env.DB;
    const schema = schemaSql.split("\n").filter(line =>
      !line.trimStart().startsWith("--")).join("\n");
    for (const sql of schema.split(";").map(s => s.trim()).filter(Boolean)) {
      await db.prepare(sql).run();
    }
  }, 100_000);
  afterAll(async () => { await platform?.dispose(); }, 60_000);
  beforeEach(async () => {
    await db.batch([
      "DELETE FROM import_row_audit", "DELETE FROM body_measurements",
      "DELETE FROM lifestyle_days", "DELETE FROM import_jobs", "DELETE FROM owners",
    ].map(sql => db.prepare(sql)));
    for (const owner of ["owner", "other"]) {
      await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?)")
        .bind(owner, "2026-01-01T00:00:00+09:00").run();
    }
  });

  async function seed(id: string, owner: string, time: string, weight: number | null,
    extra: {kind?: string; anomaly?: number; source?: string} = {}) {
    await db.prepare(
      "INSERT INTO body_measurements "
      + "(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind,anomaly_flag) "
      + "VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id, owner, time, weight, extra.source ?? "csv:eclear",
      id, extra.kind ?? "measured", extra.anomaly ?? 0).run();
  }
  function watched() {
    const prepare = vi.fn((sql: string) => db.prepare(sql));
    const batch = vi.fn((statements: D1Statement[]) => db.batch(statements));
    const assets = vi.fn(async () => new Response("private asset"));
    const env = { ...AUTH, DB: { prepare, batch }, ASSETS: { fetch: assets } } as unknown as Env;
    return { env, prepare, batch, assets };
  }
  const handler = () => createHandler((request, env) => verifyOwner(request, env, keys));
  const req = (search: string, providedToken = token, method = "GET") =>
    new Request(endpoint + search, { method,
      headers: { "Cf-Access-Jwt-Assertion": providedToken } });

  it("blocks anonymous, unsigned, different-owner and spoofed identity before ANY D1 call", async () => {
    for (const bad of ["", "forged.jwt.value", otherToken]) {
      const w = watched();
      const request = new Request(endpoint + "?from=2026-01-01&to=2026-01-02", {
        headers: {
          "Cf-Access-Jwt-Assertion": bad,
          "Cf-Access-Authenticated-User-Email": AUTH.OWNER_EMAIL,
          "X-User": "owner",
        },
      });
      const response = await handler().fetch(request, w.env);
      expect(response.status).toBe(403);
      expect(w.prepare).not.toHaveBeenCalled();
      expect(w.batch).not.toHaveBeenCalled();
      expect(w.assets).not.toHaveBeenCalled();
    }
  }, 100_000);

  it("returns owner-scoped last actual daily measurement, no rows from other owner", async () => {
    await seed("earlier", "owner", "2026-01-02T07:00:00+09:00", 72.1);
    await seed("later", "owner", "2026-01-02T20:00:00+09:00", 72.8);
    await seed("anomaly", "owner", "2026-01-02T22:00:00+09:00", 95, {anomaly:1});
    await seed("reported", "owner", "2026-01-02T23:00:00+09:00", 90, {kind:"reported"});
    await seed("secret-from-other-owner", "other", "2026-01-02T23:30:00+09:00", 120);
    const w = watched();
    const response = await handler().fetch(req("?from=2026-01-02&to=2026-01-03"), w.env);
    expect(response.status).toBe(200);
    const body = await response.json() as TrendResponse;
    expect(body.observedDays).toBe(1);
    expect(body.missingDays).toBe(1);
    expect(body.excludedAnomalies).toBe(1);
    expect(body.days[0]).toMatchObject({
      weightKg:72.8,measuredAt:"2026-01-02T20:00:00+09:00",
      observations:2,source:"ECLEAR",
    });
    expect(body.days[1].weightKg).toBeNull();
    expect(w.prepare.mock.calls[0][0]).toContain("WHERE owner_id = ?");
    expect(w.batch).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    for (const secret of ["secret-from-other-owner","source_id","source_row_key","owner_id","fingerprint","120"]) {
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  }, 100_000);

  it("honors JST boundaries, real four-day mean and six-day lookback", async () => {
    await seed("a", "owner", "2025-12-27T07:00:00+09:00", 70);
    await seed("b", "owner", "2025-12-29T07:00:00+09:00", 72);
    await seed("c", "owner", "2025-12-31T07:00:00+09:00", 74);
    await seed("d", "owner", "2026-01-01T15:00:00Z", 76); // Jan 2 JST
    await seed("out", "owner", "2026-01-02T14:59:59Z", 78); // Jan 2 JST, later than d
    const res = await handler().fetch(req("?from=2026-01-02&to=2026-01-03"), watched().env);
    expect(res.status).toBe(200);
    const result = await res.json() as TrendResponse;
    expect(result.days[0].weightKg).toBe(78);
    expect(result.days[0].observed7Days).toBe(4);
    expect(result.days[0].average7Kg).toBe(73.5);
    expect(result.days[1].weightKg).toBeNull();
  }, 100_000);

  it("returns empty 0-observation days without fabricating measurements or 0kg", async () => {
    const res = await handler().fetch(req("?from=2026-02-01&to=2026-02-03"), watched().env);
    const body = await res.json() as TrendResponse;
    expect(res.status).toBe(200);
    expect(body.observedDays).toBe(0);
    expect(body.missingDays).toBe(3);
    expect(body.days.map(x => x.weightKg)).toEqual([null,null,null]);
    expect(body.days.map(x => x.average7Kg)).toEqual([null,null,null]);
  });

  it("rejects invalid/oversized ranges, duplicates and unknown params before database read", async () => {
    const bad = [
      "?from=2026-01-02", "?to=2026-01-02",
      "?from=2026-01-04&to=2026-01-01",
      "?from=2024-01-01&to=2025-01-01",
      "?from=2026-02-30&to=2026-03-01",
      "?from=2026-01-01&to=2026-01-02&to=2026-01-03",
      "?from=2026-01-01&to=2026-01-02&owner_id=other",
      "?foo=x", "?from=&to=2026-01-02",
    ];
    for (const query of bad) {
      const w = watched();
      const res = await handler().fetch(req(query), w.env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error:"INVALID_RANGE" });
      expect(w.prepare).not.toHaveBeenCalled();
      expect(w.batch).not.toHaveBeenCalled();
    }
  }, 100_000);

  it("rejects mutation methods even with valid signed JWT without D1 calls", async () => {
    for (const method of ["POST","PUT","DELETE","HEAD"]) {
      const w = watched();
      const res = await handler().fetch(req("?from=2026-01-01&to=2026-01-02", token, method), w.env);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
      expect(w.prepare).not.toHaveBeenCalled();
      expect(w.batch).not.toHaveBeenCalled();
    }
  }, 100_000);

  it("fails closed on D1 outage with generic error and private cache policy", async () => {
    const env = watched();
    env.env.DB.prepare = vi.fn(() => { throw Error("PRIVATE SQL ERROR"); });
    const res = await handler().fetch(req("?from=2026-01-01&to=2026-01-02"), env.env);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(await res.json()).toEqual({ error:"DATA_UNAVAILABLE" });
    expect(env.batch).not.toHaveBeenCalled();
  }, 100_000);

  it("enforces a hard 2000 row query boundary rather than silently truncating", async () => {
    const env = watched();
    const fake: MeasurementRow = {
      id:"synthetic",measured_at:"2026-01-02T07:00:00+09:00",
      weight_kg:72,source_id:"csv:eclear",source_kind:"measured",anomaly_flag:0,
    };
    env.env.DB.prepare = vi.fn(() => ({
      bind: () => ({ all: async () => ({ results: Array(2001).fill(fake) }) }),
    })) as unknown as Env["DB"]["prepare"];
    const res = await handler().fetch(req("?from=2026-01-01&to=2026-01-02"), env.env);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({error:"RANGE_TOO_DENSE"});
    expect(env.batch).not.toHaveBeenCalled();
  }, 100_000);
});
