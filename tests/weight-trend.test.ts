import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PeriodPlot, TrendPlot, WeightTrendPanel } from "../src/client/WeightTrend";
import {
  addSevenDayAverage, buildWeightTrend, dateRange, defaultRange, groupTrendDays, moveGranularityRange, parseTrendRange, rangeFitsGranularity, rangeForGranularity,
  type Measurement,
} from "../src/shared/weight-trend";
const row = (day: string, kg: number | null, id = day, extras: Partial<Measurement> = {}): Measurement => ({
  id, measured_at: day + "T08:00:00+09:00", weight_kg: kg,
  source_kind: "measured", anomaly_flag: 0, ...extras,
});
describe("Issue #25: JST daily trend and calendar seven-day average", () => {
  it("rejects invalid dates, excess ranges and ambiguous query parameters", () => {
    expect(dateRange("2026-02-30", "2026-03-02")).toBeNull();
    expect(dateRange("2026-01-03", "2026-01-02")).toBeNull();
    expect(dateRange("2025-01-01", "2026-12-31")).toBeNull();
    expect(dateRange("2026-01-01", "2026-01-01")?.days).toBe(1);
    expect(parseTrendRange(new URL("https://x.invalid/?from=2026-01-01"))).toBeNull();
    expect(parseTrendRange(new URL("https://x.invalid/?from=2026-01-01&to=2026-01-02&to=2026-01-03"))).toBeNull();
    expect(parseTrendRange(new URL("https://x.invalid/?from=2026-01-01&to=2026-01-02&owner=other"))).toBeNull();
    expect(defaultRange(Date.parse("2026-11-05T15:01:00Z")).to).toBe("2026-11-06");
  });
  it("chooses latest actual JST observation, stable ID tie-break, never fabricates missing days", () => {
    const trend = buildWeightTrend([
      row("2026-01-01", 73, "a"),
      row("2026-01-01", 74, "z"),
      row("2026-01-01", 99, "ignored", { source_kind: "reported" }),
      row("2026-01-01", 999, "bad", { anomaly_flag: 1 }),
      row("2026-01-02", 72, "night", { measured_at: "2026-01-01T16:00:00Z" }),
      row("2026-01-02", 77, "wrongday", { measured_at: "2026-01-01T14:59:59Z" }),
    ], "2026-01-01", "2026-01-03");
    expect(trend.days.map(d => d.weightKg)).toEqual([77, 72, null]);
    expect(trend.measuredDays).toBe(2);
    expect(trend.missingDays).toBe(1);
    expect(trend.excludedAnomaly).toBe(1);
    expect(trend.excludedNonMeasured).toBe(1);
    expect(trend.days[0].source).toBe("実測");
    expect(trend.days[2].measuredAt).toBeNull();
  });
  it("prioritizes ECLEAR over later manual and legacy measurements, without auto-filling missing ECLEAR days", () => {
    const trend=buildWeightTrend([
      row("2026-04-01", 83, "legacy", {source_id:"csv:lifestyle"}),
      row("2026-04-01", 74, "eclear", {source_id:"csv:eclear",
        measured_at:"2026-04-01T07:00:00+09:00"}),
      row("2026-04-01", 90, "manual", {source_id:"manual:weight",
        measured_at:"2026-04-01T23:00:00+09:00"}),
      row("2026-04-02", 81, "legacy-only", {source_id:"legacy:txt"}),
      row("2026-04-03", 75, "manual-only", {source_id:"manual:weight"}),
    ],"2026-04-01","2026-04-03");
    expect(trend.days.map(x=>x.weightKg)).toEqual([74,null,75]);
    expect(trend.days.map(x=>x.source)).toEqual(["ECLEAR",null,"手入力"]);
    expect(trend.measuredDays).toBe(2);
    expect(trend.missingDays).toBe(1);
  });
  it("recognizes date-only historical report, never inventing a time or superseding ECLEAR",()=>{
    const trend=buildWeightTrend([
      row("2026-04-01",88,"hist-overlap",{
        measured_at:"2026-04-01",source_kind:"reported",source_id:"csv:weight_day"}),
      row("2026-04-01",73,"eclear",{
        measured_at:"2026-04-01T07:00:00+09:00",source_id:"csv:eclear"}),
      row("2026-04-02",74,"hist-only",{
        measured_at:"2026-04-02",source_kind:"reported",source_id:"csv:weight_day"}),
      row("2026-04-03",75,"other-report",{
        measured_at:"2026-04-03",source_kind:"reported",source_id:"csv:lifestyle"}),
    ],"2026-04-01","2026-04-03");
    expect(trend.days.map(x=>x.weightKg)).toEqual([73,74,null]);
    expect(trend.days.map(x=>x.source)).toEqual(["ECLEAR","過去記録",null]);
    expect(trend.days[1].measuredAt).toBe("2026-04-02");
    expect(trend.excludedNonMeasured).toBe(0);
  });

  it("uses calendar days and six-day prefetch; 1-3 observations are insufficient", () => {
    const pre = [row("2026-01-01", 70),row("2026-01-02", 71),row("2026-01-03", 72)];
    const requested = [row("2026-01-04", 73),row("2026-01-06", 75)];
    const trend = addSevenDayAverage(buildWeightTrend(requested,"2026-01-04","2026-01-09"),pre);
    expect(trend.days[0].measuredDaysInWindow).toBe(4);
    expect(trend.days[0].average7Kg).toBe(71.5);
    expect(trend.days[2].measuredDaysInWindow).toBe(5);
    expect(trend.days[2].average7Kg).toBe(72.2);
    expect(trend.days[5].measuredDaysInWindow).toBe(3);
    expect(trend.days[5].average7Kg).toBeNull();
    expect(trend.days[1].weightKg).toBeNull();
    const few = addSevenDayAverage(buildWeightTrend(pre,"2026-01-01","2026-01-03"));
    expect(few.days.every(d=>d.average7Kg===null)).toBe(true);
  });
  it("renders isolated 7-day average points and keyboard-scrollable chart at 390px CSS contract", async () => {
    const observations = [
      row("2026-01-01", 70), row("2026-01-02", 71),
      row("2026-01-03", 72), row("2026-01-04", 73),
    ];
    const days = addSevenDayAverage(buildWeightTrend(observations, "2026-01-01", "2026-01-04")).days;
    expect(days.filter(d => d.average7Kg !== null)).toHaveLength(1);
    const html = renderToStaticMarkup(createElement(TrendPlot, { days, goalLow: 75, goalHigh: 76 }));
    expect(html).toContain('role="region"');
    expect(html).toContain('class="trend-viewport"');
    expect(html).toContain('class="trend-fixed-axis"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/tabindex="0"/i);
    expect(html).toContain('role="img"');
    expect((html.match(/class="average-point"/g) ?? [])).toHaveLength(1);
    expect(html).toContain("左右にスクロール");
    // Under a 390px viewport, the parent panel has approximately 312px of
    // inner width; the 680px SVG therefore scrolls instead of shrinking
    // its axis font below an accessible reading size.
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>("node:fs");
    const styles = readFileSync("src/client/styles.css", "utf8");
    expect(styles).toMatch(/\.trend-scroll,\.trend-table-scroll\{overflow-x:auto;max-width:100%\}/);
    expect(styles).toMatch(/\.trend-scroll svg\{[^}]*min-width:680px;/);
  });

  it("renders the 30-day daily plot with retained 7-day average and axis spacing", () => {
    const trend = buildWeightTrend(
      [row("2026-11-06", 78.3)], "2026-10-08", "2026-11-06",
    );
    expect(trend.days).toHaveLength(30);
    const markup = renderToStaticMarkup(createElement(TrendPlot, {
      days: trend.days, goalLow: 75, goalHigh: 76,
    }));
    expect(markup).toContain('viewBox="0 0 720 230"');
    expect(markup).toMatch(/min-width:\s*680px/);
    expect(markup).toContain("11/06");
  });


  it("switches to 30 days, 12 Monday-based weeks and 12 months, including a year boundary", () => {
    const now = Date.parse("2026-11-05T15:01:00Z"); // Nov 6 in Japan
    const monthRange = rangeForGranularity("month", now);
    expect(monthRange).toEqual({ from: "2025-12-01", to: "2026-11-06" });
    expect(dateRange(monthRange.from,monthRange.to)?.days).toBeLessThanOrEqual(366);
    const weekly = rangeForGranularity("week",now);
    expect(weekly.to).toBe("2026-11-06");
    expect(weekly.from).toBe("2026-08-17"); // Monday, 12 calendar weeks
    expect(rangeForGranularity("day", now)).toEqual(defaultRange(now));
  });

  it("bounds custom date inputs to 30 days, 12 Monday weeks or 12 months and rejects future dates", () => {
    const now = Date.parse("2026-11-05T15:01:00Z");
    expect(rangeFitsGranularity("day", "2026-10-08", "2026-11-06",now)).toBe(true);
    expect(rangeFitsGranularity("day", "2026-10-07", "2026-11-06",now)).toBe(false);
    expect(rangeFitsGranularity("week", "2026-08-17", "2026-11-06",now)).toBe(true);
    expect(rangeFitsGranularity("week", "2026-08-16", "2026-11-06",now)).toBe(false);
    expect(rangeFitsGranularity("month", "2025-12-01", "2026-11-06",now)).toBe(true);
    expect(rangeFitsGranularity("month", "2025-11-30", "2026-11-06",now)).toBe(false);
    expect(rangeFitsGranularity("month", "2025-12-01", "2026-11-07",now)).toBe(false);
    expect(rangeFitsGranularity("day", "2026-11-07", "2026-11-07",now)).toBe(false);
    expect(rangeFitsGranularity("month", "2023-03-01","2024-02-29",
      Date.parse("2024-02-29T12:00:00Z"))).toBe(true);
  });

  it("navigates 30-day, 12-week and 12-month windows across year boundaries, never beyond JST today", () => {
    const now = Date.parse("2026-11-05T15:01:00Z");
    const cases = [
      {scale:"day" as const, current:{from:"2026-10-08",to:"2026-11-06"},
        previous:{from:"2026-09-08",to:"2026-10-07"}},
      {scale:"week" as const, current:{from:"2026-08-17",to:"2026-11-06"},
        previous:{from:"2026-05-25",to:"2026-08-16"}},
      {scale:"month" as const, current:{from:"2025-12-01",to:"2026-11-06"},
        previous:{from:"2024-12-01",to:"2025-11-30"}},
    ];
    for (const {scale,current,previous} of cases) {
      expect(moveGranularityRange(scale,current,-1,now)).toEqual(previous);
      expect(moveGranularityRange(scale,previous,1,now)).toEqual(current);
      expect(moveGranularityRange(scale,current,1,now)).toBeNull();
      expect(rangeFitsGranularity(scale,previous.from,previous.to,now)).toBe(true);
    }
    const prior={from:"2026-11-01",to:"2026-11-05"};
    expect(moveGranularityRange("day",prior,-1,now)).toEqual({from:"2026-10-27",to:"2026-10-31"});
    expect(moveGranularityRange("day",{from:"2026-10-27",to:"2026-10-31"},1,now)).toEqual(prior);
  });

  it("groups monthly by calendar month, averaging one daily representative and retaining missing months", () => {
    const range = {from:"2025-12-01",to:"2026-11-06"};
    const rows = [
      row("2025-12-30",70,"first"),
      row("2025-12-30",100,"second"), // same-day representative is latest stable ID
      row("2026-01-01",74),row("2026-01-03",78),
      row("2026-11-06",80),
    ];
    const periods = groupTrendDays(buildWeightTrend(rows,range.from,range.to).days,"month");
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({
      key:"2025-12",meanKg:100,observedDays:1,calendarDays:31,
    });
    expect(periods[1]).toMatchObject({
      key:"2026-01",meanKg:76,observedDays:2,calendarDays:31,
    });
    expect(periods[2]).toMatchObject({
      key:"2026-02",meanKg:null,observedDays:0,calendarDays:28,
    });
    expect(periods[11]).toMatchObject({
      key:"2026-11",meanKg:80,observedDays:1,calendarDays:6,
    });
    const html=renderToStaticMarkup(createElement(PeriodPlot,{
      periods,granularity:"month",goalLow:75,goalHigh:76,
    }));
    expect(html).toContain('viewBox="0 0 360 230"');
    expect(html).toContain('class="trend-month-fit"');
    expect(html).toContain("12か月");
    expect(html).toContain("2025/12");
    expect(html).toContain("2026/11");
    expect((html.match(/<circle/g)??[])).toHaveLength(3);
  });

  it("uses Monday-start calendar weeks and does not connect missing weeks", () => {
    const trend = buildWeightTrend([
      row("2025-12-31",72),row("2026-01-01",74),row("2026-01-10",77),
    ],"2025-12-29","2026-01-18");
    const weekly=groupTrendDays(trend.days,"week");
    expect(weekly.map(p=>p.key)).toEqual(["2025-12-29","2026-01-05","2026-01-12"]);
    expect(weekly.map(p=>p.meanKg)).toEqual([73,77,null]);
    expect(weekly.map(p=>p.observedDays)).toEqual([2,1,0]);
    const html=renderToStaticMarkup(createElement(PeriodPlot,{
      periods:weekly,granularity:"week",goalLow:75,goalHigh:76,
    }));
    expect(html).toContain("週ごとの平均体重");
    expect(html).toContain('tabindex="0"');
  });

  it("renders all three viewing controls and monthly non-scroll CSS on narrow devices", async () => {
    const html=renderToStaticMarkup(createElement(WeightTrendPanel));
    expect(html).toContain('aria-label="グラフの表示単位"');
    expect(html).toContain('aria-pressed="true"');
    for(const label of [">日</button>",">週</button>",">月</button>"]) expect(html).toContain(label);
    const { readFileSync }=await vi.importActual<{readFileSync(path:string,enc:string):string}>("node:fs");
    const css=readFileSync("src/client/styles.css","utf8");
    // Issue #25: target date is editable alongside the goal range, UI-only.
    expect(html).toContain('aria-label="目標日"');
    expect(html).toContain('value="2026-12-22"');
        expect(html).toContain("期間・目標の詳細設定");
    expect(html).toContain("変更は保存されません");
    expect(html).toContain('aria-label="表示期間の移動"');
    for (const label of ["前の期間","次の期間","最新へ"]) expect(html).toContain(label);
    expect(css).toContain(".trend-period-nav{display:grid;");
    expect(css).toContain(".trend-month-fit>svg{display:block;width:100%;max-width:100%;min-width:0;height:auto}");
    expect(css).toContain(".trend-period-table .trend-table{width:100%;min-width:0}");
  });

  it("returns full empty days and excludes null, anomaly and non-measured", () => {
    const t=buildWeightTrend([
      row("2026-02-01",null),row("2026-02-02",70,"anomaly",{anomaly_flag:1}),
      row("2026-02-03",71,"estimated",{source_kind:"estimated"}),
    ],"2026-02-01","2026-02-04");
    expect(t.days).toHaveLength(4);
    expect(t.measuredDays).toBe(0);
    expect(t.missingDays).toBe(4);
    expect(t.excludedAnomaly).toBe(2);
    expect(t.excludedNonMeasured).toBe(1);
  });
  it("runs the pinned React 19 component in real 390px Chromium with synthetic weight API", async () => {
    if ((globalThis as any).process?.env?.CI !== "true") return;
    const fs=await vi.importActual<any>("node:fs"), path=await vi.importActual<any>("node:path");
    const http=await vi.importActual<any>("node:http"), cp=await vi.importActual<any>("node:child_process");
    const vite=await vi.importActual<any>("vite");
    const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
    const work=fs.mkdtempSync(new URL("../.pr33-e2e-",import.meta.url).pathname);
    const profile=fs.mkdtempSync(path.join(work,"chrome-"));
    let server:any,chrome:any,ws:WebSocket|undefined;
    try {
      const entry=[
        'import React,{StrictMode} from "react";',
        'import {createRoot} from "react-dom/client";',
        'import {WeightTrendPanel} from "../src/client/WeightTrend";',
        'import {buildWeightTrend,addSevenDayAverage,jstDay,parseDay} from "../src/shared/weight-trend";',
        'import "../src/client/styles.css";',
        'const now=parseDay(jstDay(Date.now()));const rows=[];',
        'for(let i=0;i<370;i+=2){if(i>110&&i<170)continue;const d=new Date(now-i*86400000).toISOString().slice(0,10);rows.push({id:"test-"+i,measured_at:d+"T08:15:00+09:00",weight_kg:Math.round((77+Math.sin(i/20))*10)/10,source_kind:"measured",anomaly_flag:0});}',
        'window.__apiMode="normal";window.__apiCalls=0;window.__jsErrors=[];',
        'window.addEventListener("error",e=>window.__jsErrors.push(String(e.message)));',
        'window.addEventListener("unhandledrejection",e=>window.__jsErrors.push(String(e.reason)));',
        'window.fetch=async function(input){const u=new URL(typeof input==="string"?input:input.url,location.href);if(u.pathname!=="/api/weight/trend")return new Response("missing",{status:404});window.__apiCalls++;if(window.__apiMode==="error")return new Response("error",{status:503});const rec=window.__apiMode==="empty"?[]:rows;const x=addSevenDayAverage(buildWeightTrend(rec,u.searchParams.get("from"),u.searchParams.get("to")),rec);return new Response(JSON.stringify(x),{status:200,headers:{"Content-Type":"application/json"}});};',
        'createRoot(document.getElementById("root")).render(<StrictMode><WeightTrendPanel/></StrictMode>);',
        'const checks=[];const verify=(name,value)=>checks.push({name,pass:Boolean(value)});',
        'const pause=ms=>new Promise(r=>setTimeout(r,ms));',
        'async function until(fn){for(let i=0;i<60;i++){if(fn())return;await pause(100)}throw Error("waiting for UI");}',
        'function click(label,selector){const el=[...document.querySelectorAll(selector)].find(e=>e.textContent===label);if(!el)throw Error("button:"+label);el.click();}',
        'async function run(){try{await until(()=>document.querySelector(".trend-table-scroll tbody")?.children.length===30);',
        'verify("React19.3.1",React.version==="19.3.1");verify("390 viewport",innerWidth===390);',
        'verify("30 daily rows",document.querySelector(".trend-table-scroll tbody").children.length===30);verify("7-day mean plotted",document.querySelectorAll(".average-point").length>0);verify("daily keyboard region",document.querySelector(".trend-table-scroll").tabIndex===0);',
        'click("週",".trend-granularity button");await until(()=>document.querySelector(".trend-period-table tbody")?.children.length===12);',
        'verify("12 weekly rows",document.querySelector(".trend-period-table tbody").children.length===12);verify("weekly keyboard region",document.querySelector(".trend-scroll")?.tabIndex===0);',
        'click("月",".trend-granularity button");await until(()=>document.querySelector(".trend-month-fit svg")&&document.querySelector(".trend-period-table tbody")?.children.length===12);',
        'const box=document.querySelector(".trend-month-fit");verify("12 monthly rows",document.querySelector(".trend-period-table tbody").children.length===12);verify("monthly no overflow",document.documentElement.scrollWidth<=390&&box.scrollWidth===box.clientWidth);verify("monthly within viewport",box.getBoundingClientRect().width<=390);verify("missing month kept",[...document.querySelectorAll(".trend-period-table td")].some(n=>n.textContent==="欠測"));',
        'const start=document.querySelector(".trend-period-nav span").textContent;click("前の期間",".trend-period-nav button");await until(()=>document.querySelector(".trend-period-nav span").textContent!==start);verify("previous period",document.querySelector(".trend-period-nav span").textContent!==start);',
        'click("次の期間",".trend-period-nav button");await until(()=>document.querySelector(".trend-period-nav span").textContent===start);verify("next period",document.querySelector(".trend-period-nav span").textContent===start);',
        'click("前の期間",".trend-period-nav button");await until(()=>document.querySelector(".trend-period-nav span").textContent!==start);',
        'click("最新へ",".trend-period-nav button");await until(()=>document.querySelector(".trend-period-nav span").textContent===start);verify("latest reset",document.querySelector(".trend-period-nav button:last-child").disabled);',
        'const input=document.querySelectorAll("input[type=number]")[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"79");input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));await pause(150);verify("goal edit",document.querySelector(".trend-difference")?.textContent.includes("目標範囲内"));',
        'window.__apiMode="error";click("日",".trend-granularity button");await until(()=>document.querySelector("[role=alert]")?.textContent.includes("取得できません"));verify("503 error visible",true);',
        'window.__apiMode="empty";click("週",".trend-granularity button");await until(()=>document.body.textContent.includes("この期間には表示できる実測値がありません"));verify("empty data visible",true);',
        'verify("no JS errors",window.__jsErrors.length===0);',
        '}catch(e){checks.push({name:"unexpected failure",pass:false,details:String(e)})}window.__e2e={done:true,checks,react:React.version,width:innerWidth,calls:window.__apiCalls};}',
        'void run();',
      ].join("\n");
      fs.writeFileSync(path.join(work,"entry.tsx"),entry);
      fs.writeFileSync(path.join(work,"index.html"),'<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="container"><div id="root"></div></div><script type="module" src="/entry.tsx"></script></body></html>');
      await vite.build({configFile:false,root:work,logLevel:"error",build:{outDir:path.join(work,"dist"),emptyOutDir:true}});
      server=http.createServer((req:any,res:any)=>{
        const u=new URL(req.url,"http://127.0.0.1");const file=path.join(work,"dist",u.pathname==="/"?"index.html":u.pathname.slice(1));
        if(!file.startsWith(path.join(work,"dist"))||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
        res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(file));
      });
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const bin=["/usr/bin/google-chrome","/usr/bin/google-chrome-stable","/usr/bin/chromium","/usr/bin/chromium-browser"].find((n:string)=>fs.existsSync(n));
      if(!bin)throw Error("Chrome not found on CI runner");
      let info="";
      for(let attempt=0;attempt<2&&!info;attempt++){
        const launchProfile=attempt===0?profile:fs.mkdtempSync(path.join(work,"chrome-retry-"));
        chrome=cp.spawn(bin,["--headless=new","--no-sandbox","--disable-gpu",
          "--disable-dev-shm-usage","--disable-background-networking","--no-first-run",
          "--remote-debugging-port=0","--user-data-dir="+launchProfile,"about:blank"],{stdio:"ignore"});
        for(let i=0;i<120;i++){
          const current=path.join(launchProfile,"DevToolsActivePort");
          if(fs.existsSync(current)){info=fs.readFileSync(current,"utf8");break;}
          await sleep(100);
        }
        if(!info){chrome.kill("SIGKILL");await sleep(200);}
      }
      if(!info)throw Error("Chrome debugging port not available after fresh-profile retry");
      const port=Number(info.split("\n")[0]);const tabs=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json() as any[];
      ws=new WebSocket(tabs.find(x=>x.type==="page").webSocketDebuggerUrl);
      await new Promise<void>((resolve,reject)=>{ws!.addEventListener("open",()=>resolve(),{once:true});ws!.addEventListener("error",()=>reject(Error("Chrome websocket error")),{once:true});});
      let id=0;const pending=new Map<number,(v:any)=>void>();
      ws.addEventListener("message",e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){pending.get(m.id)!(m);pending.delete(m.id)}});
      async function call(method:string,params:any={}){const n=++id;const result=new Promise<any>(resolve=>pending.set(n,resolve));ws!.send(JSON.stringify({id:n,method,params}));const r=await result;if(r.error)throw Error(JSON.stringify(r.error));return r.result;}
      await call("Page.enable");await call("Runtime.enable");
      await call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
      await call("Page.navigate",{url:"http://127.0.0.1:"+server.address().port+"/"});
      let report:any;
      for(let i=0;i<130;i++){
        const r=await call("Runtime.evaluate",{expression:"window.__e2e",returnByValue:true});
        if(r.result?.value?.done){report=r.result.value;break;}
        await sleep(100);
      }
      if(!report)throw Error("React19 browser scenario timed out before reporting checks");
      console.log("REAL_REACT19_CHROMIUM_390",JSON.stringify(report));
      expect(report.react).toBe("19.3.1");expect(report.width).toBe(390);
      expect(report.calls).toBeGreaterThan(0);
      expect(report.checks.length).toBeGreaterThanOrEqual(13);
      expect(report.checks.filter((c:any)=>!c.pass)).toEqual([]);
    } finally {
      try{ws?.close();}catch{}
      try{chrome?.kill();}catch{}
      if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
      await sleep(250);try{fs.rmSync(work,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
    }
  },110_000);

});
