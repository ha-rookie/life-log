#!/usr/bin/env node
// Synthetic-only real Chromium E2E. No Cloudflare access or personal records.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
const dir=await mkdtemp(join(tmpdir(),"life-log-browser-"));
const fixture=join(dir,"synthetic.csv");
await writeFile(fixture,[
"年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ",
'2026/01/02,07:40,75,25,36,23.5,7,3,1700,"SYNTHETIC PRIVATE MEMO"',""
].join("\n"));
const vite=spawn("npm",["run","dev:ui","--","--port","5187","--strictPort"],{stdio:"ignore"});
let chrome,ws,seq=0,mode="ok",confirmed=0,readbacks=0,normal=0;
const pending=new Map();
const calls=[];
function cmd(method,params={}){
 return new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
  setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(Error("CDP timeout "+method));}},15000).unref();
 });
}
const encode=x=>Buffer.from(JSON.stringify(x)).toString("base64");
async function intercept(p){
 const path=new URL(p.request.url).pathname;calls.push(path);
 let code=200,data={};
 if(path==="/api/dashboard")data={latestWeightKg:75,measuredAt:"2026-01-02T07:40:00+09:00",weightSource:"csv:eclear",latestSteps:null,stepsDay:null,stepsSource:null};
 else if(path==="/api/eclear/enrichment/preview"){
  data={status:"preview",reviewToken:"synthetic-token",total:1,newMeasurements:0,enrichMeasurements:1,enrichCells:5,sameCells:2,conflictMeasurements:0,missingCells:0,unchangedMeasurements:0,classifications:[]};
  if(mode==="conflict"){data.conflictMeasurements=1;data.enrichCells=0;data.enrichMeasurements=0;data.classifications=[{line:2,status:"conflict",reason:"existing_value_conflict",enrichFields:[],conflictFields:["bodyFatPct"]}];}
  if(mode==="disabled"){code=403;data={error:"ECLEAR_LOCAL_DISABLED"};}
  if(mode==="readback"){readbacks++;data.enrichCells=0;data.enrichMeasurements=0;data.unchangedMeasurements=1;}
 }else if(path==="/api/eclear/enrichment/confirm"){
  confirmed++;
  assert(!String(p.request.postData).includes("SYNTHETIC PRIVATE MEMO"),"memo sent to API");
  if(mode==="stale"){code=409;data={error:"REVIEW_STALE"};}
  else{mode="readback";data={status:"applied",inserted:0,enriched:1,cells:5};}
 }else if(path==="/api/import/confirm"){normal++;data={status:"confirmed",inserted:1,updated:0,skipped:0,conflicted:0};}
 else if(path==="/api/auth/passkey/status")data={registered:true,passwordEnabled:false,passkeySession:true};
 else {code=404;data={error:"SYNTHETIC_UNHANDLED"};}
 await cmd("Fetch.fulfillRequest",{requestId:p.requestId,responseCode:code,responseHeaders:[{name:"content-type",value:"application/json"}],body:encode(data)});
}
async function js(expression){
 const x=await cmd("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(x.exceptionDetails)throw Error("Browser evaluation failed: "+x.exceptionDetails.text);
 return x.result.value;
}
async function wait(check,label,limit=14000){
 const started=Date.now();
 while(Date.now()-started<limit){if(await check())return;await sleep(150);}
 throw Error("Timeout "+label+" "+String(await js("document.body?.innerText")).slice(-450));
}
const contains=t=>js("document.body?.innerText.includes("+JSON.stringify(t)+")");
async function click(text){
 const found=await js("(()=>{const t="+JSON.stringify(text)+";const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes(t));if(!b||b.disabled)return false;b.click();return true})()");
 assert(found,"button "+text);
}
async function upload(){
 const {root}=await cmd("DOM.getDocument");
 const {nodeId}=await cmd("DOM.querySelector",{nodeId:root.nodeId,selector:'input[type="file"]'});
 assert(nodeId,"file input");
 await cmd("DOM.setFileInputFiles",{nodeId,files:[fixture]});
 await wait(()=>contains("ECLEARの読み込みが完了しました"),"CSV parsed");
}
try{
 await wait(async()=>{try{return (await fetch("http://127.0.0.1:5187/")).ok;}catch{return false;}},"Vite",20000);
 chrome=spawn(process.env.CHROME_BIN||"google-chrome",[
 "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
 "--disable-background-networking","--no-first-run","--remote-debugging-port=0",
 "--user-data-dir="+join(dir,"profile"),"about:blank"],{stdio:"ignore"});
 let port=0;
 await wait(async()=>{try{port=Number((await readFile(join(dir,"profile","DevToolsActivePort"),"utf8")).split("\n")[0]);return port>0;}catch{return false;}},"Chrome CDP");
 const tabs=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();
 ws=new WebSocket(tabs.find(x=>x.type==="page").webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{
  const msg=JSON.parse(event.data);
  if(msg.id){const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result||{});}
  else if(msg.method==="Fetch.requestPaused")void intercept(msg.params).catch(e=>{console.error(e);process.exitCode=1;});
 });
 await cmd("Page.enable");await cmd("Runtime.enable");
 await cmd("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
 await cmd("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
 await cmd("Fetch.enable",{patterns:[{urlPattern:"*://127.0.0.1:5187/api/*",requestStage:"Request"}]});
 await cmd("Page.navigate",{url:"http://127.0.0.1:5187/#data"});
 await wait(()=>contains("CSVを取り込む"),"React app mounted");
 assert.equal(await js("window.innerWidth"),390);
 await upload();
 await click("体組成の不足項目だけ補完");
 await click("不足項目を確認する");
 await wait(()=>contains("補完対象"),"preview");
 assert(await contains("5項目"));
 mode="conflict";await click("再プレビュー");
 await wait(()=>contains("既存の数値とCSVの数値が異なります"),"conflict");
 assert.equal(await js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('確認して不足項目を保存する')&&!x.disabled)"),false);
 mode="disabled";await click("再プレビュー");
 await wait(()=>contains("補完機能は無効"),"403 disabled");
 mode="ok";await click("不足項目を確認する");
 await wait(()=>contains("補完対象"),"preview again");
 await js("document.querySelector('.eclear-ack input').click()");
 await click("確認して不足項目を保存する");
 await wait(()=>contains("保存結果を再照合しました"),"readback");
 assert.equal(confirmed,1);assert.equal(readbacks,1);
 await upload();await click("体組成の不足項目だけ補完");
 mode="stale";confirmed=0;
 await click("不足項目を確認する");
 await wait(()=>contains("補完対象"),"stale preview");
 await js("document.querySelector('.eclear-ack input').click()");
 await click("確認して不足項目を保存する");
 await wait(()=>contains("再プレビューが必要"),"409 stale");
 assert.equal(confirmed,1,"no auto retry");
 assert(!await contains("補完が完了し、保存結果を再照合しました"));
 mode="ok";await upload();
 assert(await contains("体重・体脂肪率を通常取込"));
 assert(await contains("確認して登録する"));
 assert.equal(normal,0,"normal import never auto-sent");
 assert.equal(await js("(()=>{const d=[...document.querySelectorAll('details')].find(x=>x.textContent.includes('ログイン・パスキー設定'));if(!d)return false;d.open=true;return true})()"),true);
 await wait(()=>contains("ログイン設定（Android UAT）"),"passkey settings");
 assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,"390px overflow");
 console.log(JSON.stringify({result:"PASS",browser:"Chromium",viewport:390,
  verified:["React UI","file picker","normal import isolation","preview","conflict",
   "403 disabled","commit readback","409 no retry","memo privacy","passkey status UI","no overflow"],
  apiCalls:calls.length,remoteD1:0}));
}catch(error){
 console.error("Chromium E2E failed:",error);
 process.exitCode=1;
}finally{
 try{ws?.close();}catch{}
 chrome?.kill();vite.kill();
 await sleep(800);
 try{await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
 catch(error){console.error("Non-fatal browser temp cleanup:",String(error));}
}
