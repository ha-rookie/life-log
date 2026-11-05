import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { verifyOwner } from "../src/worker/auth";
import type { ImportDb, Statement } from "../src/worker/import";
import { encodeCsvBytes, hash, hashCsvBytes, previewCsvFileBytes, type CsvSource } from "../src/shared/csv-import";

interface LocalStatement extends Statement {
  bind(...values: unknown[]): LocalStatement;
  run(): Promise<unknown>;
}
interface LocalDb extends ImportDb { prepare(sql: string): LocalStatement; }
const AUTH = {
  ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
  ACCESS_AUD: "test-csv-byte-audience",
  OWNER_EMAIL: "owner@example.invalid",
};
const URL_LOCAL = "http://127.0.0.1:8787/api/import/confirm";
const textBytes = (s: string) => new TextEncoder().encode(s);
const BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const lifestyle = "日付,飲酒,歩数\n2026/01/02,1,8800\n2026/01/03,0,0\n";
type ResponseSummary = { status: string; inserted: number; skipped: number; conflicted: number; error?: string };

describe("Issue #20 Stage 1 — signed Worker and ephemeral local D1 byte import", () => {
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: LocalDb }>>>;
  let db: LocalDb, jwt: string;
  let keys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "synthetic", alg: "RS256" }] });
    jwt = await new SignJWT({ email: AUTH.OWNER_EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic" })
      .setIssuer("https://" + AUTH.ACCESS_TEAM_DOMAIN)
      .setAudience(AUTH.ACCESS_AUD).setIssuedAt().setExpirationTime("5m")
      .sign(pair.privateKey);
    platform = await getPlatformProxy<{ DB: LocalDb }>({
      configPath: "wrangler.jsonc", remoteBindings: false, persist: false,
    });
    db = platform.env.DB;
    const schema = schemaSql.split("\n").filter(x => !x.trimStart().startsWith("--")).join("\n");
    for (const sql of schema.split(";").map(x => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  }, 100_000);
  afterAll(async () => { await platform?.dispose(); }, 60_000);
  beforeEach(async () => {
    await db.batch([
      "DELETE FROM import_row_audit", "DELETE FROM body_measurements",
      "DELETE FROM lifestyle_days", "DELETE FROM import_jobs", "DELETE FROM owners",
    ].map(sql => db.prepare(sql)));
  });
  function guardedEnv(flag?: string) {
    const prepare = vi.fn((sql: string) => db.prepare(sql));
    const batch = vi.fn((statements: Statement[]) => db.batch(statements));
    const env = { ...AUTH, IMPORT_LOCAL_ONLY: flag, DB: { prepare, batch },
      ASSETS: { fetch: vi.fn(async () => new Response("private")) } } as unknown as Env;
    return { env, prepare, batch };
  }
  const handler = () => createHandler((request, env) => verifyOwner(request, env, keys));
  async function request(source: CsvSource, raw: Uint8Array, opts: {
    hash?: string; flag?: string; origin?: string; jwt?: string; url?: string;
    body?: Record<string, unknown>;
  } = {}) {
    const guard = guardedEnv(opts.flag ?? "true");
    const origin = opts.origin ?? "http://127.0.0.1:8787";
    const req = new Request(opts.url ?? URL_LOCAL, {
      method: "POST", headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "Cf-Access-Jwt-Assertion": opts.jwt ?? jwt,
      },
      body: JSON.stringify({
        source, csvBase64: encodeCsvBytes(raw),
        hash: opts.hash ?? await hashCsvBytes(raw), confirmed: true,
        ...(opts.body ?? {}),
      }),
    });
    return { response: await handler().fetch(req, guard.env), ...guard };
  }
  async function count(table: "lifestyle_days" | "body_measurements" | "import_jobs" | "import_row_audit") {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM " + table).first<{ n: number }>();
    return r?.n ?? -1;
  }

  it("imports Japanese lifestyle as one target per row and retains NULL versus explicit 0", async () => {
    const { response } = await request("lifestyle", textBytes(lifestyle));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "confirmed", inserted: 2, skipped: 0, conflicted: 0 });
    expect(await count("lifestyle_days")).toBe(2);
    expect(await count("body_measurements")).toBe(0); // No Stage-2 fanout.
    expect(await count("import_jobs")).toBe(1);
    expect(await count("import_row_audit")).toBe(2);
    const data = await db.prepare(
      "SELECT local_day,drinking_presence,drink_cups,steps FROM lifestyle_days ORDER BY local_day"
    ).all<{ local_day: string; drinking_presence: number | null; drink_cups: number | null; steps: number | null }>();
    expect(data.results).toEqual([
      { local_day: "2026-01-02", drinking_presence: 1, drink_cups: null, steps: 8800 },
      { local_day: "2026-01-03", drinking_presence: 0, drink_cups: 0, steps: 0 },
    ]);
    const audited = await db.prepare("SELECT result FROM import_row_audit ORDER BY source_row_number")
      .all<{ result: string }>();
    expect(audited.results.map(x => x.result)).toEqual(["inserted", "inserted"]);
  }, 100_000);

  it("Japanese ECLEAR stores two genuine same-day measurements including skeletal muscle in existing schema", async () => {
    const csv = "年月日,時刻,体重,体脂肪率,骨格筋率\n2026/01/02,07:30,72.4,18.2,35.5\n2026/01/02,19:20,72.2,,";
    const { response } = await request("eclear", textBytes(csv));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "confirmed", inserted: 2 });
    expect(await count("body_measurements")).toBe(2);
    const list = await db.prepare(
      "SELECT measured_at,weight_kg,body_fat_pct,skeletal_muscle_pct FROM body_measurements ORDER BY measured_at"
    ).all<{ measured_at: string; weight_kg: number; body_fat_pct: number | null; skeletal_muscle_pct: number | null }>();
    expect(list.results).toEqual([
      { measured_at: "2026-01-02T07:30:00+09:00", weight_kg: 72.4, body_fat_pct: 18.2, skeletal_muscle_pct: 35.5 },
      { measured_at: "2026-01-02T19:20:00+09:00", weight_kg: 72.2, body_fat_pct: null, skeletal_muscle_pct: null },
    ]);
    expect(await count("import_row_audit")).toBe(2);
  }, 100_000);

  it("distinguishes BOM/non-BOM file hashes without duplicating same-day lifestyle records", async () => {
    const plain = textBytes(lifestyle), bom = Uint8Array.from([...BOM, ...plain]);
    const one = await request("lifestyle", plain);
    expect(one.response.status).toBe(200);
    expect((await one.response.json() as ResponseSummary).inserted).toBe(2);
    const second = await request("lifestyle", bom);
    expect(second.response.status).toBe(200);
    expect(await second.response.json()).toMatchObject({ inserted: 0, skipped: 2, conflicted: 0 });
    expect(await count("lifestyle_days")).toBe(2);
    expect(await count("import_jobs")).toBe(2);
    expect(await count("import_row_audit")).toBe(4);
    const replay = await request("lifestyle", bom);
    expect(replay.response.status).toBe(200);
    expect(await replay.response.json()).toMatchObject({
      status: "already_imported", original: { inserted: 0, skipped: 2, conflicted: 0 },
    });
    expect(await count("import_jobs")).toBe(2);
  }, 100_000);

  it("rejects malicious encodings, noncanonical base64, hash mismatch and source mismatch BEFORE D1", async () => {
    for (const raw of [
      Uint8Array.from([0xe3, 0x81]), Uint8Array.from([0xc0, 0xaf]),
      Uint8Array.from([0xff, 0xfe, 0x00, 0x44]),
    ]) {
      const { response, prepare, batch } = await request("lifestyle", raw);
      expect(response.status).toBe(422);
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    }
    const sourceWrong = await request("eclear", textBytes(lifestyle));
    expect(sourceWrong.response.status).toBe(422);
    expect(sourceWrong.prepare).not.toHaveBeenCalled();
    const badHash = await request("lifestyle", textBytes(lifestyle), { hash: "0".repeat(64) });
    expect(badHash.response.status).toBe(409);
    expect(badHash.prepare).not.toHaveBeenCalled();
    const bad64 = await request("lifestyle", textBytes(lifestyle), { body: { csvBase64: "YR==" } });
    expect(bad64.response.status).toBe(422);
    expect(bad64.prepare).not.toHaveBeenCalled();
    expect(await count("import_jobs")).toBe(0);
  }, 100_000);

  it("refuses lifestyle weight/clock and mixed/unknown columns without any partial writes", async () => {
    for (const csv of [
      "日付,飲酒,体重_kg\n2026/01/02,1,72.4",
      "日付,飲酒,体重_kg,測定時刻\n2026/01/02,1,72.4,07:30",
      "日付,飲酒,ECLEAR列\n2026/01/02,1,bad",
      "日付,飲酒\n2026/02/30,1",
    ]) {
      const { response, prepare, batch } = await request("lifestyle", textBytes(csv));
      expect(response.status).toBe(422);
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    }
    expect(await count("import_jobs")).toBe(0);
    expect(await count("body_measurements")).toBe(0);
    expect(await count("import_row_audit")).toBe(0);
  }, 100_000);

  it("preserves Issue #19 disabled-by-default and exact Origin guard for byte-based confirm", async () => {
    const raw = textBytes(lifestyle);
    const goodHash = await hashCsvBytes(raw);
    for (const invalid of [
      { flag: "" }, { flag: "false" }, { flag: "TRUE" },
      { origin: "http://127.0.0.1:8788" },
      { url: "https://example.invalid/api/import/confirm" },
    ]) {
      const env = guardedEnv(invalid.flag ?? "true");
      const req = new Request(invalid.url ?? URL_LOCAL, {
        method: "POST", headers: {
          "Content-Type": "application/json",
          Origin: invalid.origin ?? "http://127.0.0.1:8787",
          "Cf-Access-Jwt-Assertion": jwt,
          "Sec-Fetch-Site": "same-origin",
          "X-IMPORT_LOCAL_ONLY": "true",
        },
        body: JSON.stringify({ source: "lifestyle", csvBase64: encodeCsvBytes(raw), hash: goodHash, confirmed: true }),
      });
      const response = await handler().fetch(req, env.env);
      expect(response.status).toBe(403);
      expect(env.prepare).not.toHaveBeenCalled();
      expect(env.batch).not.toHaveBeenCalled();
    }
    expect(await count("import_jobs")).toBe(0);
  }, 100_000);

  it("supports the unmodified existing canonical text-CSV request shape", async () => {
    const csv = "local_day,drinking_presence,drink_cups,steps\n2026-01-02,0,0,0\n";
    const env = guardedEnv("true");
    const response = await handler().fetch(new Request(URL_LOCAL, {
      method: "POST", headers: {
        "Content-Type": "application/json", Origin: "http://127.0.0.1:8787",
        "Cf-Access-Jwt-Assertion": jwt, "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ source: "lifestyle", csv, hash: await hash(csv), confirmed: true }),
    }), env.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "confirmed", inserted: 1 });
    expect(await count("lifestyle_days")).toBe(1);
  }, 100_000);

  it("keeps the audit history GET contract and does not expose source file digest", async () => {
    expect((await request("eclear", textBytes(
      "年月日,時刻,体重\n2026/01/02,07:30,72.4"))).response.status).toBe(200);
    const env = guardedEnv(); // history GET remains independent of write flag
    const res = await handler().fetch(new Request("https://example.invalid/api/import/history", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    }), env.env);
    expect(res.status).toBe(200);
    const result = await res.json() as { jobs: { auditStatus: string; auditCount: number }[] };
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ auditStatus: "available", auditCount: 1 });
    expect(JSON.stringify(result)).not.toContain(await hashCsvBytes(textBytes(
      "年月日,時刻,体重\n2026/01/02,07:30,72.4")));
  }, 100_000);

  it("new bytes replays are idempotent even with different field ordering of the same observations", async () => {
    const first = await request("eclear", textBytes(
      "年月日,時刻,体重,体脂肪率\n2026/01/02,07:30,72.4,18.2"));
    expect(first.response.status).toBe(200);
    const second = await request("eclear", textBytes(
      "体重,体脂肪率,時刻,年月日\n72.4,18.2,07:30,2026/01/02"));
    expect(second.response.status).toBe(200);
    expect(await second.response.json()).toMatchObject({ inserted: 0, skipped: 1 });
    expect(await count("body_measurements")).toBe(1);
  }, 100_000);
});
