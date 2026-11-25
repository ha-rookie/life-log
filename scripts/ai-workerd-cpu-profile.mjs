#!/usr/bin/env node
/**
 * Issue #313: locally profile a standalone, fake-only Worker with Chrome
 * DevTools Protocol. Never deploy, connect remote bindings, use real Google,
 * load secrets, access user D1, or claim local CPU equals Cloudflare Free CPU.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HOST = "127.0.0.1", PORT = 8897, INSPECTOR = 9297;
const BASE = "http://" + HOST + ":" + PORT;
const PROFILE_COUNT = 5, REQUESTS_PER_PROFILE = 5;
function fail(message) { throw Error("AI_B4_LOCAL_PROFILE: " + message); }
function sampleCpu(profile) {
  if (!profile || !Array.isArray(profile.nodes) ||
      !Array.isArray(profile.samples) ||
      !Array.isArray(profile.timeDeltas) ||
      profile.samples.length !== profile.timeDeltas.length ||
      profile.samples.length === 0) fail("INVALID_INSPECTOR_PROFILE");
  const names = new Map(profile.nodes.map(n => [n.id, n.callFrame?.functionName ?? ""]));
  let activeUs = 0, activeSamples = 0, totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], delay = profile.timeDeltas[i];
    if (!Number.isFinite(delay) || delay < 0 || !names.has(id))
      fail("INVALID_PROFILE_SAMPLE");
    totalUs += delay;
    const name = names.get(id);
    if (!/^\((idle|root|program)\)$/u.test(name)) {
      activeUs += delay;
      activeSamples++;
    }
  }
  if (activeUs <= 0 || !Number.isFinite(activeUs))
    fail("NO_NONIDLE_CPU_SAMPLES");
  return {
    activeMs: activeUs / 1000,
    samples: profile.samples.length,
    activeSamples,
    sampledSpanMs: totalUs / 1000
  };
}
function quantile(input, q) {
  if (!input.length || input.some(v => !Number.isFinite(v) || v < 0))
    fail("INVALID_CPU_DISTRIBUTION");
  const sorted = [...input].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}
function selfTest() {
  const synthetic = sampleCpu({
    nodes: [
      {id: 1, callFrame: {functionName: "(idle)"}},
      {id: 2, callFrame: {functionName: "syntheticWork"}}
    ], samples: [2,1,2], timeDeltas: [1000, 3000, 2000]
  });
  if (synthetic.activeMs !== 3 || synthetic.activeSamples !== 2 ||
      synthetic.sampledSpanMs !== 6 ||
      quantile([3,2,5,1,4], 0.95) !== 5)
    fail("SELF_TEST_FAILED");
  console.log("AI_B4_CPU_PROFILE_PARSER_SELF_TEST_SUCCESS");
}
async function fetchLocal(path) {
  const response = await fetch(BASE + path, {signal: AbortSignal.timeout(7000)});
  if (!response.ok) fail("LOCAL_WORKER_REQUEST_FAILED_" + response.status);
  const value = await response.json();
  if (!value || typeof value !== "object" || "error" in value)
    fail("INVALID_LOCAL_WORKER_RESPONSE");
  return value;
}
async function findInspector() {
  for (const path of ["/json/list", "/json"]) {
    try {
      const response = await fetch("http://" + HOST + ":" + INSPECTOR + path,
        {signal: AbortSignal.timeout(1500)});
      if (!response.ok) continue;
      const entries = await response.json();
      if (!Array.isArray(entries)) continue;
      for (const target of entries) {
        if (typeof target.webSocketDebuggerUrl !== "string") continue;
        const url = new URL(target.webSocketDebuggerUrl);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
          fail("NONLOCAL_INSPECTOR_ENDPOINT");
        url.hostname = HOST;
        return url.href;
      }
    } catch { /* DevTools may still be initializing. */ }
  }
  return null;
}
async function waitUntilReady(child) {
  let ws = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) fail("LOCAL_WORKER_EXITED");
    try {
      const r = await fetchLocal("/warmup?days=30");
      if (r.ready) ws = await findInspector();
    } catch { /* Local Workerd is still starting. */ }
    if (ws) return ws;
    await sleep(200);
  }
  fail("LOCAL_WORKER_INSPECTOR_UNAVAILABLE");
}
async function connect(url) {
  if (typeof WebSocket !== "function") fail("NODE_WEBSOCKET_REQUIRED");
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("INSPECTOR_OPEN_TIMEOUT")), 5000);
    ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, {once:true});
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(Error("INSPECTOR_OPEN_FAILED")); }, {once:true});
  });
  const pending = new Map();
  let next = 0;
  ws.addEventListener("message", e => {
    let message;
    try { message = JSON.parse(e.data); } catch { return; }
    if (!Number.isInteger(message.id)) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timeout);
    if (message.error) item.reject(Error("INSPECTOR_COMMAND_REJECTED"));
    else item.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve,reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(Error("INSPECTOR_DISCONNECTED"));
    const id = ++next;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(Error("INSPECTOR_COMMAND_TIMEOUT"));
    }, 12000);
    pending.set(id, {resolve,reject,timeout});
    ws.send(JSON.stringify({id,method,params}));
  });
  return {call,close:()=>ws.close()};
}
async function profileDay(client, days) {
  const warmed = await fetchLocal("/warmup?days=" + days);
  if (warmed.ready !== true || warmed.days !== days) fail("WARMUP_MISMATCH");
  const cpu = [], wall = [], sampleCounts = [];
  let bytes = -1, subrequests = -1;
  for (let pass = 0; pass < PROFILE_COUNT; pass++) {
    await client.call("Profiler.start");
    const start = performance.now();
    let response;
    try {
      for (let i=0; i<REQUESTS_PER_PROFILE; i++) {
        response = await fetchLocal("/profile?days=" + days);
        if (response.outcome !== "sheet_copy_verified" ||
            response.days !== days ||
            response.cpuMeterEvidence !== "injected-synthetic-only")
          fail("SYNTHETIC_PIPELINE_NOT_VERIFIED");
      }
    } catch (error) {
      await client.call("Profiler.stop").catch(()=>{});
      throw error;
    }
    const elapsed = performance.now() - start;
    const completed = await client.call("Profiler.stop");
    const sampled = sampleCpu(completed?.profile);
    if (bytes < 0) {
      bytes = response.payloadBytes;
      subrequests = response.subrequests;
    } else if (bytes !== response.payloadBytes || subrequests !== response.subrequests)
      fail("NONDETERMINISTIC_SYNTHETIC_PAYLOAD");
    cpu.push(sampled.activeMs / REQUESTS_PER_PROFILE);
    wall.push(elapsed / REQUESTS_PER_PROFILE);
    sampleCounts.push(sampled.activeSamples);
  }
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 2_000_000 ||
      !Number.isInteger(subrequests) || subrequests <= 0 || subrequests > 50)
    fail("SYNTHETIC_RESOURCE_LIMIT_VIOLATION");
  return {
    days, payloadBytes:bytes, countedSubrequests:subrequests,
    profileMethod:"local-workerd-cdp-Profiler-active-sample-estimate",
    profiles:PROFILE_COUNT, invocationsPerProfile:REQUESTS_PER_PROFILE,
    activeSamples:sampleCounts,
    cpuEstimateMs:{p50:quantile(cpu,0.5),p95:quantile(cpu,0.95),max:Math.max(...cpu)},
    wallMs:{p50:quantile(wall,0.5),p95:quantile(wall,0.95),max:Math.max(...wall)},
    productionFreeCpuProof:false, realD1CpuIncluded:false, realGoogleCalls:false
  };
}
async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const temp = await mkdtemp(join(process.cwd(), ".ai-cpu-local-"));
  const config = join(temp,"wrangler.jsonc");
  const binary = join(process.cwd(),"node_modules",".bin",
    process.platform==="win32"?"wrangler.cmd":"wrangler");
  await writeFile(config,JSON.stringify({
    name:"life-log-ai-cpu-synthetic-only",
    main:"../tests/fixtures/ai-workerd-cpu-worker.ts",
    compatibility_date:"2026-11-04"
  },null,2));
  let child, inspector;
  let stderr = "";
  try {
    child = spawn(binary,[
      "dev","--config",config,"--local","--ip",HOST,
      "--port",String(PORT),"--inspector-port",String(INSPECTOR),
      "--persist-to",join(temp,"state"),"--log-level","error"
    ],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"],
      env:{...process.env,CLOUDFLARE_API_TOKEN:"",CLOUDFLARE_ACCOUNT_ID:"",
        CLOUDFLARE_API_KEY:"",CLOUDFLARE_EMAIL:""}});
    child.stderr.on("data", chunk => {stderr = (stderr + String(chunk)).slice(-1600);});
    const endpoint = await waitUntilReady(child);
    inspector = await connect(endpoint);
    await inspector.call("Profiler.enable");
    const records=[];
    for (const days of [30,90,366]) records.push(await profileDay(inspector,days));
    const report = {
      issue:313,
      environment:"local Workerd on CI runner, fake D1/Google only",
      measurement:"CDP non-idle CPU profiler samples; approximation not billable CPU",
      notCloudflareFreeAttestation:true,
      deferredProductionGates:[
        "real D1 and Google CPU/ACL acceptance","physical writer exclusivity",
        "actual Cloudflare Free Cron 10ms CPU feasibility"
      ],records
    };
    console.log("AI_B4_LOCAL_WORKERD_CPU_PROFILE "+JSON.stringify(report));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines=["### Issue #313 — local Workerd synthetic CPU profile",
        "Not a production Free CPU attestation. No remote bindings or credentials.",
        "| days | CDP CPU p50 (ms) | p95 | max | payload bytes | subrequests |",
        "|---:|---:|---:|---:|---:|---:|"];
      for(const row of records){
        const c=row.cpuEstimateMs;
        lines.push("| "+row.days+" | "+c.p50.toFixed(3)+" | "+c.p95.toFixed(3)+
          " | "+c.max.toFixed(3)+" | "+row.payloadBytes+
          " | "+row.countedSubrequests+" |");
      }
      await appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join("\n")+"\n");
    }
  } catch(error) {
    // Only report controlled failure codes, not arbitrary runtime debug payloads.
    console.error("AI_B4_LOCAL_WORKERD_PROFILE_INCOMPLETE",
      error instanceof Error ? error.message.slice(0,220) : "UNKNOWN");
    if (/LOCAL_WORKER_(EXITED|INSPECTOR_UNAVAILABLE)/u.test(String(error)))
      console.error("LOCAL_WORKERD_STARTUP_DIAGNOSTICS",
        stderr.replace(/Bearer\s+\S+/giu,"[REDACTED]").slice(-900));
    process.exitCode = 1;
  } finally {
    inspector?.close();
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await sleep(200);
    await rm(temp,{recursive:true,force:true});
  }
}
await main();
