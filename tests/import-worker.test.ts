import {describe,it,expect,vi} from "vitest";
import {createHandler,type Env} from "../src/worker/index";
describe("import route signed authorization",()=>{
  it("rejects unauthorized preview and confirm before D1 access",async()=>{
    const env={DB:{prepare:vi.fn(),batch:vi.fn()},ASSETS:{fetch:vi.fn()}} as unknown as Env;
    for(const path of ["/api/import/preview","/api/import/confirm"]){
      const r=await createHandler(async()=>null).fetch(new Request("https://example.invalid"+path,{method:"POST",headers:{"Content-Type":"application/json","Cf-Access-Authenticated-User-Email":"owner@example.invalid"},body:"{}"}),env);
      expect(r.status).toBe(403);
    }
    expect(env.DB.prepare).not.toHaveBeenCalled();expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});


// Actual, ephemeral Wrangler D1 (workerd), not a hand-written SQL mock.
// All data is synthetic, remote bindings are disabled and state is in memory.
import { beforeAll, afterAll, beforeEach } from "vitest";
import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
import { handleImport, type ImportDb, type Statement } from "../src/worker/import";
import { hash } from "../src/shared/csv-import";

type LocalStatement = Statement & { run(): Promise<unknown> };
type LocalDb = ImportDb & {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): LocalStatement;
};
const header = "local_day,drinking_presence,drink_cups,steps\n";
const lifestyle = header + "2026-01-02,1,,\n2026-01-03,0,0,0\n2026-01-04,,,\n";
async function send(db: ImportDb, csv: string, confirmed = true) {
  const req = new Request("https://example.invalid/api/import/" + (confirmed ? "confirm" : "preview"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "lifestyle", csv, confirmed, hash: await hash(csv) }),
  });
  const res = await handleImport(req, db, "owner");
  return { status: res.status, data: await res.json() as {
    status?: string; error?: string; inserted?: number; skipped?: number;
    conflicts?: { day: string; fields: string[] }[];
  }};
}
async function count(db: LocalDb, table: "lifestyle_days" | "import_jobs" | "import_row_audit") {
  const result = await db.prepare("SELECT COUNT(*) AS n FROM " + table).first<{ n: number }>();
  return result?.n ?? -1;
}
describe("actual ephemeral Wrangler local D1 import integration", () => {
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: LocalDb }>>>;
  let db: LocalDb;
  beforeAll(async () => {
    platform = await getPlatformProxy<{ DB: LocalDb }>({
      configPath: "wrangler.jsonc",
      persist: false,
      remoteBindings: false,
    });
    db = platform.env.DB;
    const schema = readFileSync("migrations/0001_initial.sql", "utf8")
      .split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
    await db.exec(schema);
  }, 100_000);
  afterAll(async () => { await platform?.dispose(); }, 60_000);
  beforeEach(async () => {
    await db.batch([
      "DELETE FROM import_row_audit",
      "DELETE FROM body_measurements",
      "DELETE FROM lifestyle_days",
      "DELETE FROM import_jobs",
      "DELETE FROM owners",
    ].map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO owners(id, created_at) VALUES (?,?)")
      .bind("owner", "2026-01-01T00:00:00Z").run();
  });

  it("never persists on preview, then confirms all records with exact NULL / zero", async () => {
    const p = await send(db, lifestyle, false);
    expect(p.status).toBe(200);
    expect(await count(db, "import_jobs")).toBe(0);
    expect(await count(db, "lifestyle_days")).toBe(0);
    const result = await send(db, lifestyle);
    expect(result).toMatchObject({ status: 200, data: { status: "confirmed", inserted: 3, skipped: 0 } });
    const saved = await db.prepare(
      "SELECT local_day, drinking_presence, drink_cups, steps, source_id FROM lifestyle_days WHERE owner_id=? ORDER BY local_day"
    ).bind("owner").all<{
      local_day: string; drinking_presence: number | null; drink_cups: number | null;
      steps: number | null; source_id: string;
    }>();
    expect(saved.results).toEqual([
      { local_day: "2026-01-02", drinking_presence: 1, drink_cups: null, steps: null, source_id: "csv:lifestyle" },
      { local_day: "2026-01-03", drinking_presence: 0, drink_cups: 0, steps: 0, source_id: "csv:lifestyle" },
      { local_day: "2026-01-04", drinking_presence: null, drink_cups: null, steps: null, source_id: "csv:lifestyle" },
    ]);
    expect(await count(db, "import_jobs")).toBe(1);
    const replay = await send(db, lifestyle);
    expect(replay.data).toMatchObject({ status: "already_imported", inserted: 0, skipped: 3 });
    expect(await count(db, "lifestyle_days")).toBe(3);
    expect(await count(db, "import_jobs")).toBe(1);
  }, 100_000);

  it("accepts exact cross-file duplicates without creating a second day record", async () => {
    const single = header + "2026-01-03,0,0,0\n";
    const extended = single + "2026-01-05,1,,2500\n";
    expect((await send(db, single)).data?.inserted).toBe(1);
    const second = await send(db, extended);
    expect(second).toMatchObject({ status: 200, data: { inserted: 1, skipped: 1 } });
    expect(await count(db, "lifestyle_days")).toBe(2);
    expect(await count(db, "import_jobs")).toBe(2);
  }, 100_000);

  it("rejects changed nonzero values on the same day and persists no new rows or job", async () => {
    expect((await send(db, header + "2026-01-03,0,0,0\n")).status).toBe(200);
    const csv = header + "2026-01-03,1,,0\n2026-01-06,0,0,5000\n";
    const result = await send(db, csv);
    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({ error: "LIFESTYLE_CONFLICT", conflicts: [{ day: "2026-01-03" }] });
    expect(result.data.conflicts?.[0]?.fields).toContain("drinking_presence");
    expect(result.data.conflicts?.[0]?.fields).toContain("drink_cups");
    expect(await count(db, "lifestyle_days")).toBe(1);
    expect(await count(db, "import_jobs")).toBe(1);
    const saved = await db.prepare("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day=?")
      .bind("2026-01-03").first<{drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(saved).toEqual({ drinking_presence: 0, drink_cups: 0, steps: 0 });
  }, 100_000);

  it("treats NULL and explicit zero as a conflict, never silently overwriting either", async () => {
    expect((await send(db, header + "2026-01-04,,,\n")).status).toBe(200);
    const diff = header + "2026-01-04,0,0,0\n";
    const result = await send(db, diff);
    expect(result.status).toBe(409);
    expect(result.data.conflicts).toEqual([
      { day: "2026-01-04", fields: ["drinking_presence", "drink_cups", "steps"] },
    ]);
    expect(await count(db, "lifestyle_days")).toBe(1);
    expect(await count(db, "import_jobs")).toBe(1);
    const persisted = await db.prepare(
      "SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day=?"
    ).bind("2026-01-04").first<{drinking_presence:number|null;drink_cups:number|null;steps:number|null}>();
    expect(persisted).toEqual({ drinking_presence: null, drink_cups: null, steps: null });
  }, 100_000);

  it("handles races: a conflicting row after preflight makes the transactional status guard abort", async () => {
    const csv = header + "2026-01-03,0,0,0\n2026-01-06,1,,6000\n";
    let raced = false;
    const raceDb: ImportDb = {
      prepare: sql => db.prepare(sql),
      batch: async ops => {
        if (!raced) {
          raced = true;
          await db.prepare("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key) VALUES (?,?,?,?,?,?,?)")
            .bind("owner", "2026-01-03", 1, null, null, "test-concurrent", "race").run();
        }
        return db.batch(ops);
      },
    };
    const result = await send(raceDb, csv);
    expect(raced).toBe(true);
    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({error:"LIFESTYLE_CONFLICT"});
    expect(await count(db,"lifestyle_days")).toBe(1);
    expect(await count(db,"import_jobs")).toBe(0);
    const after = await db.prepare("SELECT source_id,drinking_presence FROM lifestyle_days WHERE local_day=?")
      .bind("2026-01-03").first<{source_id:string;drinking_presence:number}>();
    expect(after).toEqual({source_id:"test-concurrent",drinking_presence:1});
  }, 100_000);

  it("rolls back a *real* D1 batch after first insert fails mid-transaction, then retries cleanly", async () => {
    let injected = false;
    const faultDb: ImportDb = {
      prepare: sql => db.prepare(sql),
      batch: ops => {
        injected = true;
        const invalid = db.prepare(
          "INSERT INTO lifestyle_days(owner_id,local_day,source_id,source_row_key) VALUES (NULL,'2026-02-01','test-fault','failure')"
        );
        return db.batch([...ops.slice(0,3), invalid, ...ops.slice(3)]);
      },
    };
    const failed = await send(faultDb, lifestyle);
    expect(injected).toBe(true);
    expect(failed.status).toBe(503);
    expect(await count(db,"import_jobs")).toBe(0);
    expect(await count(db,"lifestyle_days")).toBe(0);
    const retry = await send(db, lifestyle);
    expect(retry).toMatchObject({status:200,data:{status:"confirmed",inserted:3,skipped:0}});
    expect(await count(db,"import_jobs")).toBe(1);
    expect(await count(db,"lifestyle_days")).toBe(3);
  }, 100_000);
});
