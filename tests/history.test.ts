import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import schemaSql from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { handleHistory } from "../src/worker/history";
import { handleImport, type ImportDb, type Statement } from "../src/worker/import";
import { hash } from "../src/shared/csv-import";

interface LocalStatement extends Statement {
  bind(...args: unknown[]): LocalStatement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}
interface LocalDb extends ImportDb { prepare(sql: string): LocalStatement; }
type HistoryJob = { id: string; source: string; auditState: string; auditCount: number | null;
  counts: { inserted: number; skipped: number; conflicted: number } | null };
type HistoryPage = { page: number; limit: number; hasMore: boolean; jobs: HistoryJob[] };
type HistoryRow = {
  line: number; result: string; errorCode: string | null;
  currentLifestyle: { drinkingPresence: number | null; drinkCups: number | null; steps: number | null } | null;
};
type RowPage = { page: number; limit: number; hasMore: boolean; job: HistoryJob; rows: HistoryRow[] };

const hdr = "local_day,drinking_presence,drink_cups,steps\n";
const eclear = "measured_at,weight_kg,body_fat_pct\n2026-01-02T07:00:00+09:00,72.2,22.5\n";
const url = (path = "/api/import/history") => "https://example.invalid" + path;
const read = async <T>(db: Pick<ImportDb, "prepare">, path = "/api/import/history", owner = "owner") => {
  const response = await handleHistory(new Request(url(path)), db, owner);
  return { status: response.status, headers: response.headers, body: await response.json() as T };
};
const cid = async (csv: string, source: "lifestyle" | "eclear" = "lifestyle", owner = "owner") =>
  owner + ":" + source + ":" + await hash(csv);

async function ingest(db: ImportDb, csv: string, source: "lifestyle" | "eclear" = "lifestyle",
  owner = "owner", resolution?: { mode: "keep_existing"; token: string }) {
  const req = new Request(url("/api/import/confirm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, csv, confirmed: true, hash: await hash(csv), ...(resolution ? { resolution } : {}) }),
  });
  const response = await handleImport(req, db, owner);
  return { status: response.status, body: await response.json() as {
    status?: string; reviewToken?: string; inserted?: number; skipped?: number; conflicted?: number;
  }};
}
async function count(db: LocalDb, table: "import_jobs" | "import_row_audit" | "lifestyle_days" | "body_measurements") {
  return (await db.prepare("SELECT COUNT(*) AS n FROM " + table).first<{ n: number }>())?.n ?? -1;
}

