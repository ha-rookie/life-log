import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getPlatformProxy } from "wrangler";
import schema from "../migrations/0001_initial.sql?raw";
import { createHandler, type Env } from "../src/worker/index";
import { verifyOwner } from "../src/worker/auth";
import { isSafeLocalManual, isSafeRemoteManual } from "../src/worker/manual-entry";
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
    opts: { origin?: string | null; site?: string | null; token?: string | null; host?: string; headers?: Record<string,string> } = {}) {
    const root = opts.host ?? LOCAL;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const origin = opts.origin === undefined ? root : opts.origin;
    if (origin !== null) headers.Origin = origin;
    const site = opts.site === undefined ? "same-origin" : opts.site;
    if (site !== null) headers["Sec-Fetch-Site"] = site;
    if (opts.token !== null) headers["Cf-Access-Jwt-Assertion"] = opts.token ?? await sign(email);
    Object.assign(headers, opts.headers ?? {});
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
    const edited=await send("/api/manual/weight","PATCH",{...WEIGHT,weightKg:75.6,
      expectedMeasuredAt:WEIGHT.measuredAt,expectedWeightKg:WEIGHT.weightKg});
    expect(edited.status).toBe(200);
    const next=await send("/api/weight/trend?from=2026-11-01&to=2026-11-02","GET");
    expect((next.body as any).days[0].weightKg).toBe(75.6);
    const deleted=await send("/api/manual/weight","DELETE",{key:KEY,
      expectedMeasuredAt:WEIGHT.measuredAt,expectedWeightKg:75.6});
    expect(deleted.status).toBe(200);
    expect(await rows("body_measurements")).toBe(0);
    expect((await send("/api/manual/weight","DELETE",{key:KEY,
      expectedMeasuredAt:WEIGHT.measuredAt,expectedWeightKg:75.6})).status).toBe(404);
  }, 100_000);
  it("does not alter CSV-imported weight records by supplied IDs", async () => {
    await db.prepare("INSERT INTO body_measurements "
      + "(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind) VALUES (?,?,?,?,?,?,?)")
      .bind("csv-measure","owner","2026-11-01T08:32:00+09:00",74,"csv:eclear",KEY,"measured").run();
    const result=await send("/api/manual/weight","PATCH",{...WEIGHT,weightKg:77,
      expectedMeasuredAt:WEIGHT.measuredAt,expectedWeightKg:WEIGHT.weightKg});
    expect(result.status).toBe(404);
    expect((await send("/api/manual/weight","DELETE",{key:KEY,
      expectedMeasuredAt:WEIGHT.measuredAt,expectedWeightKg:WEIGHT.weightKg})).status).toBe(404);
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

  it("operates real React19 App in 390px Chromium via signed JWT, Worker and ephemeral local D1", async () => {
    if ((globalThis as any).process?.env?.CI !== "true") return;
    const fs = await vi.importActual<any>("node:fs");
    const path = await vi.importActual<any>("node:path");
    const http = await vi.importActual<any>("node:http");
    const child = await vi.importActual<any>("node:child_process");
    const vite = await vi.importActual<any>("vite");
    const { jstDay } = await import("../src/shared/weight-trend");
    const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const dir = fs.mkdtempSync(path.join(path.resolve("."), ".pr34-browser-e2e-"));
    const dist = path.join(dir, "dist");
    const profile = fs.mkdtempSync(path.join(dir, "chrome-"));
    let server: any, chrome: any, ws: WebSocket | undefined;
    const browserErrors: string[] = [];
    try {
      const day = jstDay(Date.now() - 86400000);
      const time = day + "T08:32";
      const jwt = await sign(AUTH.OWNER_EMAIL);
      const handler = worker();
      let localWrites = true;
      let databaseFail = false;
      let authorizedReads = 0;
      let refreshCount = 0;
      let failResponseAfterWeightCommit = false;
      const apiCalls: { path: string; method: string; status: number }[] = [];
      fs.writeFileSync(path.join(dir, "entry.tsx"), [
        'import React,{StrictMode} from "react";',
        'import {createRoot} from "react-dom/client";',
        'import {App} from "../src/client/App";',
        'import "../src/client/styles.css";',
        'window.__browserErrors=[];',
        'window.addEventListener("error",e=>window.__browserErrors.push(String(e.message)));',
        'window.addEventListener("unhandledrejection",e=>window.__browserErrors.push(String(e.reason)));',
        'window.__reactVersion=React.version;',
        'createRoot(document.getElementById("root")).render(<StrictMode><App/></StrictMode>);',
      ].join("\n"));
      fs.writeFileSync(path.join(dir, "index.html"),
        '<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
      await vite.build({configFile:false,root:dir,logLevel:"error",
        build:{outDir:dist,emptyOutDir:true}});
      async function staticAsset(request: Request) {
        const u = new globalThis.URL(request.url);
        const rel = u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname.slice(1));
        const filepath = path.resolve(dist,rel);
        if (!filepath.startsWith(dist + path.sep) || !fs.existsSync(filepath)
          || !fs.statSync(filepath).isFile()) return new Response("Not found",{status:404});
        const mime = filepath.endsWith(".js") ? "text/javascript"
          : filepath.endsWith(".css") ? "text/css" : "text/html";
        return new Response(fs.readFileSync(filepath),{headers:{"Content-Type":mime}});
      }
      const env = {
        ...AUTH, get MANUAL_ENTRY_LOCAL_ONLY() {return localWrites ? "true" : undefined;},
        DB: {prepare(sql:string) {
          if (databaseFail) throw new Error("synthetic confidential D1 failure");
          authorizedReads++;
          return db.prepare(sql);
        }}, ASSETS:{fetch:staticAsset},
      } as unknown as Env;
      server = http.createServer(async (request:any,response:any) => {
        try {
          const url = "http://127.0.0.1:" + server.address().port + request.url;
          const headers = new Headers(request.headers);
          headers.set("Cf-Access-Jwt-Assertion",jwt);
          const input = await (async () => {
            const parts:Uint8Array[]=[];
            for await (const chunk of request) parts.push(new Uint8Array(chunk));
            return new Uint8Array((await vi.importActual<any>("node:buffer")).Buffer.concat(parts));
          })();
          const init:RequestInit = {method:request.method,headers};
          if (!["GET","HEAD"].includes(request.method)) {
            init.body = input;
            (init as RequestInit & {duplex?:string}).duplex = "half";
          }
          const result = await handler.fetch(new Request(url,init),env);
          const pathname = new globalThis.URL(url).pathname;
          if (pathname.startsWith("/api/")) {
            apiCalls.push({path:pathname,method:request.method,status:result.status});
            if (pathname === "/api/weight/trend" && result.ok) refreshCount++;
          }
          // Synthetic ambiguous outcome: D1 committed, but the browser receives
          // an error. Client must re-read and reuse the same UUID on retry.
          if (failResponseAfterWeightCommit && pathname === "/api/manual/weight"
              && request.method === "POST" && result.ok) {
            failResponseAfterWeightCommit = false;
            response.writeHead(503,{"Content-Type":"application/json"});
            response.end(JSON.stringify({error:"SYNTHETIC_UNKNOWN_COMMIT"}));
            return;
          }
          response.writeHead(result.status,Object.fromEntries(result.headers.entries()));
          response.end(new Uint8Array(await result.arrayBuffer()));
        } catch (error) {
          browserErrors.push(String(error));
          response.writeHead(500,{"Content-Type":"text/plain"});
          response.end("Local browser harness failure");
        }
      });
      await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
      const chromePath=["/usr/bin/google-chrome","/usr/bin/google-chrome-stable",
        "/usr/bin/chromium","/usr/bin/chromium-browser"].find((p:string)=>fs.existsSync(p));
      if (!chromePath) throw new Error("Chromium unavailable in CI");
      chrome=child.spawn(chromePath,["--headless=new","--no-sandbox","--disable-gpu",
        "--disable-dev-shm-usage","--remote-debugging-port=0",
        "--user-data-dir="+profile,"about:blank"],{stdio:"ignore"});
      let info="";
      for(let i=0;i<120;i++){
        const active=path.join(profile,"DevToolsActivePort");
        if(fs.existsSync(active)){info=fs.readFileSync(active,"utf8");break;}
        await pause(100);
      }
      if(!info)throw Error("Chromium DevTools never started");
      const debugPort=Number(info.split("\n")[0]);
      const tabs=await (await fetch("http://127.0.0.1:"+debugPort+"/json/list")).json() as any[];
      ws=new WebSocket(tabs.find(t=>t.type==="page").webSocketDebuggerUrl);
      await new Promise<void>((resolve,reject)=>{
        ws!.addEventListener("open",()=>resolve(),{once:true});
        ws!.addEventListener("error",()=>reject(Error("CDP connection failed")),{once:true});
      });
      let nextId=0;
      const waits=new Map<number,(x:any)=>void>();
      ws.addEventListener("message",(m:any)=>{
        const answer=JSON.parse(String(m.data));
        if(typeof answer.id==="number"&&waits.has(answer.id)){
          waits.get(answer.id)!(answer);waits.delete(answer.id);
        }
      });
      async function cdp(method:string,params:any={}) {
        const id=++nextId;
        const result=new Promise<any>(resolve=>waits.set(id,resolve));
        ws!.send(JSON.stringify({id,method,params}));
        const answer=await result;
        if(answer.error)throw Error(method+": "+JSON.stringify(answer.error));
        return answer.result;
      }
      async function evaluate(expression:string) {
        const response=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
        if(response.exceptionDetails)throw Error("Browser JS: "+response.exceptionDetails.text);
        return response.result?.value;
      }
      async function until(expression:string,label:string) {
        for(let i=0;i<110;i++) {
          if(await evaluate(expression))return;
          await pause(100);
        }
        const state=await evaluate('({content:document.querySelector(".manual-entry")?.innerText.slice(0,650),'
          +'forms:[...document.querySelectorAll(".manual-entry form")].map(x=>x.innerText),'
          +'buttons:[...document.querySelectorAll(".manual-entry button")].map(x=>({t:x.textContent,d:x.disabled})),'
          +'errs:window.__browserErrors})');
        throw Error("Browser timeout "+label+" "+JSON.stringify(state));
      }
      async function setInput(selector:string,value:string) {
        const expression='(()=>{const el=document.querySelector('+JSON.stringify(selector)
          +');if(!el)return "MISSING";'
          +'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'
          +JSON.stringify(value)+');'
          +'el.dispatchEvent(new Event("input",{bubbles:true}));'
          +'el.dispatchEvent(new Event("change",{bubbles:true}));'
          +'return el.value})()';
        expect(await evaluate(expression)).toBe(value);
      }
      async function click(label:string,root=".manual-entry") {
        const expression='(()=>{const buttons=[...document.querySelectorAll('
          +JSON.stringify(root+" button")+')];'
          +'const el=buttons.find(b=>b.textContent.trim()==='+JSON.stringify(label)+');'
          +'if(!el||el.disabled)return false;el.click();return true})()';
        expect(await evaluate(expression)).toBe(true);
      }
      async function clickFromRow(sectionIndex:number,rowIndex:number,label:string) {
        const expr='(()=>{const rows=document.querySelectorAll(".manual-history > div:nth-child('
          +(sectionIndex+1)+') li");'
          +'const row=rows['+rowIndex+'];'
          +'const button=[...row.querySelectorAll("button")].find(x=>x.textContent.trim()=='
          +JSON.stringify(label)+');if(!button||button.disabled)return false;button.click();return true})()';
        expect(await evaluate(expr)).toBe(true);
      }
      async function numberOf(table:string) {
        return (await db.prepare("SELECT COUNT(*) AS n FROM "+table)
          .first<{n:number}>())?.n ?? 0;
      }

      async function toTab(tab:"home"|"record"){
        const label=tab==="home"?"ホーム":"記録";
        const clicked=await evaluate('(()=>{const b=[...document.querySelectorAll(".app-nav-mobile button")]'
          +'.find(x=>x.textContent.trim()==='+JSON.stringify(label)+');'
          +'if(!b)return false;b.click();return true})()');
        expect(clicked).toBe(true);
        await until('location.hash==='+JSON.stringify("#"+tab),"tab navigation "+tab);
        if(tab==="record"){
          await until('!!document.querySelector(".manual-entry")'
            +'&&!document.querySelector(".manual-records [role=status]")',"manual entry loaded");
          expect(await evaluate('(()=>{document.querySelector(".manual-records").open=true;return true})()')).toBe(true);
        }else{
          await until('!!document.querySelector(".trend-table-scroll tbody")'
            +'&&!!document.querySelector("#overview-weight")',"home trend loaded");
        }
      }
      await cdp("Page.enable");await cdp("Runtime.enable");
      await cdp("Emulation.setDeviceMetricsOverride",{
        width:390,height:844,deviceScaleFactor:1,mobile:true,
      });
      await cdp("Page.navigate",{url:"http://127.0.0.1:"+server.address().port+"/#record"});
      await until('!!document.querySelector(".manual-entry")'
        +'&&!document.querySelector(".manual-records [role=status]")',"record tab and manual history load");
      expect(await evaluate('(()=>{document.querySelector(".manual-records").open=true;return true})()')).toBe(true);
      expect(await evaluate("window.__reactVersion")).toBe("19.3.1");
      expect(await evaluate("window.innerWidth")).toBe(390);
      expect(await evaluate("document.documentElement.scrollWidth")).toBeLessThanOrEqual(390);

      // Native React19-controlled form events: rejection does not create an optimistic success.
      await setInput('.manual-entry input[type="datetime-local"]',time);
      await setInput('.manual-entry form:first-of-type input[type="number"]',"75.1");
      await until('[...document.querySelectorAll(".manual-entry button")]'
        +'.some(b=>b.textContent.trim()==="体重を記録"&&!b.disabled)',"weight form enabled");
      localWrites=false;
      await click("体重を記録");
      await until('document.querySelector(".manual-entry [role=status]")?.textContent.includes("ローカル開発環境")',
        "safe 403 visible in form");
      expect(await numberOf("body_measurements")).toBe(0);
      expect(await evaluate('document.querySelector(".manual-entry [role=status]")?.textContent.includes("記録しました")')).toBe(false);
      localWrites=true;

      // Successful weight submission refreshes BOTH manual history, summary and chart.
      const beforeTrend=refreshCount;
      await click("体重を記録");
      await until('[...document.querySelectorAll(".manual-history > div:first-child li")]'
        +'.some(x=>x.textContent.includes("75.1"))',"weight saved to history");
      await toTab("home");
      await until('document.querySelector(".trend-table-scroll tbody")?.textContent.includes("75.1")',
        "weight visible in home trend");
      await until('document.querySelector("#overview-weight")?.parentElement?.textContent.includes("75.1")',
        "home weight metric refreshed");
      await toTab("record");
      expect(refreshCount).toBeGreaterThan(beforeTrend);
      expect(await numberOf("body_measurements")).toBe(1);

      // Update existing manual weight and confirm the read-only chart changed.
      await clickFromRow(0,0,"編集");
      await until('!![...document.querySelectorAll(".manual-entry button")]'
        +'.find(b=>b.textContent.trim()==="体重を訂正")',"weight edit mode");
      await setInput('.manual-entry form:first-of-type input[type="number"]',"75.6");
      await click("体重を訂正");
      await until('[...document.querySelectorAll(".manual-history > div:first-child li")]'
        +'.some(x=>x.textContent.includes("75.6"))',"edited weight history");
      await toTab("home");
      await until('document.querySelector(".trend-table-scroll tbody")?.textContent.includes("75.6")',
        "edited weight visible in chart");
      await toTab("record");
      expect(await numberOf("body_measurements")).toBe(1);

      // Steps: save, correct, and preserve a deliberate zero (not missing).
      await setInput('.manual-entry input[type="date"]',day);
      await setInput('.manual-entry form:nth-of-type(2) input[type="number"]',"0");
      await click("歩数を記録");
      await until('[...document.querySelectorAll(".manual-history > div:nth-child(2) li")]'
        +'.some(x=>x.textContent.includes("0歩"))',"zero steps saved");
      expect(await numberOf("activity_daily")).toBe(1);
      await clickFromRow(1,0,"編集");
      await until('!![...document.querySelectorAll(".manual-entry button")]'
        +'.find(b=>b.textContent.trim()==="歩数を訂正")',"steps edit mode");
      await setInput('.manual-entry form:nth-of-type(2) input[type="number"]',"1234");
      await click("歩数を訂正");
      await until('[...document.querySelectorAll(".manual-history > div:nth-child(2) li")]'
        +'.some(x=>x.textContent.includes("1,234歩"))',"edited steps saved");
      expect(await numberOf("activity_daily")).toBe(1);

      // Declining the browser confirmation must not delete anything.
      expect(await evaluate("(()=>{window.confirm=()=>false;return true})()")).toBe(true);
      await clickFromRow(1,0,"取消");
      await pause(150);
      expect(await numberOf("activity_daily")).toBe(1);
      expect(await evaluate("(()=>{window.confirm=()=>true;return true})()")).toBe(true);
      await clickFromRow(1,0,"取消");
      await until('[...document.querySelectorAll(".manual-history > div:nth-child(2) li")].length===0',
        "steps cancellation");
      expect(await numberOf("activity_daily")).toBe(0);

      // Conflict from CSV provenance must be surfaced and must not corrupt that source.
      await db.prepare("INSERT INTO activity_daily "
        +"(id,owner_id,local_day,steps,source_id,source_row_key) VALUES (?,?,?,?,?,?)")
        .bind("csv-only","owner",day,2500,"csv:fit","synthetic:fit:1").run();
      await setInput('.manual-entry input[type="date"]',day);
      await setInput('.manual-entry form:nth-of-type(2) input[type="number"]',"3000");
      await click("歩数を記録");
      await until('document.querySelector(".manual-entry [role=status]")?.textContent.includes("上書きしません")',
        "CSV source conflict visible");
      expect((await db.prepare("SELECT steps FROM activity_daily WHERE id=?")
        .bind("csv-only").first<{steps:number}>())?.steps).toBe(2500);
      expect(await numberOf("activity_daily")).toBe(1);

      // Weight deletion restores missing data in chart, including summary.
      await clickFromRow(0,0,"取消");
      await until('[...document.querySelectorAll(".manual-history > div:first-child li")].length===0',
        "weight cancelled");
      await toTab("home");
      await until('document.querySelector("#overview-weight")?.parentElement?.textContent.includes("測定記録なし")',
        "home missing weight after cancellation");
      await toTab("record");
      expect(await numberOf("body_measurements")).toBe(0);

      // A failed response AFTER D1 committed is ambiguous, not a license to
      // re-create the weight with a new ID or falsely report success.
      await setInput('.manual-entry input[type="datetime-local"]',time);
      await setInput('.manual-entry form:first-of-type input[type="number"]',"74.4");
      failResponseAfterWeightCommit = true;
      await click("体重を記録");
      await until('[...document.querySelectorAll(".manual-history > div:first-child li")]'
        +'.some(x=>x.textContent.includes("74.4"))',"readback after ambiguous write");
      await until('document.querySelector(".manual-entry [role=status]")?.textContent.includes("登録できませんでした")',
        "unknown response never advertised as success");
      expect(await numberOf("body_measurements")).toBe(1);
      await until('[...document.querySelectorAll(".manual-entry button")]'
        +'.some(b=>b.textContent.trim()==="体重を記録"&&!b.disabled)',
        "same-key retry enabled");
      await click("体重を記録");
      await until('document.querySelector(".manual-entry [role=status]")?.textContent.includes("体重を記録しました")',
        "idempotent retry success");
      expect(await numberOf("body_measurements")).toBe(1);
      await until('[...document.querySelectorAll(".manual-history > div:first-child li")]'
        +'.some(x=>x.textContent.includes("74.4"))',"record after retry");
      await clickFromRow(0,0,"取消");
      await until('[...document.querySelectorAll(".manual-history > div:first-child li")].length===0',
        "ambiguous-write test cleanup");
      expect(await numberOf("body_measurements")).toBe(0);
      expect(await evaluate("window.__browserErrors.length")).toBe(0);
      expect(browserErrors).toHaveLength(0);
      expect(apiCalls.filter(a=>a.path==="/api/manual/weight"&&a.status===200).length).toBeGreaterThanOrEqual(3);
      expect(apiCalls.some(a=>a.path==="/api/manual/weight"&&a.status===403)).toBe(true);
      expect(apiCalls.some(a=>a.path==="/api/manual/steps"&&a.status===409)).toBe(true);
      const report={react:"19.3.1",width:390,source:"full App / Worker / signed synthetic JWT / ephemeral local D1",
        weight:"create/edit/cancel/403",steps:"zero/create/edit/cancel/decline/csv409",
        chartRefresh:true,summaryRefresh:true,ambiguousResponseReadbackAndUuidRetry:true,
        noDocumentHorizontalOverflow:true,jsErrors:0,
        requestStatuses:[...new Set(apiCalls.map(x=>x.status))],remoteResources:false};
      console.log("MANUAL_ENTRY_REACT19_CHROMIUM_390_E2E",JSON.stringify(report));
    } finally {
      try{ws?.close();}catch{}
      try{chrome?.kill();}catch{}
      if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
      await pause(250);
      try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
    }
  },180_000);


  it("requires exact trusted UAT origin, explicit remote flag, CSRF header and signed owner",async()=>{
    const origin="https://life-log-uat.example.test";
    const cfg={enabled:"true",target:"uat",origin};
    const make=(options: {origin?:string|null;site?:string|null;host?:string;
      headers?:Record<string,string>;token?:string|null}={})=>
      req("/api/manual/weight","POST",WEIGHT,AUTH.OWNER_EMAIL,{
        host:origin,headers:{"X-Life-Log-Intent":"manual-write-v1"},...options,
      });
    expect(isSafeRemoteManual(await make(),cfg)).toBe(true);
    const misconfigured=[
      {enabled:undefined,target:"uat",origin},
      {enabled:"TRUE",target:"uat",origin},
      {enabled:"true",target:undefined,origin},
      {enabled:"true",target:"production",origin},
      {enabled:"true",target:"uat",origin:undefined},
      {enabled:"true",target:"uat",origin:"http://life-log-uat.example.test"},
      {enabled:"true",target:"uat",origin:"https://life-log-uat.example.test/path"},
      {enabled:"true",target:"uat",origin:"https://localhost"},
      {enabled:"true",target:"uat",origin:origin+"/"},
    ];
    for(const c of misconfigured){
      const e=env(undefined);
      e.result.MANUAL_REMOTE_WRITE_ENABLED=c.enabled;
      e.result.MANUAL_REMOTE_TARGET=c.target;
      e.result.MANUAL_REMOTE_ORIGIN=c.origin;
      const response=await worker().fetch(await make(),e.result);
      expect(response.status).toBe(403);
      expect(e.prepare).not.toHaveBeenCalled();
    }
    const bad: {origin?:string|null;site?:string|null;host?:string;headers?:Record<string,string>}[] = [
      {origin:null},{origin:"null"},{origin:"https://evil.example.test"},
      {site:null},{site:"cross-site"},{site:"same-site"},{site:"none"},
      {host:"https://evil.example.test"},
      {headers:{"X-Life-Log-Intent":""}},
      {headers:{"X-Life-Log-Intent":"wrong"}},
      {headers:{"Content-Type":"text/plain"}},
    ];
    for(const option of bad){
      const e=env(undefined);
      Object.assign(e.result,{MANUAL_REMOTE_WRITE_ENABLED:"true",MANUAL_REMOTE_TARGET:"uat",
        MANUAL_REMOTE_ORIGIN:origin});
      const res=await worker().fetch(await make(option),e.result);
      expect(res.status).toBe(403);
      expect(e.prepare).not.toHaveBeenCalled();
    }
    expect(await rows("body_measurements")).toBe(0);
    const denied=env(undefined);
    Object.assign(denied.result,{MANUAL_REMOTE_WRITE_ENABLED:"true",MANUAL_REMOTE_TARGET:"uat",
      MANUAL_REMOTE_ORIGIN:origin});
    const foreign=await worker().fetch(await make({token:await sign("other@example.invalid")}),denied.result);
    expect(foreign.status).toBe(403);
    expect(denied.prepare).not.toHaveBeenCalled();
    const e=env(undefined);
    Object.assign(e.result,{MANUAL_REMOTE_WRITE_ENABLED:"true",MANUAL_REMOTE_TARGET:"uat",
      MANUAL_REMOTE_ORIGIN:origin});
    const ok=await worker().fetch(await make(),e.result);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toContain("no-store");
    expect(await rows("body_measurements")).toBe(1);
    // A remote write setting cannot turn on the independent CSV confirmation gate.
    const blocked=await worker().fetch(await req("/api/import/confirm","POST",
      {source:"lifestyle",csv:"",confirmed:true},AUTH.OWNER_EMAIL,{
        host:origin,headers:{"X-Life-Log-Intent":"manual-write-v1"},
      }),e.result);
    expect(blocked.status).toBe(403);
  },100_000);

  it("detects stale weight and step edits/cancels atomically instead of overwriting",async()=>{
    expect((await send("/api/manual/weight","POST",WEIGHT)).status).toBe(200);
    const old={expectedMeasuredAt:WEIGHT.measuredAt,expectedWeightKg:WEIGHT.weightKg};
    expect((await send("/api/manual/weight","PATCH",{...WEIGHT,...old,
      weightKg:75.6})).status).toBe(200);
    expect((await send("/api/manual/weight","PATCH",{...WEIGHT,...old,
      weightKg:74.3})).status).toBe(409);
    expect((await send("/api/manual/weight","DELETE",{key:KEY,...old})).status).toBe(409);
    const current=await db.prepare("SELECT weight_kg AS kg FROM body_measurements "
      +"WHERE owner_id=? AND source_id=? AND source_row_key=?")
      .bind("owner","manual:weight",KEY).first<{kg:number}>();
    expect(current?.kg).toBe(75.6);
    expect((await send("/api/manual/weight","DELETE",{key:KEY,
      expectedMeasuredAt:WEIGHT.measuredAt,expectedWeightKg:75.6})).status).toBe(200);
    expect((await send("/api/manual/steps","POST",{day:"2026-11-01",steps:0})).status).toBe(200);
    expect((await send("/api/manual/steps","PUT",{day:"2026-11-01",
      expectedSteps:0,steps:1500})).status).toBe(200);
    // Stale request must fail even if the new value happens to equal current.
    expect((await send("/api/manual/steps","PUT",{day:"2026-11-01",
      expectedSteps:0,steps:1500})).status).toBe(409);
    expect((await send("/api/manual/steps","DELETE",{day:"2026-11-01",
      expectedSteps:0})).status).toBe(409);
    expect((await send("/api/manual/steps","DELETE",{day:"2026-11-01",
      expectedSteps:1500})).status).toBe(200);
  },100_000);

  it("rejects malformed manual-history ranges before any DB access",async()=>{
    const e=env(undefined);
    const response=await worker().fetch(await req("/api/manual/records?to=invalid-date","GET"),e.result);
    expect(response.status).toBe(400);
    expect(e.prepare).not.toHaveBeenCalled();
  });

  it("renders required 390px-entry inputs with explicit datetime and no optimistic success", () => {
    const html=renderToStaticMarkup(createElement(ManualEntry,{onSaved:()=>{}}));
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('type="number"');
    expect(html).toContain("体重を記録");
    expect(html).toContain("歩数を記録");
    expect(html).toContain("CSVの数値がある日はCSVを優先表示");
    expect(html).toContain("手入力の履歴・訂正・取消");
    expect(html).toContain("時刻不明の体重は登録せず");
  });
});
