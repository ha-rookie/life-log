import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { verifyOwner } from "../src/worker/auth";

type D1 = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
    run(): Promise<unknown>;
  };
  batch(stmts: unknown[]): Promise<unknown>;
};
const AUTH = {
  ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
  ACCESS_AUD: "synthetic-test-audience",
  OWNER_EMAIL: "owner@example.invalid",
};
const URL = "https://example.invalid/api/weight/trend";
describe("Issue #25: signed owner + actual ephemeral local D1 weight trend", () => {
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1 }>>>;
  let db: D1;
  let sign: (email: string) => Promise<string>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "local", alg: "RS256" }] });
    sign = (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "local" })
      .setIssuer("https://" + AUTH.ACCESS_TEAM_DOMAIN).setAudience(AUTH.ACCESS_AUD)
      .setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    platform = await getPlatformProxy<{ DB: D1 }>({
      configPath: "wrangler.jsonc", remoteBindings: false, persist: false,
    });
    db = platform.env.DB;
    const schema = schemaSql.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
    for (const statement of schema.split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }, 100_000);
  afterAll(async () => { await platform?.dispose(); }, 60_000);
  beforeEach(async () => {
    await db.prepare("DELETE FROM body_measurements").run();
    await db.prepare("DELETE FROM owners").run();
    await db.prepare("INSERT INTO owners(id,created_at) VALUES ('owner','2026-01-01'),('other','2026-01-01')").run();
  });
  function watched() {
    const prepare = vi.fn((sql: string) => db.prepare(sql));
    const assets = vi.fn(async () => new Response("private"));
    return { env: { ...AUTH, DB: { prepare }, ASSETS: { fetch: assets } } as unknown as Env, prepare, assets };
  }
  function handler() { return createHandler((request, env) => verifyOwner(request, env, keys)); }
  async function request(url: string, token?: string, method = "GET") {
    return new Request(url, { method, headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });
  }
  async function insert(id: string, owner: string, at: string, weight: number, kind = "measured", anomaly = 0) {
    await db.prepare(
      "INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind,anomaly_flag) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id,owner,at,weight,"synthetic",id,kind,anomaly).run();
  }
  it("denies unsigned, spoofed, forged, and other owner without any D1 read", async () => {
    const badTokens = [undefined, "forged", await sign("other@example.invalid")];
    for (const token of badTokens) {
      const w = watched();
      const req = await request(URL,token);
      req.headers.set("Cf-Access-Authenticated-User-Email",AUTH.OWNER_EMAIL);
      const res = await handler().fetch(req,w.env);
      expect(res.status).toBe(403);
      expect(w.prepare).not.toHaveBeenCalled();
      expect(w.assets).not.toHaveBeenCalled();
    }
  });
  it("owner only, excludes anomalies and estimated, preserves missing days and does not write", async () => {
    await insert("a","owner","2026-01-01T08:00:00+09:00",74);
    await insert("b","owner","2026-01-01T21:00:00+09:00",75);
    await insert("c","owner","2026-01-02T01:00:00+09:00",76);
    await insert("d","other","2026-01-03T08:00:00+09:00",99);
    await insert("e","owner","2026-01-03T08:00:00+09:00",100,"estimated");
    await insert("f","owner","2026-01-04T08:00:00+09:00",110,"measured",1);
    const w = watched();
    const res = await handler().fetch(await request(URL+"?from=2026-01-01&to=2026-01-05",await sign(AUTH.OWNER_EMAIL)),w.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const data = await res.json() as { days:{weightKg:number|null;average7Kg:number|null;measuredDaysInWindow:number}[]; measuredDays:number;missingDays:number;excludedAnomaly:number;excludedNonMeasured:number };
    expect(data.days.map(x=>x.weightKg)).toEqual([75,76,null,null,null]);
    expect(data.measuredDays).toBe(2);
    expect(data.missingDays).toBe(3);
    expect(data.excludedAnomaly).toBe(1);
    expect(data.excludedNonMeasured).toBe(1);
    expect(data.days.every(x=>x.average7Kg===null)).toBe(true);
    expect(w.prepare).toHaveBeenCalledTimes(1);
    const sql = w.prepare.mock.calls[0][0];
    expect(sql).toContain("owner_id = ?");
    expect(sql).toContain("LIMIT ?");
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(JSON.stringify(data)).not.toContain("other");
    expect(JSON.stringify(data)).not.toContain("synthetic");
  }, 100_000);
  it("rejects invalid dates and non-GET without database calls", async () => {
    for (const [suffix,method,code] of [
      ["?from=2026-02-30&to=2026-03-01","GET",400],
      ["?from=2026-01-01&to=2027-12-31","GET",400],
      ["?from=2026-01-01&to=2026-01-02&owner=other","GET",400],
      ["","POST",405],
    ] as const) {
      const w=watched();
      const res=await handler().fetch(await request(URL+suffix,await sign(AUTH.OWNER_EMAIL),method),w.env);
      expect(res.status).toBe(code);
      expect(w.prepare).not.toHaveBeenCalled();
    }
  });
  it("returns safe 503 for D1 failure and 422 rather than truncating excessive rows", async () => {
    const bad=watched();
    bad.env.DB.prepare=vi.fn(()=>{throw Error("sensitive SQL error");}) as unknown as Env["DB"]["prepare"];
    const token=await sign(AUTH.OWNER_EMAIL);
    const failed=await handler().fetch(await request(URL+"?from=2026-01-01&to=2026-01-02",token),bad.env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("sensitive SQL");
    const huge=watched();
    huge.env.DB.prepare=vi.fn(()=>({bind:()=>({all:async()=>({results:Array(2001).fill({
      id:"x",measured_at:"2026-01-01T01:00:00+09:00",weight_kg:70,source_kind:"measured",anomaly_flag:0
    })})})})) as unknown as Env["DB"]["prepare"];
    const overflow=await handler().fetch(await request(URL+"?from=2026-01-01&to=2026-01-02",token),huge.env);
    expect(overflow.status).toBe(422);
  });
});
