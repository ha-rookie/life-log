import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { verifyOwner } from "../src/worker/auth";
import { isSafeLocalImport, type ImportDb, type Statement } from "../src/worker/import";
import { hash } from "../src/shared/csv-import";

interface LocalStatement extends Statement {
  bind(...values: unknown[]): LocalStatement;
  run(): Promise<unknown>;
}
interface LocalDb extends ImportDb { prepare(sql: string): LocalStatement; }
type Counts = { n: number };
type ConfirmResult = {
  status?: string; error?: string; inserted?: number; skipped?: number; conflicted?: number;
  reviewToken?: string; conflicts?: { day: string; fields: string[] }[];
};
const AUTH = {
  ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
  ACCESS_AUD: "synthetic-test-audience",
  OWNER_EMAIL: "owner@example.invalid",
};
const LOCAL = "http://127.0.0.1:8787/api/import/confirm";
const HEAD = "local_day,drinking_presence,drink_cups,steps\n";
const CSV = HEAD + "2026-01-02,1,,\n2026-01-03,0,0,0\n";

function observedEnv(db: LocalDb, enabled?: string) {
  const prepare = vi.fn((sql: string) => db.prepare(sql));
  const batch = vi.fn((statements: Statement[]) => db.batch(statements));
  const assets = vi.fn(async () => new Response("private"));
  const env = {
    ...AUTH, IMPORT_LOCAL_ONLY: enabled,
    DB: { prepare, batch }, ASSETS: { fetch: assets },
  } as unknown as Env;
  return { env, prepare, batch, assets };
}

async function confirm(options: {
  url?: string; token?: string; origin?: string | null; site?: string | null;
  csv?: string; resolution?: { mode: "keep_existing"; token: string };
  headers?: Record<string, string>; body?: Record<string, unknown>;
} = {}): Promise<Request> {
  const url = options.url ?? LOCAL;
  const csv = options.csv ?? CSV;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  if (options.token) headers["Cf-Access-Jwt-Assertion"] = options.token;
  const origin = options.origin === undefined ? new URL(url).origin : options.origin;
  if (origin !== null) headers.Origin = origin;
  const site = options.site === undefined ? "same-origin" : options.site;
  if (site !== null) headers["Sec-Fetch-Site"] = site;
  return new Request(url, {
    method: "POST", headers,
    body: JSON.stringify({
      source: "lifestyle", csv, hash: await hash(csv), confirmed: true,
      ...(options.resolution ? { resolution: options.resolution } : {}),
      ...(options.body ?? {}),
    }),
  });
}

async function count(db: LocalDb, table: "import_jobs" | "import_row_audit" | "lifestyle_days") {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM " + table).first<Counts>();
  return row?.n ?? -1;
}

