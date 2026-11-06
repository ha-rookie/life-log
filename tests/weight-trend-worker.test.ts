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
  it("computes the first-window average from exactly six preceding JST days, then drops stale observations", async () => {
    const weight = [
      ["early-1","2026-01-01T08:00:00+09:00",70],
      ["early-2","2026-01-02T08:00:00+09:00",71],
      ["early-3","2026-01-03T08:00:00+09:00",72],
      ["late-6","2026-01-06T23:59:59.999+09:00",73],
      ["a-same","2026-01-07T00:00:00+09:00",74],
      ["z-same","2026-01-06T15:00:00Z",75],
    ] as const;
    for (const [id, timestamp, kg] of weight) await insert(id,"owner",timestamp,kg);
    await insert("other-owner","other","2026-01-07T08:00:00+09:00",99);
    const w = watched();
    const res = await handler().fetch(await request(
      URL + "?from=2026-01-07&to=2026-01-09", await sign(AUTH.OWNER_EMAIL)
    ),w.env);
    expect(res.status).toBe(200);
    const data = await res.json() as {
      days: { day:string;weightKg:number|null;average7Kg:number|null;measuredDaysInWindow:number;measuredAt:string|null }[];
      measuredDays:number;missingDays:number;
    };
    expect(data.days.map(d => d.weightKg)).toEqual([75,null,null]);
    expect(data.days.map(d => d.measuredDaysInWindow)).toEqual([5,4,3]);
    expect(data.days.map(d => d.average7Kg)).toEqual([72.2,72.75,null]);
    expect(data.days[0].measuredAt).toBe("2026-01-06T15:00:00Z");
    expect(data.measuredDays).toBe(1);
    expect(data.missingDays).toBe(2);
    expect(JSON.stringify(data)).not.toContain("other-owner");
    expect(w.prepare).toHaveBeenCalledTimes(1);
  }, 100_000);

  it("rejects invalid dates and non-GET without database calls", async () => {
    for (const [suffix,method,code] of [
      ["?from=2026-02-30&to=2026-03-01","GET",400],
      ["?from=2026-01-01&to=2027-12-31","GET",400],
      ["?from=2026-01-01&to=2026-01-02&owner=other","GET",400],
      ["?from=2099-01-01&to=2099-01-30","GET",400],
      ["","POST",405],
    ] as const) {
      const w=watched();
      const res=await handler().fetch(await request(URL+suffix,await sign(AUTH.OWNER_EMAIL),method),w.env);
      expect(res.status).toBe(code);
      expect(w.prepare).not.toHaveBeenCalled();
    }
  });
  it("returns up to one year of signed-owner JST daily data without altering the stored source", async () => {
    await insert("early","owner","2025-11-15T23:30:00+09:00",76);
    await insert("late","owner","2026-01-03T06:00:00+09:00",74);
    await insert("another","owner","2026-10-31T23:59:00+09:00",73);
    await insert("other","other","2026-03-01T08:00:00+09:00",99);
    const watchedEnv = watched();
    const res = await handler().fetch(
      await request(URL + "?from=2025-11-01&to=2026-10-31", await sign(AUTH.OWNER_EMAIL)),
      watchedEnv.env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { days:{day:string;weightKg:number|null}[];measuredDays:number;missingDays:number };
    expect(body.days).toHaveLength(365);
    expect(body.measuredDays).toBe(3);
    expect(body.missingDays).toBe(362);
    expect(body.days.filter(d=>d.weightKg!==null).map(d=>d.weightKg)).toEqual([76,74,73]);
    expect(JSON.stringify(body)).not.toContain("other");
    expect(watchedEnv.prepare).toHaveBeenCalledTimes(1);
  }, 100_000);


  it("runs React19 Chromium through a signed synthetic Access JWT, real Worker and ephemeral local D1", async () => {
    // This test has no remote bindings or credentials. The HTTP edge below only
    // injects test-signed assertions, as Cloudflare Access would in production.
    if ((globalThis as any).process?.env?.CI !== "true") return;
    const fs = await vi.importActual<any>("node:fs");
    const path = await vi.importActual<any>("node:path");
    const http = await vi.importActual<any>("node:http");
    const child = await vi.importActual<any>("node:child_process");
    const vite = await vi.importActual<any>("vite");
    const { jstDay, parseDay } = await import("../src/shared/weight-trend");
    const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const work = fs.mkdtempSync(path.join(path.resolve("."), ".pr33-jwt-d1-e2e-"));
    const dist = path.join(work, "dist");
    const profile = fs.mkdtempSync(path.join(work, "chrome-"));
    let server: any, chrome: any, ws: WebSocket | undefined;
    try {
      const today = jstDay(Date.now());
      const utcToday = parseDay(today)!;
      const monthToOmit = new Date(Date.UTC(
        Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 7, 1,
      )).toISOString().slice(0, 7);
      // A few dozen records are enough for 30d/12wk/12mo, 4-of-7 mean,
      // a completely missing month, and one other owner's invisible record.
      let inserted = 0;
      for (let age = 0; age < 355; age += age < 42 ? 2 : 16) {
        const day = new Date(utcToday - age * 86_400_000).toISOString().slice(0, 10);
        if (day.startsWith(monthToOmit)) continue;
        await insert("real-browser-" + age, "owner", day + "T08:00:00+09:00", 77 + (age % 8) / 10);
        inserted++;
      }
      await insert("not-owner", "other", today + "T09:00:00+09:00", 99);
      await insert("estimated", "owner", today + "T11:00:00+09:00", 120, "estimated");
      await insert("anomaly", "owner", today + "T12:00:00+09:00", 150, "measured", 1);
      const signedOwner = await sign(AUTH.OWNER_EMAIL);
      const signedOther = await sign("other@example.invalid");
      const worker = handler();
      let identity: "owner" | "other" | "missing" = "owner";
      let d1Fault = false;
      let dbReads = 0;
      const apiStatuses: number[] = [];
      const asset = async (request: Request) => {
        const url = new globalThis.URL(request.url);
        const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
        const resolved = path.resolve(dist, relative);
        if (!resolved.startsWith(dist + path.sep)) return new Response("Not found", { status: 404 });
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          return new Response("Not found", { status: 404 });
        }
        const mime = resolved.endsWith(".js") ? "text/javascript"
          : resolved.endsWith(".css") ? "text/css" : "text/html";
        return new Response(fs.readFileSync(resolved), { headers: { "Content-Type": mime } });
      };
      const env = {
        ...AUTH,
        DB: { prepare(sql: string) {
          if (d1Fault) throw new Error("synthetic secret SQL fault");
          dbReads++;
          return db.prepare(sql);
        }},
        ASSETS: { fetch: asset },
      } as unknown as Env;
      fs.writeFileSync(path.join(work, "entry.tsx"), [
        'import React,{StrictMode} from "react";',
        'import {createRoot} from "react-dom/client";',
        'import {WeightTrendPanel} from "../src/client/WeightTrend";',
        'import "../src/client/styles.css";',
        'window.__realErrors=[];',
        'window.addEventListener("error",e=>window.__realErrors.push(String(e.message)));',
        'window.addEventListener("unhandledrejection",e=>window.__realErrors.push(String(e.reason)));',
        'window.__reactVersion=React.version;',
        'createRoot(document.getElementById("root")).render(<StrictMode><WeightTrendPanel/></StrictMode>);',
      ].join("\n"));
      fs.writeFileSync(path.join(work, "index.html"),
        '<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="container"><div id="root"></div></div><script type="module" src="/entry.tsx"></script></body></html>');
      await vite.build({ configFile: false, root: work, logLevel: "error",
        build: { outDir: dist, emptyOutDir: true } });
      server = http.createServer(async (req: any, res: any) => {
        try {
          const url = "http://127.0.0.1:" + server.address().port + req.url;
          const headers = new Headers();
          if (identity !== "missing") headers.set("Cf-Access-Jwt-Assertion",
            identity === "owner" ? signedOwner : signedOther);
          const result = await worker.fetch(new Request(url, { method: req.method, headers }), env);
          if (new globalThis.URL(url).pathname === "/api/weight/trend") apiStatuses.push(result.status);
          const output = new Uint8Array(await result.arrayBuffer());
          res.writeHead(result.status, Object.fromEntries(result.headers.entries()));
          res.end(output);
        } catch {
          res.writeHead(500);
          res.end("Test HTTP adapter failure");
        }
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const chromeBin = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p: string) => fs.existsSync(p));
      if (!chromeBin) throw new Error("CI Chromium binary not found");
      chrome = child.spawn(chromeBin, ["--headless=new", "--no-sandbox", "--disable-gpu",
        "--disable-dev-shm-usage", "--remote-debugging-port=0",
        "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
      let portInfo = "";
      for (let i = 0; i < 120; i++) {
        const portFile = path.join(profile, "DevToolsActivePort");
        if (fs.existsSync(portFile)) { portInfo = fs.readFileSync(portFile, "utf8"); break; }
        await pause(100);
      }
      if (!portInfo) throw new Error("Chromium DevTools port not ready");
      const debugPort = Number(portInfo.split("\n")[0]);
      const tabs = await (await fetch("http://127.0.0.1:" + debugPort + "/json/list")).json() as any[];
      ws = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener("open", () => resolve(), { once: true });
        ws!.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
      });
      let id = 0;
      const pending = new Map<number, (v: any) => void>();
      ws.addEventListener("message", (msg: any) => {
        const response = JSON.parse(String(msg.data));
        if (typeof response.id === "number" && pending.has(response.id)) {
          pending.get(response.id)!(response);
          pending.delete(response.id);
        }
      });
      async function cdp(method: string, params: any = {}) {
        const n = ++id;
        const promise = new Promise<any>(resolve => pending.set(n, resolve));
        ws!.send(JSON.stringify({ id: n, method, params }));
        const result = await promise;
        if (result.error) throw new Error(method + ": " + JSON.stringify(result.error));
        return result.result;
      }
      async function evaluate(expression: string) {
        const response = await cdp("Runtime.evaluate", {
          expression, awaitPromise: true, returnByValue: true,
        });
        if (response.exceptionDetails) throw new Error(
          "Browser JS exception: " + response.exceptionDetails.text);
        return response.result?.value;
      }
      async function until(expression: string, name: string) {
        for (let i = 0; i < 110; i++) {
          if (await evaluate(expression)) return;
          await pause(100);
        }
        throw new Error("Browser condition timed out: " + name);
      }
      async function click(label: string, selector = "button") {
        const expression = '(()=>{const el=[...document.querySelectorAll('
          + JSON.stringify(selector) + ')].find(x=>x.textContent?.trim()==='
          + JSON.stringify(label) + ');if(!el||el.disabled)return false;el.click();return true})()';
        expect(await evaluate(expression)).toBe(true);
      }
      async function keyRight(selector: string) {
        const before = await evaluate('(()=>{const el=document.querySelector('
          + JSON.stringify(selector) + ');if(!el)return null;el.focus();el.scrollLeft=0;'
          + 'return {focus:document.activeElement===el,width:el.scrollWidth,client:el.clientWidth}})()');
        expect(before?.focus).toBe(true);
        expect(before.width).toBeGreaterThan(before.client);
        for (let i = 0; i < 3; i++) {
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight",
            code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight",
            code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
        }
        await until('document.querySelector(' + JSON.stringify(selector)
          + ').scrollLeft>0', "native ArrowRight scroll of " + selector);
        return await evaluate('document.querySelector(' + JSON.stringify(selector)
          + ').scrollLeft');
      }

      await cdp("Page.enable");
      await cdp("Runtime.enable");
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
      });
      await cdp("Page.navigate", { url: "http://127.0.0.1:" + server.address().port + "/" });
      await until('document.querySelector(".trend-table-scroll tbody")?.children.length===30',
        "30-day data from authenticated local D1");
      expect(await evaluate('window.__reactVersion')).toBe("19.3.1");
      expect(await evaluate('window.innerWidth')).toBe(390);
      const dailyRows = await evaluate('document.querySelector(".trend-table-scroll tbody").children.length');
      expect(dailyRows).toBe(30);
      expect(await evaluate('document.querySelectorAll(".average-point").length')).toBeGreaterThan(0);
      expect(await evaluate('document.querySelector(".trend-difference")?.textContent.includes("目標上限")')).toBe(true);
      const dailyArrow = await keyRight(".trend-table-scroll");
      await click("週", ".trend-granularity button");
      await until('document.querySelector(".trend-period-table tbody")?.children.length===12'
        + '&&!!document.querySelector(".trend-scroll")', "12 weekly rows");
      const weeklyArrow = await keyRight(".trend-scroll");
      await click("月", ".trend-granularity button");
      await until('document.querySelector(".trend-month-fit svg")'
        + '&&document.querySelector(".trend-period-table tbody")?.children.length===12', "12 months");
      const layout = await evaluate('(()=>{const a=document.querySelector(".trend-month-fit");'
        + 'return{viewport:innerWidth,scroll:document.documentElement.scrollWidth,chart:a.scrollWidth,'
        + 'client:a.clientWidth,rows:document.querySelector(".trend-period-table tbody").children.length,'
        + 'missing:[...document.querySelectorAll(".trend-period-table td")].some(x=>x.textContent==="欠測")}})()');
      expect(layout).toMatchObject({ viewport: 390, rows: 12, missing: true });
      expect(layout.scroll).toBeLessThanOrEqual(390);
      expect(layout.chart).toBe(layout.client);
      const present = await evaluate('document.querySelector(".trend-period-nav span").textContent');
      await click("前の期間", ".trend-period-nav button");
      await until('document.querySelector(".trend-period-nav span").textContent!=='
        + JSON.stringify(present), "previous year");
      await click("次の期間", ".trend-period-nav button");
      await until('document.querySelector(".trend-period-nav span").textContent==='
        + JSON.stringify(present), "next year");
      await click("前の期間", ".trend-period-nav button");
      await until('document.querySelector(".trend-period-nav span").textContent!=='
        + JSON.stringify(present), "previous again");
      await click("最新へ", ".trend-period-nav button");
      await until('document.querySelector(".trend-period-nav span").textContent==='
        + JSON.stringify(present), "latest reset");
      // Confirm real Worker JWT rejection: response must be 403, with zero D1 reads.
      const readsBeforeDenial = dbReads;
      identity = "other";
      const denied = await evaluate('fetch("/api/weight/trend?from=' + today + '&to=' + today
        + '").then(r=>({status:r.status,cache:r.headers.get("Cache-Control")}))');
      expect(denied.status).toBe(403);
      expect(denied.cache).toContain("no-store");
      expect(dbReads).toBe(readsBeforeDenial);
      await click("前の期間", ".trend-period-nav button");
      await until('document.querySelector("[role=alert]")?.textContent.includes("取得できません")',
        "owner mismatch UI denial");
      identity = "missing";
      const unsigned = await evaluate('fetch("/api/weight/trend?from=' + today + '&to=' + today
        + '").then(r=>r.status)');
      expect(unsigned).toBe(403);
      expect(dbReads).toBe(readsBeforeDenial);
      identity = "owner";
      d1Fault = true;
      await click("最新へ", ".trend-period-nav button");
      await until('document.querySelector("[role=alert]")?.textContent.includes("取得できません")',
        "safe D1 503 UI error");
      expect(apiStatuses).toContain(503);
      d1Fault = false;
      await click("前の期間", ".trend-period-nav button");
      await until('document.querySelector(".trend-period-table tbody")?.children.length===12',
        "recovery after local D1 error");
      expect(await evaluate('window.__realErrors.length')).toBe(0);
      expect(apiStatuses).toContain(200);
      expect(apiStatuses).toContain(403);
      expect(inserted).toBeGreaterThan(20);
      const report = { react: "19.3.1", viewport: 390, dailyRows, weeklyRows: 12,
        monthlyRows: layout.rows, monthlyNoOverflow: layout.scroll <= 390
          && layout.chart === layout.client, nativeArrowDailyPx: dailyArrow,
        nativeArrowWeeklyPx: weeklyArrow, signedOwnerVerified: true,
        otherAndMissingJwtDeniedWithoutD1: true, statusCodes: [...new Set(apiStatuses)],
        syntheticD1: "ephemeral Wrangler local", localOnly: true, jsErrors: 0 };
      console.log("SIGNED_WORKER_LOCAL_D1_REACT19_CHROMIUM_390", JSON.stringify(report));
    } finally {
      try { ws?.close(); } catch {}
      try { chrome?.kill(); } catch {}
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      await pause(250);
      try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    }
  }, 180_000);

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