describe("read-only audit API authorization and malformed input", () => {
  it("rejects unsigned and spoofed GETs before any D1/asset call", async () => {
    const dbSpy = { prepare: vi.fn(), batch: vi.fn() };
    const assets = { fetch: vi.fn() };
    const env = { DB: dbSpy, ASSETS: assets } as unknown as Env;
    const handler = createHandler();
    for (const path of ["/api/import/history", "/api/import/history/rows?job=owner:lifestyle:"
      + "a".repeat(64)]) {
      for (const method of ["GET", "POST", "HEAD"]) {
        const r = await handler.fetch(new Request(url(path), {
          method,
          headers: {
            "Cf-Access-Authenticated-User-Email": "owner@example.invalid",
            "Cookie": "CF_Authorization=forged",
          },
        }), env);
        expect(r.status).toBe(403);
        expect(r.headers.get("Cache-Control")).toContain("no-store");
      }
    }
    expect(dbSpy.prepare).not.toHaveBeenCalled();
    expect(dbSpy.batch).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("enforces GET only, strict pagination and rejects all extra/duplicate params BEFORE D1", async () => {
    const spy = vi.fn();
    const db = { prepare: spy } as unknown as Pick<ImportDb, "prepare">;
    const paths = [
      "/api/import/history?page=0",
      "/api/import/history?page=-1",
      "/api/import/history?page=201",
      "/api/import/history?page=1.5",
      "/api/import/history?page=01",
      "/api/import/history?limit=0",
      "/api/import/history?limit=21",
      "/api/import/history?limit=999999",
      "/api/import/history?page=1&page=2",
      "/api/import/history?sort=desc",
      "/api/import/history?job=foreign",
      "/api/import/history/rows?job=",
      "/api/import/history/rows?job=anything",
      "/api/import/history/rows?job=other:lifestyle:" + "a".repeat(64),
      "/api/import/history/rows?job=owner:lifestyle:" + "x".repeat(64),
      "/api/import/history/rows?job=owner:lifestyle:" + "a".repeat(64) + "&job=owner",
      "/api/import/history/rows?job=owner:lifestyle:" + "a".repeat(64) + "&limit=21",
    ];
    for (const path of paths) {
      const r = await handleHistory(new Request(url(path)), db, "owner");
      expect([400, 404]).toContain(r.status);
      expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const post = await handleHistory(new Request(url(), { method: "POST" }), db, "owner");
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("ephemeral Wrangler D1 owner-only history and audit entries", () => {
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: LocalDb }>>>;
  let db: LocalDb;
  beforeAll(async () => {
    proxy = await getPlatformProxy<{ DB: LocalDb }>({
      configPath: "wrangler.jsonc", persist: false, remoteBindings: false,
    });
    db = proxy.env.DB;
    const schema = schemaSql.split("\n")
      .filter((line: string) => !line.trimStart().startsWith("--")).join("\n");
    for (const sql of schema.split(";").map(s => s.trim()).filter(Boolean)) {
      await db.prepare(sql).run();
    }
  }, 100_000);
  afterAll(async () => { await proxy?.dispose(); }, 60_000);
  beforeEach(async () => {
    await db.batch(["DELETE FROM import_row_audit", "DELETE FROM body_measurements",
      "DELETE FROM lifestyle_days", "DELETE FROM import_jobs", "DELETE FROM owners"]
      .map(sql => db.prepare(sql)));
    for (const name of ["owner", "other"]) {
      await db.prepare("INSERT INTO owners(id,created_at) VALUES (?,?)")
        .bind(name, "2026-01-01T00:00:00Z").run();
    }
  });

  it("shows empty owner history, GET never mutates state, and no-store headers are present", async () => {
    const empty = await read<HistoryPage>(db);
    expect(empty).toMatchObject({ status: 200, body: {
      jobs: [], page: 1, limit: 10, hasMore: false,
    } });
    expect(empty.headers.get("Cache-Control")).toBe("private, no-store");
    expect(empty.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(empty.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csv = hdr + "2026-01-03,0,0,0\n";
    expect((await ingest(db, csv)).status).toBe(200);
    const before = [await count(db, "import_jobs"), await count(db, "lifestyle_days"),
      await count(db, "import_row_audit")];
    const sqls: string[] = [];
    const onlySelect: Pick<ImportDb, "prepare"> = {
      prepare: (sql: string) => {
        sqls.push(sql);
        if (!sql.trimStart().startsWith("SELECT")) throw Error("MUTATING_SQL");
        return db.prepare(sql);
      },
    };
    for (let i = 0; i < 2; i++) {
      const list = await read<HistoryPage>(onlySelect);
      expect(list.status).toBe(200);
      const detail = await read<RowPage>(onlySelect, "/api/import/history/rows?job="
        + encodeURIComponent(await cid(csv)));
      expect(detail.status).toBe(200);
    }
    expect(sqls.length).toBe(6);
    expect([await count(db, "import_jobs"), await count(db, "lifestyle_days"),
      await count(db, "import_row_audit")]).toEqual(before);
  }, 100_000);

  it("paginates ordered jobs without duplicate or omitted entries and caps results", async () => {
    const input = ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"];
    const ids: string[] = [];
    for (const [index, day] of input.entries()) {
      const csv = hdr + day + ",0,0,0\n";
      expect((await ingest(db, csv)).status).toBe(200);
      const id = await cid(csv);
      ids.push(id);
      await db.prepare("UPDATE import_jobs SET completed_at=? WHERE owner_id=? AND id=?")
        .bind("2026-01-10T10:00:00.000Z", "owner", id).run();
      expect(index).toBeLessThan(5);
    }
    const expected = [...ids].sort().reverse();
    const pages = [];
    for (const page of [1, 2, 3]) {
      const r = await read<HistoryPage>(db, "/api/import/history?page=" + page + "&limit=2");
      expect(r.status).toBe(200);
      pages.push(r.body);
    }
    expect(pages.map(p => p.jobs.length)).toEqual([2, 2, 1]);
    expect(pages.map(p => p.hasMore)).toEqual([true, true, false]);
    expect(pages.flatMap(p => p.jobs.map(j => j.id))).toEqual(expected);
    expect(new Set(pages.flatMap(p => p.jobs.map(j => j.id))).size).toBe(5);
    expect((await read<HistoryPage>(db, "/api/import/history?page=4&limit=2")).body.jobs).toEqual([]);
    expect((await read<HistoryPage>(db, "/api/import/history?page=200&limit=20")).body.jobs).toEqual([]);
    expect(await count(db, "import_jobs")).toBe(5);
  }, 100_000);

  it("preserves null versus explicit zero in CURRENT inserted-lifestyle values without guessing skipped values", async () => {
    const input = hdr + "2026-01-02,1,,\n2026-01-03,0,0,0\n2026-01-04,,,\n";
    expect((await ingest(db, input)).status).toBe(200);
    const detail = await read<RowPage>(db, "/api/import/history/rows?job=" + encodeURIComponent(await cid(input)));
    expect(detail.status).toBe(200);
    expect(detail.body.rows.map(r => [r.line, r.result, r.currentLifestyle])).toEqual([
      [2, "inserted", { drinkingPresence: 1, drinkCups: null, steps: null }],
      [3, "inserted", { drinkingPresence: 0, drinkCups: 0, steps: 0 }],
      [4, "inserted", { drinkingPresence: null, drinkCups: null, steps: null }],
    ]);
    const text = JSON.stringify(detail.body);
    expect(text).not.toContain("source_row_key");
    expect(text).not.toContain("file_sha256");
    expect(text).not.toContain("owner_id");
    expect(text).not.toContain("body_fat_pct");
    const matched = hdr + "2026-01-03,0,0,0\n2026-01-07,0,0,500\n";
    expect((await ingest(db, matched)).status).toBe(200);
    const second = await read<RowPage>(db, "/api/import/history/rows?job="
      + encodeURIComponent(await cid(matched)));
    expect(second.body.rows).toMatchObject([
      { line: 2, result: "skipped", currentLifestyle: null },
      { line: 3, result: "inserted", currentLifestyle: {
        drinkingPresence: 0, drinkCups: 0, steps: 500,
      } },
    ]);
  }, 100_000);

  it("paginates row details independently of jobs and keeps error code on conflict", async () => {
    const csv = hdr + "2026-01-02,0,0,0\n2026-01-03,0,0,1\n2026-01-04,0,0,2\n";
    await ingest(db, csv);
    const job = await cid(csv);
    const base = "/api/import/history/rows?job=" + encodeURIComponent(job);
    const p1 = await read<RowPage>(db, base + "&page=1&limit=2");
    const p2 = await read<RowPage>(db, base + "&page=2&limit=2");
    expect(p1.body.rows.map(x => x.line)).toEqual([2, 3]);
    expect(p2.body.rows.map(x => x.line)).toEqual([4]);
    expect([p1.body.hasMore, p2.body.hasMore]).toEqual([true, false]);
    const legacyBase = hdr + "2026-01-05,0,0,0\n";
    const withConflict = hdr + "2026-01-05,1,,0\n2026-01-06,0,0,6\n";
    await ingest(db, legacyBase);
    const review = await ingest(db, withConflict);
    expect(review.status).toBe(409);
    const confirmed = await ingest(db, withConflict, "lifestyle", "owner", {
      mode: "keep_existing", token: review.body.reviewToken!,
    });
    expect(confirmed.status).toBe(200);
    const conflictRows = await read<RowPage>(db, "/api/import/history/rows?job="
      + encodeURIComponent(await cid(withConflict)));
    expect(conflictRows.body.rows).toMatchObject([
      { line: 2, result: "conflict", errorCode: "LIFESTYLE_CONFLICT_KEPT", currentLifestyle: null },
      { line: 3, result: "inserted", errorCode: null, currentLifestyle: {
        drinkingPresence: 0, drinkCups: 0, steps: 6,
      } },
    ]);
  }, 100_000);

  it("distinguishes legacy absent, modern zero-missing and recorded-but-not-proven-complete audits", async () => {
    const legacy = hdr + "2026-01-09,0,0,0\n";
    const oldId = await cid(legacy);
    await db.prepare(
      "INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at,completed_at)"
        + " VALUES (?,?,?,?,?,?,?,?)"
    ).bind(oldId, "owner", "lifestyle", "csv:lifestyle", await hash(legacy),
      "confirmed", "2026-01-01Z", "2026-01-02Z").run();
    const newFile = hdr + "2026-01-10,0,0,0\n";
    await ingest(db, newFile);
    const brokenId = await cid(newFile);
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=?").bind(brokenId).run();
    const recordedFile = hdr + "2026-01-11,0,0,0\n2026-01-12,0,0,0\n";
    await ingest(db, recordedFile);
    const recordedId = await cid(recordedFile);
    await db.prepare("DELETE FROM import_row_audit WHERE import_job_id=? AND source_row_number=?")
      .bind(recordedId, 3).run();
    const list = await read<HistoryPage>(db);
    const lookup = new Map(list.body.jobs.map(j => [j.id, j]));
    expect(lookup.get(oldId)).toMatchObject({
      auditState: "legacy_unavailable", auditCount: null, counts: null,
    });
    expect(lookup.get(brokenId)).toMatchObject({
      auditState: "incomplete", auditCount: null, counts: null,
    });
    // No expected-row-count column exists: one remaining audit is displayed
    // as "recorded" but never claimed "complete".
    expect(lookup.get(recordedId)).toMatchObject({
      auditState: "recorded", auditCount: 1, counts: {
        inserted: 1, skipped: 0, conflicted: 0,
      },
    });
    const legacyRows = await read<RowPage>(db, "/api/import/history/rows?job=" + encodeURIComponent(oldId));
    expect(legacyRows.body.rows).toEqual([]);
    expect(legacyRows.body.job.auditState).toBe("legacy_unavailable");
    const modernRows = await read<RowPage>(db, "/api/import/history/rows?job=" + encodeURIComponent(brokenId));
    expect(modernRows.body.rows).toEqual([]);
    expect(modernRows.body.job.auditState).toBe("incomplete");
  }, 100_000);

  it("never reveals another owner's job or audit through list or detail", async () => {
    const mine = hdr + "2026-01-03,0,0,0\n";
    const other = hdr + "2026-01-03,1,,0\n";
    expect((await ingest(db, mine)).status).toBe(200);
    expect((await ingest(db, other, "lifestyle", "other")).status).toBe(200);
    const myId = await cid(mine);
    const otherId = await cid(other, "lifestyle", "other");
    const list = await read<HistoryPage>(db, "/api/import/history", "owner");
    expect(list.body.jobs.map(j => j.id)).toEqual([myId]);
    const otherList = await read<HistoryPage>(db, "/api/import/history", "other");
    expect(otherList.body.jobs.map(j => j.id)).toEqual([otherId]);
    const foreign = await read<unknown>(db, "/api/import/history/rows?job="
      + encodeURIComponent(otherId), "owner");
    expect(foreign.status).toBe(404);
    const unowned = await read<unknown>(db, "/api/import/history/rows?job="
      + encodeURIComponent(myId), "other");
    expect(unowned.status).toBe(404);
    const sameFormatMissing = "owner:lifestyle:" + "f".repeat(64);
    expect((await read<unknown>(db, "/api/import/history/rows?job="
      + encodeURIComponent(sameFormatMissing))).status).toBe(404);
  }, 100_000);

  it("does not disclose ECLEAR body values or row keys, and handles D1 outages without exception leakage", async () => {
    expect((await ingest(db, eclear, "eclear")).status).toBe(200);
    const job = await cid(eclear, "eclear");
    const detail = await read<RowPage>(db, "/api/import/history/rows?job="
      + encodeURIComponent(job));
    expect(detail.body.rows).toMatchObject([{ line: 2, result: "inserted", currentLifestyle: null }]);
    const json = JSON.stringify(detail.body);
    expect(json).not.toContain("72.2");
    expect(json).not.toContain("22.5");
    expect(json).not.toContain("source_row_key");
    const broken = { prepare() { throw Error("private SQL, owner@example.invalid and health values"); } };
    const error = await read<unknown>(broken as unknown as Pick<ImportDb, "prepare">);
    expect(error.status).toBe(503);
    const content = JSON.stringify(error.body);
    expect(content).toContain("DATA_UNAVAILABLE");
    expect(content).not.toContain("private SQL");
    expect(content).not.toContain("owner@example.invalid");
  }, 100_000);
});