describe("Issue #19: fail-closed CSV confirm Worker boundary with real local D1", () => {
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: LocalDb }>>>;
  let db: LocalDb;
  let keys: ReturnType<typeof createLocalJWKSet>;
  let sign: (email: string) => Promise<string>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "synthetic", alg: "RS256" }] });
    sign = (email: string) => new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic" })
      .setIssuer("https://" + AUTH.ACCESS_TEAM_DOMAIN)
      .setAudience(AUTH.ACCESS_AUD).setIssuedAt().setExpirationTime("5m")
      .sign(pair.privateKey);
    platform = await getPlatformProxy<{ DB: LocalDb }>({
      configPath: "wrangler.jsonc", remoteBindings: false, persist: false,
    });
    db = platform.env.DB;
    const schema = schemaSql.split("\n").filter((line: string) =>
      !line.trimStart().startsWith("--")).join("\n");
    for (const sql of schema.split(";").map(x => x.trim()).filter(Boolean)) {
      await db.prepare(sql).run();
    }
  }, 100_000);
  afterAll(async () => { await platform?.dispose(); }, 60_000);
  beforeEach(async () => {
    await db.batch([
      "DELETE FROM import_row_audit", "DELETE FROM body_measurements",
      "DELETE FROM lifestyle_days", "DELETE FROM import_jobs", "DELETE FROM owners",
    ].map(sql => db.prepare(sql)));
  });

  const handler = () => createHandler((request, env) => verifyOwner(request, env, keys));

  it("accepts only exact local flag, POST, loopback hostname and matching Origin", () => {
    const req = new Request(LOCAL, {
      method: "POST", headers: { Origin: "http://127.0.0.1:8787", "Sec-Fetch-Site": "same-origin" },
    });
    expect(isSafeLocalImport(req, "true")).toBe(true);
    for (const flag of [undefined, "", "TRUE", "True", "false", "1", " true "]) {
      expect(isSafeLocalImport(req, flag)).toBe(false);
    }
    for (const host of ["localhost", "[::1]"]) {
      const url = "http://" + host + ":8787/api/import/confirm";
      expect(isSafeLocalImport(new Request(url, {
        method: "POST", headers: { Origin: new URL(url).origin },
      }), "true")).toBe(true);
    }
    expect(isSafeLocalImport(new Request(LOCAL, {
      method: "GET", headers: { Origin: "http://127.0.0.1:8787" },
    }), "true")).toBe(false);
  });

  it("denies unset/false/forged runtime flags BEFORE ANY D1 or asset call", async () => {
    const jwt = await sign(AUTH.OWNER_EMAIL);
    for (const flag of [undefined, "", "false", "TRUE", "1"]) {
      const watched = observedEnv(db, flag);
      const req = await confirm({
        token: jwt, headers: { "X-IMPORT_LOCAL_ONLY": "true" },
        body: { IMPORT_LOCAL_ONLY: "true" },
      });
      const response = await handler().fetch(req, watched.env);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "LOCAL_IMPORT_DISABLED" });
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(watched.prepare).not.toHaveBeenCalled();
      expect(watched.batch).not.toHaveBeenCalled();
      expect(watched.assets).not.toHaveBeenCalled();
    }
    expect(await count(db, "import_jobs")).toBe(0);
    expect(await count(db, "import_row_audit")).toBe(0);
  }, 100_000);

  it("denies non-loopback hosts, missing/wrong/null Origin and cross-site contexts without D1 calls", async () => {
    const jwt = await sign(AUTH.OWNER_EMAIL);
    const cases: Parameters<typeof confirm>[0][] = [
      { url: "https://example.invalid/api/import/confirm" },
      { url: "http://127.0.0.2:8787/api/import/confirm" },
      { url: "http://localhost.example.invalid:8787/api/import/confirm" },
      { url: "http://[::2]:8787/api/import/confirm" },
      { origin: null },
      { origin: "null" },
      { origin: "http://127.0.0.1:8788" },
      { origin: "https://127.0.0.1:8787" },
      { origin: "http://localhost:8787" },
      { site: "cross-site" },
      { site: "same-site" },
      { site: "none" },
    ];
    for (const item of cases) {
      const watched = observedEnv(db, "true");
      const response = await handler().fetch(await confirm({ ...item, token: jwt }), watched.env);
      expect(response.status).toBe(403);
      expect(watched.prepare).not.toHaveBeenCalled();
      expect(watched.batch).not.toHaveBeenCalled();
      expect(watched.assets).not.toHaveBeenCalled();
    }
    expect(await count(db, "import_jobs")).toBe(0);
  }, 100_000);

  it("rejects unsigned, spoofed, forged or different-owner identities before any DB access", async () => {
    const someoneElse = await sign("other@example.invalid");
    for (const token of [undefined, "not.a.jwt", someoneElse]) {
      const watched = observedEnv(db, "true");
      const request = await confirm({
        token,
        headers: {
          "Cf-Access-Authenticated-User-Email": AUTH.OWNER_EMAIL,
          "X-User": "owner",
        },
      });
      const response = await handler().fetch(request, watched.env);
      expect(response.status).toBe(403);
      expect(watched.prepare).not.toHaveBeenCalled();
      expect(watched.batch).not.toHaveBeenCalled();
      expect(watched.assets).not.toHaveBeenCalled();
    }
    const noAudience = observedEnv(db, "true");
    noAudience.env.ACCESS_AUD = "";
    const response = await handler().fetch(
      await confirm({ token: await sign(AUTH.OWNER_EMAIL) }), noAudience.env);
    expect(response.status).toBe(403);
    expect(noAudience.prepare).not.toHaveBeenCalled();
  }, 100_000);

  it("keeps signed-owner preview read-only even when confirm opt-in is missing", async () => {
    const watched = observedEnv(db);
    const req = new Request("https://example.invalid/api/import/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": await sign(AUTH.OWNER_EMAIL),
      },
      body: JSON.stringify({ source: "lifestyle", csv: CSV }),
    });
    const response = await handler().fetch(req, watched.env);
    expect(response.status).toBe(200);
    const preview = await response.json() as { rows: unknown[]; errors: unknown[] };
    expect(preview.rows).toHaveLength(2);
    expect(preview.errors).toEqual([]);
    expect(watched.prepare).not.toHaveBeenCalled();
    expect(watched.batch).not.toHaveBeenCalled();
    expect(await count(db, "import_jobs")).toBe(0);
    expect(await count(db, "lifestyle_days")).toBe(0);
  }, 100_000);

  it("rejects non-POST confirm with 405 and no D1 calls", async () => {
    const watched = observedEnv(db, "true");
    const response = await handler().fetch(new Request(LOCAL, {
      method: "GET",
      headers: { "Cf-Access-Jwt-Assertion": await sign(AUTH.OWNER_EMAIL) },
    }), watched.env);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(watched.prepare).not.toHaveBeenCalled();
    expect(watched.batch).not.toHaveBeenCalled();
  }, 100_000);

  it("real signed owner + local flag + exact Origin confirms atomically, preserves NULL/0, audit and replay", async () => {
    const watched = observedEnv(db, "true");
    const jwt = await sign(AUTH.OWNER_EMAIL);
    const first = await handler().fetch(await confirm({ token: jwt }), watched.env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "confirmed", inserted: 2, skipped: 0, conflicted: 0,
    });
    expect(watched.prepare).toHaveBeenCalled();
    expect(watched.batch).toHaveBeenCalledTimes(1);
    const values = await db.prepare(
      "SELECT drinking_presence,drink_cups,steps FROM lifestyle_days ORDER BY local_day"
    ).all<{ drinking_presence:number|null; drink_cups:number|null; steps:number|null }>();
    expect(values.results).toEqual([
      { drinking_presence: 1, drink_cups: null, steps: null },
      { drinking_presence: 0, drink_cups: 0, steps: 0 },
    ]);
    const audits = await db.prepare(
      "SELECT result FROM import_row_audit ORDER BY source_row_number"
    ).all<{ result: string }>();
    expect(audits.results.map(r => r.result)).toEqual(["inserted", "inserted"]);
    const replay = await handler().fetch(await confirm({ token: jwt, site: null }), watched.env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: "already_imported", inserted: 0, skipped: 2,
      original: { inserted: 2, skipped: 0, conflicted: 0 },
    });
    expect(await count(db, "import_jobs")).toBe(1);
    expect(await count(db, "import_row_audit")).toBe(2);
  }, 100_000);

  it("local guard preserves 409 conflict review and non-destructive audited resolution", async () => {
    const watched = observedEnv(db, "true");
    const jwt = await sign(AUTH.OWNER_EMAIL);
    const base = HEAD + "2026-01-03,0,0,0\n";
    const candidate = HEAD + "2026-01-03,1,,0\n2026-01-06,1,,6000\n";
    const initial = await handler().fetch(await confirm({ token: jwt, csv: base }), watched.env);
    expect(initial.status).toBe(200);
    const conflict = await handler().fetch(await confirm({ token: jwt, csv: candidate }), watched.env);
    expect(conflict.status).toBe(409);
    const review = await conflict.json() as ConfirmResult;
    expect(review.error).toBe("LIFESTYLE_CONFLICT");
    expect(review.reviewToken).toMatch(/^[0-9a-f]{64}$/);
    expect(await count(db, "import_jobs")).toBe(1);
    expect(await count(db, "import_row_audit")).toBe(1);
    const accepted = await handler().fetch(await confirm({
      token: jwt, csv: candidate,
      resolution: { mode: "keep_existing", token: review.reviewToken! },
    }), watched.env);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      status: "partial", inserted: 1, skipped: 0, conflicted: 1,
    });
    expect(await count(db, "import_jobs")).toBe(2);
    expect(await count(db, "import_row_audit")).toBe(3);
    const existing = await db.prepare(
      "SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day=?"
    ).bind("2026-01-03")
      .first<{ drinking_presence:number|null; drink_cups:number|null; steps:number|null }>();
    expect(existing).toEqual({ drinking_presence:0, drink_cups:0, steps:0 });
  }, 100_000);

  it("a stale reviewed snapshot fails closed with the original job and audit intact", async () => {
    const watched = observedEnv(db, "true");
    const jwt = await sign(AUTH.OWNER_EMAIL);
    const base = HEAD + "2026-01-03,0,0,0\n";
    const candidate = HEAD + "2026-01-03,1,,0\n";
    expect((await handler().fetch(await confirm({ token: jwt, csv: base }), watched.env)).status).toBe(200);
    const blocked = await handler().fetch(await confirm({ token: jwt, csv: candidate }), watched.env);
    const reviewed = await blocked.json() as ConfirmResult;
    expect(blocked.status).toBe(409);
    await db.prepare("UPDATE lifestyle_days SET steps=? WHERE owner_id=? AND local_day=?")
      .bind(19, "owner", "2026-01-03").run();
    const stale = await handler().fetch(await confirm({
      token: jwt, csv: candidate,
      resolution: { mode:"keep_existing", token: reviewed.reviewToken! },
    }), watched.env);
    expect(stale.status).toBe(409);
    expect((await stale.json() as ConfirmResult).error).toBe("REVIEW_STALE");
    expect(await count(db, "import_jobs")).toBe(1);
    expect(await count(db, "import_row_audit")).toBe(1);
  }, 100_000);
});
