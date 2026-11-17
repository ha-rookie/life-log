#!/usr/bin/env node
// Synthetic-only real Chromium E2E. No Cloudflare access or personal records.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
const dir=await mkdtemp(join(tmpdir(),"life-log-browser-"));
const fixture=join(dir,"synthetic.csv");
const jpLifestyleFixture=join(dir,"synthetic-japanese-lifestyle.csv");
const jpRejectedFixture=join(dir,"synthetic-japanese-lifestyle-rejected.csv");
const jpWeightFixture=join(dir,"synthetic-japanese-lifestyle-weight.csv");
await writeFile(fixture,[
"年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ",
'2026/01/02,07:40,75,25,36,23.5,7,3,1700,"SYNTHETIC PRIVATE MEMO"',""
].join("\n"));
await writeFile(jpLifestyleFixture,"\uFEFF日付,飲酒,歩数,体重_kg,測定時刻\r\n"+
 "2026/01/02,1,0,,\r\n2026/01/03,0,,,\r\n2026/01/04,,6500,,\r\n");
await writeFile(jpRejectedFixture,"日付,飲酒,歩数,体重_kg,測定時刻\n2026/01/05,1,0,75,07:00\n");
await writeFile(jpWeightFixture,"\uFEFF日付,飲酒,歩数,体重_kg\r\n2026/01/06,1,0,75.2\r\n");
// Do not pipe npm/Vite's stdio: inherited grandchild pipes can keep this
// standalone Node E2E process alive after its browser assertions finish.
const vite=spawn("npm",["run","dev:ui","--","--port","5187","--strictPort"],{stdio:"ignore"});
let chrome,ws,seq=0,mode="ok",confirmed=0,readbacks=0,normal=0;
let syntheticDrink=null,lastDrinkPost=null,lastDrinkPatch=null,lastHistoryQuery=null,lastManualRange=null,lastNormalPost=null;
let expiredInterceptions=0;
const auditRequestLog=[];
const syntheticManualDay=new Date(Date.now()+9*3600000-45*86400000).toISOString().slice(0,10);
const pending=new Map();
const calls=[];
const blockedRemoteOrigins=new Set();
// All Chromium HTTP(S) traffic is intercepted: localhost is the *only*
// allowed host. Test data must never reach any live UAT or production endpoint.
function cmd(method,params={}){
 if(!ws||ws.readyState!==WebSocket.OPEN)
  return Promise.reject(Error("CDP_NOT_CONNECTED:"+method));
 return new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
  setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(Error("CDP timeout "+method));}},15000).unref();
 });
}
const encode=x=>Buffer.from(JSON.stringify(x)).toString("base64");
const roundSynthetic=x=>Math.round(x*100)/100;
async function intercept(p){
 const url=new URL(p.request.url);
 if(url.protocol==="http:"||url.protocol==="https:"){
   if(url.origin!=="http://127.0.0.1:5187"){
     blockedRemoteOrigins.add(url.origin);
     await cmd("Fetch.failRequest",{requestId:p.requestId,errorReason:"BlockedByClient"});
     return;
   }
 }
 // Synthetic login document is served only by this localhost Chromium fixture.
 if(url.pathname==="/login"&&mode==="dashboard-expired"){
   await cmd("Fetch.fulfillRequest",{requestId:p.requestId,responseCode:200,
     responseHeaders:[{name:"content-type",value:"text/html; charset=utf-8"}],
     body:Buffer.from("<!doctype html><html lang='ja'><body>SYNTHETIC LOGIN ENTRY</body></html>").toString("base64")});
   return;
 }
 if(!url.pathname.startsWith("/api/")){
   await cmd("Fetch.continueRequest",{requestId:p.requestId});
   return;
 }
 const path=url.pathname;calls.push(path);
 let code=200,data={};
 if(path==="/api/dashboard"){
   data={latestWeightKg:75,measuredAt:"2026-01-02T07:40:00+09:00",weightSource:"csv:eclear",latestSteps:null,stepsDay:null,stepsSource:null};
   if(mode==="dashboard-expired"){code=403;data={error:"AUTH_REQUIRED"};}
   if(mode==="dashboard-unavailable"){code=503;data={error:"SERVICE_UNAVAILABLE"};}
 }
 else if(path==="/api/eclear/enrichment/preview"){
  data={status:"preview",reviewToken:"synthetic-token",total:1,newMeasurements:0,enrichMeasurements:1,enrichCells:5,sameCells:2,conflictMeasurements:0,missingCells:0,unchangedMeasurements:0,classifications:[]};
  if(mode==="conflict"){data.conflictMeasurements=1;data.enrichCells=0;data.enrichMeasurements=0;data.classifications=[{line:2,status:"conflict",reason:"existing_value_conflict",enrichFields:[],conflictFields:["bodyFatPct"]}];}
  if(mode==="disabled"){code=403;data={error:"ECLEAR_LOCAL_DISABLED"};}
  if(mode==="readback"){readbacks++;data.enrichCells=0;data.enrichMeasurements=0;data.unchangedMeasurements=1;}
 }else if(path==="/api/eclear/enrichment/confirm"){
  confirmed++;
  assert(!String(p.request.postData).includes("SYNTHETIC PRIVATE MEMO"),"memo sent to API");
  if(mode==="stale"){code=409;data={error:"REVIEW_STALE"};}
  else if(mode==="timeout"){code=503;data={error:"SYNTHETIC_TIMEOUT"};}
  else{mode="readback";data={status:"applied",inserted:0,enriched:1,cells:5};}
 }else if(path==="/api/import/confirm"){
   normal++;lastNormalPost=JSON.parse(p.request.postData||"{}");
   assert.equal(typeof lastNormalPost.csv,"string");
   if(lastNormalPost.originalBase64!==undefined){
     const original=Buffer.from(lastNormalPost.originalBase64,"base64");
     assert.equal(createHash("sha256").update(original).digest("hex"),lastNormalPost.originalSha256,
       "original raw bytes digest is independently reproducible");
   }
   data={status:"confirmed",inserted:1,updated:0,skipped:0,conflicted:0,
     ...(lastNormalPost.source==="lifestyle_weight"?{
       targetCounts:{inserted:2,skipped:0,conflicted:0},expectedTargets:2}: {})};
 }
 else if(path==="/api/auth/passkey/status")data={registered:true,passwordEnabled:false,passkeySession:true};
 else if(path==="/api/import/history"||path.startsWith("/api/import/history/")){
   const cursor=url.searchParams.get("cursor");
   auditRequestLog.push({path,cursor});
   if(path==="/api/import/history"){
     const jobs=Array.from({length:12},(_,i)=>({id:String(i+1),source:"eclear",status:"confirmed",
       startedAt:"2026-11-"+String(14-i).padStart(2,"0")+"T09:00:00Z",
       auditStatus:"available",auditCount:12,insertedRecords:12}));
     data={jobs:cursor==="synthetic-job-next"?jobs.slice(10):jobs.slice(0,10),
       nextCursor:cursor==="synthetic-job-next"?null:"synthetic-job-next"};
   }else{
     const rows=Array.from({length:12},(_,i)=>({line:i+2,result:"inserted",errorCode:null,
       values:{weightKg:75,bodyFatPct:null}}));
     data={job:{id:path.split("/").at(-1),source:"eclear",status:"confirmed",auditStatus:"available",
       counts:{inserted:12,updated:0,skipped:0,conflict:0,invalid:0}},
       rows:cursor==="synthetic-row-next"?rows.slice(10):rows.slice(0,10),
       nextCursor:cursor==="synthetic-row-next"?null:"synthetic-row-next"};
   }
 }
 else if(path==="/api/manual/records"){
  const from=url.searchParams.get("from"),to=url.searchParams.get("to");
  lastManualRange={from,to};
  const visible=from!==null&&to!==null&&syntheticManualDay>=from&&syntheticManualDay<=to;
  data={from,to,weights:visible?[{key:"synthetic-weight-1",measuredAt:syntheticManualDay+"T07:30:00+09:00",weightKg:75}]:[],
    steps:visible?[{day:syntheticManualDay,steps:6543}]:[]};
 }
 else if(path==="/api/mvp/drinks"){
  const method=p.request.method;
  if(method==="GET"){
    // Mirror the server's bounded JST day filters, including the default last 30 days.
    const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
    const from=url.searchParams.get("from")??
      new Date(Date.parse(today+"T00:00:00Z")-29*86400000).toISOString().slice(0,10);
    const to=url.searchParams.get("to")??today;
    if(url.searchParams.has("from"))lastHistoryQuery={from,to};
    const day=syntheticDrink?.observedAt?.slice(0,10);
    data={entries:syntheticDrink&&day>=from&&day<=to?[syntheticDrink]:[]};
   }
  else if(method==="POST"){
   lastDrinkPost=JSON.parse(p.request.postData??"{}");
   assert.equal(typeof lastDrinkPost.cups,"number","POST cups must remain numeric");
   syntheticDrink={...lastDrinkPost,alcohol:1};
   data={status:"created"};
  }else if(method==="PATCH"){
   lastDrinkPatch=JSON.parse(p.request.postData??"{}");
   assert.equal(typeof lastDrinkPatch.cups,"number","PATCH cups must remain numeric");
   assert.equal(lastDrinkPatch.key,syntheticDrink?.key);
   syntheticDrink={...syntheticDrink,cups:lastDrinkPatch.cups,kind:lastDrinkPatch.kind,
     size:lastDrinkPatch.size,volumeMl:lastDrinkPatch.volumeMl,abvPct:lastDrinkPatch.abvPct,
     observedAt:lastDrinkPatch.observedAt};
   data={status:"updated"};
  }else {code=405;data={error:"METHOD_NOT_ALLOWED"};}
 }
 else if(path==="/api/mvp/metrics"){
  const asOf=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  data={asOf,ruleVersion:"synthetic-metrics",disclaimer:"合成データの欠測を0にしません",
   daily:Array.from({length:28},(_,i)=>{
    const day=new Date(Date.parse(asOf+"T00:00:00Z")-(27-i)*86400000).toISOString().slice(0,10);
    return {day,weightKg:i===5?null:roundSynthetic(76-i*0.01),
     weightSource:"csv:eclear",steps:i%8===0?0:6000+i*100,stepsSource:"google_fit",
     estimatedFatMassKg:[0,14,27].includes(i)?roundSynthetic(22-i*0.08):null,
     estimatedSkeletalMuscleKg:[0,14,27].includes(i)?roundSynthetic(26+i*0.02):null,
     drinkingStatus:i%2===0?"yes":"no",alcoholG:i%2===0?10:0,unknownCups:0};
   }),
   windows:[7,14,28].map(days=>({
    days,from:"2026-11-01",to:asOf,
    weight:{qualifiedMeanKg:days===7?75.8:null,meanKg:75.8,observedDays:5,missingDays:days-5},
    steps:{mean:6400,observedDays:4,missingDays:days-4,explicitZeroDays:1,sources:["google_fit"]},
    drinking:{observedDays:3,missingDays:days-3,recordedAlcoholCups:5,
     enteredG:12,estimatedG:50,unknownCups:2,assumptionVersion:"personal-2026-11-15-v1"},
    composition:{latest:{estimatedFatMassKg:21.3,estimatedSkeletalMuscleKg:25.1,
     measuredAt:"2026-11-08T09:00:00+09:00",source:"eclear"},deviceDerived:true}
   }))};
 }
 else if(path==="/api/mvp/lag"){
  const asOf=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  data={asOf,from:"2026-08-17",to:"2026-11-08",disclaimer:"合成：探索的な符号比較",
   weeks:Array.from({length:12},(_,i)=>({
    from:"2026-08-17",to:"2026-11-"+String(Math.min(28,i+1)).padStart(2,"0"),
    weightMeanKg:i<2?null:76+i*0.1,weightObservedDays:i<2?0:5,
    stepsMean:i<1?null:5000+i*100,stepsObservedDays:i<1?0:5
   })),
   lags:[1,2,4].map(lagWeeks=>({
    lagWeeks,stepHypothesis:lagWeeks===1?
     {pairedWeeks:6,support:5,counter:1,flat:0,verdict:"supporting_observations"}:
     {pairedWeeks:2,support:2,counter:0,flat:0,verdict:"undetermined"},
    alcoholHypothesis:{pairedWeeks:0,support:0,counter:0,flat:0,verdict:"undetermined"}
   }))};
 }
 else if(path==="/api/mvp/experiments")data={experiments:[{
   id:"00000000-0000-4000-8000-000000000015",statement:"合成：散歩の実験",
   supportText:"記録を比較",counterText:"欠測もある",unknownText:"因果関係",
   status:"active",startsOn:new Date(Date.now()+9*3600000-8*86400000).toISOString().slice(0,10),
   endsOn:new Date(Date.now()+9*3600000+7*86400000).toISOString().slice(0,10),
   targetAction:"夜に散歩",outcomeText:null,decision:null
 }]};
 else if(path==="/api/mvp/experiments/evidence"){
   assert.equal(url.searchParams.get("id"),"00000000-0000-4000-8000-000000000015");
   const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
   const beforeFrom=new Date(Date.now()+9*3600000-17*86400000).toISOString().slice(0,10);
   const beforeTo=new Date(Date.now()+9*3600000-9*86400000).toISOString().slice(0,10);
   const duringFrom=new Date(Date.now()+9*3600000-8*86400000).toISOString().slice(0,10);
   const period=(from,to,observed)=>({
     from,to,calendarDays:9,
     weight:{startDay:observed?from:null,startKg:observed?78:null,
       startMeasuredAt:observed?from+"T08:00:00+09:00":null,startSource:observed?"eclear":null,
       endDay:observed?to:null,endKg:observed?77:null,
       endMeasuredAt:observed?to+"T08:00:00+09:00":null,endSource:observed?"eclear":null,
       deltaKg:observed?-1:null,observedDays:observed?5:1,missingDays:observed?4:8,
       lastSevenMeanKg:observed?77.5:null,lastSevenObservedDays:observed?5:1,lastSevenWindowDays:7},
     steps:{mean:observed?5000:null,observedDays:observed?5:0,
       missingDays:observed?4:9,zeroDays:0,sources:observed?["google_fit"]:[]},
     drinking:{observedDays:observed?3:0,drinkingDays:observed?1:0,nondrinkingDays:observed?2:0,
       missingDays:observed?6:9,recordedAlcoholCups:0,recordedNonAlcoholCups:0,
       cupEntryCount:0,knownAlcoholG:0,unknownAlcoholCups:0},
     meals:{lateMealDays:0,lateMealObservedDays:0,observedLunchDays:0,observedDinnerDays:0,
       restaurantLunchDays:0,restaurantDinnerDays:0,takeoutLunchDays:0,takeoutDinnerDays:0},
     outings:{visits:0,work:0,bar:0,other:0}
   });
   data={id:"00000000-0000-4000-8000-000000000015",status:"in_progress",asOf:today,
     plannedFrom:duringFrom,plannedTo:new Date(Date.now()+9*3600000+7*86400000).toISOString().slice(0,10),
     before:period(beforeFrom,beforeTo,true),during:period(duringFrom,today,false),
     disclaimer:"合成データ：因果判定を自動化しません"};
 }
 else if(path==="/api/mvp/compare"){
   const q=url.searchParams;
   const summary=(from,to,observed)=>({
     from,to,calendarDays:15,
     weight:observed?{
       startDay:from,startKg:78,startMeasuredAt:from+"T08:00:00+09:00",startSource:"csv:eclear",
       endDay:to,endKg:77.5,endMeasuredAt:to+"T21:00:00+09:00",endSource:"manual:weight",
       deltaKg:-0.5,observedDays:2,missingDays:13
     }:{
       startDay:null,startKg:null,startMeasuredAt:null,startSource:null,
       endDay:null,endKg:null,endMeasuredAt:null,endSource:null,
       deltaKg:null,observedDays:0,missingDays:15
     },
     steps:observed
       ?{mean:2500,observedDays:2,missingDays:13,zeroDays:1,sources:["google_fit"]}
       :{mean:null,observedDays:0,missingDays:15,zeroDays:0,sources:[]},
     drinking:observed
       ?{observedDays:2,drinkingDays:1,nondrinkingDays:1,missingDays:13,
         recordedAlcoholCups:4,recordedNonAlcoholCups:0,cupEntryCount:1,knownAlcoholG:0,unknownAlcoholCups:4}
       :{observedDays:0,drinkingDays:0,nondrinkingDays:0,missingDays:15,
         recordedAlcoholCups:0,recordedNonAlcoholCups:0,cupEntryCount:0,knownAlcoholG:0,unknownAlcoholCups:0},
     outings:{visits:0,work:0,bar:0,other:0},
     meals:observed
       ?{lateMealDays:0,lateMealObservedDays:1,observedLunchDays:2,observedDinnerDays:1,
         restaurantLunchDays:1,restaurantDinnerDays:0,takeoutLunchDays:1,takeoutDinnerDays:1}
       :{lateMealDays:0,lateMealObservedDays:0,observedLunchDays:0,observedDinnerDays:0,
         restaurantLunchDays:0,restaurantDinnerDays:0,takeoutLunchDays:0,takeoutDinnerDays:0}
   });
   data={a:summary(q.get("aFrom"),q.get("aTo"),true),
     b:summary(q.get("bFrom"),q.get("bTo"),false),
     disclaimer:"Synthetic only; no causal claim."};
 }
 else if(path==="/api/mvp/meals"||path==="/api/mvp/outings")data={entries:[]};
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
 const context=ws?.readyState===WebSocket.OPEN
  ?String(await js("document.body?.innerText")).slice(-450)
  : "PRE_BROWSER_STARTUP (Vite did not become reachable)";
 throw Error("Timeout "+label+" "+context);
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
 await wait(async()=>{
  if(vite.exitCode!==null)throw Error("VITE_PROCESS_EXIT:"+vite.exitCode);
  try{return (await fetch("http://127.0.0.1:5187/")).ok;}catch{return false;}
 },"Vite startup",45000);
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
  else if(msg.method==="Fetch.requestPaused")void intercept(msg.params).catch(e=>{
    // CDP can invalidate an already-paused request while navigating locally.
    // Bound only that exact browser race; external requests remain fatal via blockedRemoteOrigins.
    if(String(e).includes("Invalid InterceptionId.")&&++expiredInterceptions<=3)return;
    console.error(e);process.exitCode=1;
   });
 });
 await cmd("Page.enable");await cmd("Runtime.enable");
 await cmd("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
 await cmd("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
 await cmd("Fetch.enable",{patterns:[{urlPattern:"*",requestStage:"Request"}]});
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
 await wait(()=>contains("もう一度プレビューしてください"),"409 stale");
 assert.equal(confirmed,1,"no auto retry");
 assert(!await contains("補完が完了し、保存結果を再照合しました"));
 mode="ok";await upload();await click("体組成の不足項目だけ補完");
 mode="timeout";confirmed=0;
 await click("不足項目を確認する");
 await wait(()=>contains("補完対象"),"timeout preview");
 await js("document.querySelector('.eclear-ack input').click()");
 await click("確認して不足項目を保存する");
 await wait(()=>contains("登録結果は未確定"),"network failure uncertainty");
 assert.equal(confirmed,1,"no auto retry after transport failure");
 mode="ok";await upload();
 assert(await contains("体重・体脂肪率を通常取込"));
 assert(await contains("確認して登録する"));
 assert.equal(normal,0,"normal import never auto-sent");
 await click("確認して登録する");
 await wait(()=>contains("登録完了：追加 1件"),"normal CSV import");
 assert.equal(normal,1,"normal import uses distinct v1 endpoint");
 // Japanese lifestyle mapping: the real 390px picker must normalize safely,
 // preserve explicit 0/unknown, and never send an unapproved body-weight target.
 async function uploadSyntheticFile(path){
  const {root}=await cmd("DOM.getDocument");
  const {nodeId}=await cmd("DOM.querySelector",{nodeId:root.nodeId,selector:'input[type="file"]'});
  assert(nodeId,"file input for Japanese lifestyle");
  await cmd("DOM.setFileInputFiles",{nodeId,files:[path]});
 }
 await uploadSyntheticFile(jpLifestyleFixture);
 await wait(()=>contains("判別した種類：生活記録"),"Japanese lifestyle detected");
 await wait(()=>contains("対象 3 行"),"Japanese lifestyle original 3 rows");
 assert(await contains("読み取り文字コード：UTF-8"),"Japanese UTF-8 decoded");
 assert(await contains("まだ登録していません"),"Japanese mapping is preview-only");
 assert.equal(normal,1,"picker does not auto-confirm Japanese file");
 await click("確認して登録する");
 await wait(()=>normal===2,"Japanese lifestyle canonical explicit submit");
 await wait(()=>contains("登録完了：追加 1件"),"synthetic Japanese import success");
 assert.equal(typeof lastNormalPost?.originalBase64,"string","original bytes sent only upon explicit confirm");
 assert.equal(lastNormalPost.originalSha256.length,64,"original digest attached");
 const rawJP=Buffer.from(lastNormalPost.originalBase64,"base64");
 assert.deepEqual([...rawJP.subarray(0,3)],[0xef,0xbb,0xbf],"UTF-8 BOM preserved");
 assert(rawJP.includes(Buffer.from("\r\n")),"original CRLF retained in proof");
 // V3: weight is an independently audited *date-only reported* second target.
 await uploadSyntheticFile(jpWeightFixture);
 await wait(()=>contains("判別した種類：生活記録＋体重（日付のみ）"),"v3 Japanese two-target detected");
 assert(await contains("測定時刻は作らず"),"v3 precision disclaimer");
 assert.equal(normal,2,"v3 preview is not an automatic commit");
 await click("確認して登録する");
 await wait(()=>normal===3,"v3 explicit synthetic confirm");
 assert.equal(lastNormalPost.source,"lifestyle_weight","v3 canonical target used");
 await wait(()=>contains("保存先別：追加 2件"),"v3 result displays per-target count");
 await uploadSyntheticFile(jpRejectedFixture);
 await wait(()=>contains("CSVの形式・日時・数値・重複を確認できませんでした"),"invented-time row rejected");
 assert.equal(normal,3,"rejected invented time never sent to backend");
 assert.equal(await js("[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='確認して登録する'&&!x.disabled)"),false,
  "rejected file cannot be confirmed");
 await uploadSyntheticFile(jpLifestyleFixture);
 await wait(()=>contains("判別した種類：生活記録"),"valid file recovers after rejection");
 assert(await contains("元ファイルのSHA-256を照合します"),"one-chunk UTF-8 bounded proof");
 assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,
   "Japanese CSV picker 390px overflow");
 assert.equal(await js("(()=>{const d=[...document.querySelectorAll('details')].find(x=>x.textContent.includes('ログイン・パスキー設定'));if(!d)return false;d.open=true;return true})()"),true);
 await wait(()=>contains("ログイン設定（Android UAT）"),"passkey settings");
 // Audit-history pagination is page bounded and uses non-persistent cursor state.
 assert(await js("(()=>{const d=[...document.querySelectorAll('details')].find(x=>x.querySelector('summary')?.textContent.includes('取込履歴・監査の詳細'));if(!d)return false;d.open=true;return true})()"));
 await click("履歴を表示・更新");
 await wait(()=>js("document.querySelector('#history-title')?.closest('section')?.querySelectorAll('ul > li').length===10"),"first audit job page");
 await click("次の取込10件");
 await wait(()=>js("document.querySelector('#history-title')?.closest('section')?.querySelectorAll('ul > li').length===2"),"second audit job page");
 await click("前の取込10件");
 await wait(()=>js("document.querySelector('#history-title')?.closest('section')?.querySelectorAll('ul > li').length===10"),"previous audit job page");
 await click("行を表示");
 await wait(()=>contains("当時の元CSVの数値ではありません"),"current saved values disclaimer");
 await wait(()=>js("document.querySelector('#history-title')?.closest('section')?.querySelectorAll('ol > li').length===10"),"first audit row page");
 await click("次の監査行10件");
 await wait(()=>js("document.querySelector('#history-title')?.closest('section')?.querySelectorAll('ol > li').length===2"),"second audit row page");
 await click("前の監査行10件");
 await wait(()=>js("document.querySelector('#history-title')?.closest('section')?.querySelectorAll('ol > li').length===10"),"previous audit row page");
 assert(auditRequestLog.some(x=>x.cursor==="synthetic-job-next"),"job cursor used in memory");
 assert(auditRequestLog.some(x=>x.cursor==="synthetic-row-next"),"row cursor used in memory");
 // Android Chrome-like 390px touch viewport: both cup fields must permit clearing
 // the current value without immediately replacing it with "0".
 await cmd("Page.navigate",{url:"http://127.0.0.1:5187/#record"});
 await wait(()=>js("Boolean(document.querySelector('#drink-cups-new'))"),"drink form mounted");
 // A fresh one-cup tequila shot is estimated as 9.6g; no ml/ABV entered.
 await js("(()=>{const e=document.querySelector('.drinks-panel select');e.value='tequila_shot';"+
   "e.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await wait(()=>js("document.querySelector('.drinks-panel').innerText.includes('簡易推定 約9.6g')"),
   "tequila in new input labeled personal estimate");
 assert.equal(await js("document.querySelector('.drinks-panel details input[type=number]').value"),"",
   "new drink leaves actual ml unknown");
 await js("(()=>{const e=document.querySelector('.drinks-panel select');e.value='highball';"+
   "e.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await wait(()=>js("document.querySelector('.drinks-panel').innerText.includes('簡易推定 約10g')"),
   "server highball uses the 250ml 5% personal assumption");

 const cupSettings=await js("(()=>{const x=document.querySelector('#drink-cups-new');return {type:x.type,keyboard:x.inputMode,size:Math.round(x.getBoundingClientRect().height),font:getComputedStyle(x).fontSize,value:x.value}})()");
 assert.deepEqual(cupSettings,{type:"text",keyboard:"numeric",size:48,font:"16px",value:"1"});
 const selected=await js("(()=>{const x=document.querySelector('#drink-cups-new');x.focus();x.click();return [x.selectionStart,x.selectionEnd]})()");
 assert.deepEqual(selected,[0,1],"new cup existing value must be selected on focus");
 async function backspace(){
  await cmd("Input.dispatchKeyEvent",{type:"keyDown",key:"Backspace",code:"Backspace",windowsVirtualKeyCode:8});
  await cmd("Input.dispatchKeyEvent",{type:"keyUp",key:"Backspace",code:"Backspace",windowsVirtualKeyCode:8});
 }
 async function cupInput(id,value){
  await js("(()=>{const e=document.querySelector("+JSON.stringify(id)+");e.focus();e.select()})()");
  await cmd("Input.insertText",{text:value});
  await wait(()=>js("document.querySelector("+JSON.stringify(id)+").value==="+JSON.stringify(value)),
    "cup text "+id+"="+value);
 }
 await backspace();
 await wait(()=>js("document.querySelector('#drink-cups-new').value===''"),"new cup clears to empty");
 assert.equal(await js("document.querySelector('#drink-cups-new').getAttribute('aria-invalid')"),"true");
 assert.equal(await js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('杯数を入力')&&!x.disabled)"),false);
 await cmd("Input.insertText",{text:"0"});
 await wait(()=>js("document.querySelector('#drink-cups-new').value==='0'"),"new cup invalid zero");
 assert.equal(await js("document.querySelector('#drink-cups-new').getAttribute('aria-invalid')"),"true");
 await cupInput("#drink-cups-new","51");
 assert.equal(await js("document.querySelector('#drink-cups-new').getAttribute('aria-invalid')"),"true");
 await cupInput("#drink-cups-new","7");
 // Past entries must be created at the selected JST time, not submission time.
 const historicDay=new Date(Date.now()+9*3600000-45*86400000).toISOString().slice(0,10);
 const historicLocal=historicDay+"T20:30";
 const futureLocal=new Date(Date.now()+9*3600000+86400000).toISOString().slice(0,16);
 async function chooseDrinkTime(value){
  await js("(()=>{const e=document.querySelector('#drink-time-new');"+
   "const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"+
   "setter.call(e,"+JSON.stringify(value)+");"+
   "e.dispatchEvent(new Event('input',{bubbles:true}));"+
   "e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()");
  await wait(()=>js("document.querySelector('#drink-time-new').value==="+JSON.stringify(value)),
   "chosen drink date/time "+value);
 }
 assert.equal(await js("document.querySelector('#drink-time-new').type"),"datetime-local");
 await chooseDrinkTime(futureLocal);
 await wait(()=>js("document.querySelector('#drink-time-new').getAttribute('aria-invalid')==='true'"),
  "future date blocked");
 await chooseDrinkTime(historicLocal);
 await wait(()=>js("document.querySelector('#drink-time-new').getAttribute('aria-invalid')==='false'"),
  "historical date valid");

 await wait(()=>js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('ハイボールを7杯記録')&&!x.disabled)"),"valid cups save enabled");
 await click("ハイボールを7杯記録");
 await wait(()=>lastDrinkPost?.cups===7,"POST numeric cups");
 assert.equal(typeof lastDrinkPost.cups,"number");
 assert.equal(lastDrinkPost.observedAt,historicLocal+":00+09:00","POST must use selected JST historical time");
 await wait(()=>js("document.querySelector('#drink-history-to').value==="+JSON.stringify(historicDay)),
  "history automatically follows backdated POST");
 await wait(()=>lastHistoryQuery?.to===historicDay,"history request uses historic end date");
 assert.equal(await js("document.body.innerText.includes('注文した杯数：お酒 0 杯 ／ ノンアル 0 杯')"),true,
  "historical browsing must not corrupt today's drink totals");
 await wait(()=>js("[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='訂正')"),"synthetic old record listed");
 assert(await js("(()=>{const d=[...document.querySelectorAll('details')].find(x=>x.querySelector('summary')?.textContent.includes('飲酒履歴を期間指定して確認・訂正する'));if(!d)return false;d.open=true;return true})()"));
 // Select today's 30-day window: the older drink disappears, then reappears when returning.
 const todayDay=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 async function chooseHistoryEnd(day){
  await js("(()=>{const e=document.querySelector('#drink-history-to');"+
   "const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"+
   "setter.call(e,"+JSON.stringify(day)+");"+
   "e.dispatchEvent(new Event('input',{bubbles:true}));"+
   "e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()");
  await wait(()=>lastHistoryQuery?.to===day,"history GET end "+day);
 }
 await chooseHistoryEnd(todayDay);
 await wait(()=>js("document.body.innerText.includes('選択した期間に飲酒記録はありません。')"),
  "older drink not in today's window");
 await chooseHistoryEnd(historicDay);
 await wait(()=>js("[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='訂正')"),
  "historic drink restored after manually choosing a past date");
 await click("訂正");
 await wait(()=>js("Boolean(document.querySelector('#drink-cups-edit'))"),"edit cup form");
 const editSettings=await js("(()=>{const x=document.querySelector('#drink-cups-edit');x.focus();x.click();return {type:x.type,keyboard:x.inputMode,value:x.value,selected:[x.selectionStart,x.selectionEnd]}})()");
 assert.deepEqual(editSettings,{type:"text",keyboard:"numeric",value:"7",selected:[0,1]});
 await backspace();
 await wait(()=>js("document.querySelector('#drink-cups-edit').value===''"),"edit cups remains empty");
 assert.equal(await js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('訂正を保存')&&!x.disabled)"),false);
 await cupInput("#drink-cups-edit","51");
 assert.equal(await js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('訂正を保存')&&!x.disabled)"),false);
 await cupInput("#drink-cups-edit","4");
 await wait(()=>js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('訂正を保存')&&!x.disabled)"),"edit cups valid");
 // All existing inputs remain usable; tequila can be selected in a past record.
 await js("(()=>{const e=document.querySelector('.mvp-edit select');e.value='tequila_shot';"+
   "e.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await wait(()=>js("document.querySelector('.mvp-edit select').value==='tequila_shot'"),"edit tequila kind");
 await wait(()=>js("document.querySelector('.mvp-edit').innerText.includes('簡易推定')"),
   "tequila past-record edit clearly labeled estimated");
 await click("訂正を保存");
 await wait(()=>lastDrinkPatch?.cups===4,"PATCH numeric cups");
 assert.equal(typeof lastDrinkPatch.cups,"number");
 assert.equal(lastDrinkPatch.kind,"tequila_shot","past drink PATCH retains tequila subtype");
 // Synthetic 45-day-old manual measurements are discoverable by date-selected history.
 assert(await js("(()=>{const d=document.querySelector('.manual-records');if(!d)return false;d.open=true;return true})()"),
  "manual history section");
 async function chooseManualHistory(day){
  await js("(()=>{const e=document.querySelector('#manual-history-to');"+
   "const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"+
   "setter.call(e,"+JSON.stringify(day)+");"+
   "e.dispatchEvent(new Event('input',{bubbles:true}));"+
   "e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()");
  await wait(()=>lastManualRange?.to===day,"manual range GET "+day);
 }
 await chooseManualHistory(syntheticManualDay);
 await wait(()=>js("document.querySelector('.manual-records')?.innerText.includes('6,543歩')"),
  "historical steps visible");
 assert.equal(await js("document.querySelector('.manual-records')?.innerText.includes('75.0kg')"),true,
  "historical weight visible");
 await chooseManualHistory(new Date(Date.now()+9*3600000).toISOString().slice(0,10));
 await wait(()=>js("document.querySelector('.manual-records')?.innerText.includes('手入力なし')"),
  "current month has no old manual entries");
 // The M02 period comparison must show the exact sampled evidence, coverage,
 // and an honest empty-range state in the real 390px synthetic browser.
 await cmd("Page.navigate",{url:"http://127.0.0.1:5187/#insights"});
 await wait(()=>contains("2期間の体重・生活比較"),"analysis view mounted");
 await wait(()=>contains("生活習慣の仮説検証"),"synthetic hypothesis dashboard mounted");
 await wait(()=>contains("1週後：支持傾向"),"support only with qualified pair evidence");
 assert(await contains("4週後：判定保留"),"insufficient observational weeks cannot infer a trend");
 assert(await contains("推定不能 2杯"),"unknown alcohol not turned into zero");
 assert(await contains("未取得 3日"),"missing weight is explicitly covered");
 assert(await contains("H5 歩数・飲酒の複合関係"),"all five hypotheses displayed");
 await wait(()=>contains("翌日の平均体重差"),"H2 uses observed paired days");
 assert(await contains("同曜日の観測比較"),"H3 matched weekday evidence displayed");
 assert(await contains("体組成を同日に測定した"),"H4 BIA comparison count shown");
 assert(await contains("比較可能な場合の機器推定差"),"BIA deltas are not treated as measured fat mass");
 assert(await contains("4群それぞれ3組以上"),"H5 completeness guard visible");
 await wait(()=>contains("本人の観測中央値"),"qualified 4-strata descriptive evidence shown");
 assert(await contains("気になる仮説を行動実験で検討する"),"M07 experiment link shown");


 assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,
  "390px hypothesis dashboard does not overflow");

 await click("期間を比較");
 await wait(()=>contains("期間内の最初の実測"),"comparison evidence");
 assert(await contains("csv:eclear"),"authoritative ECLEAR source displayed");
 assert(await contains("manual:weight"),"ending manual source displayed");
 assert(await contains("欠測 13日"),"missing weight days displayed");
 assert(await contains("実測が2日未満のため算出不可"),"empty range cannot yield a false delta");
 assert(await contains("実測記録なし"),"empty period does not fabricate a reading");
 // M03 evidence: distinguish explicit 0, absent Fit steps, drank/did-not-drink/unknown,
 // observed vs missing lunch/dinner and takeaway; never equate missing with 0.
 assert(await contains("観測 2日／15日、欠測 13日、実測0歩 1日"),"step zero distinct from missing");
 assert(await contains("歩数の出典"),"step source visibly identified");
 assert(await contains("google_fit"),"canonical Fit source label shown");
 assert(await contains("飲酒あり 1日／飲酒なし 1日／不明 13日"),"all three drink states visible");
 assert(await contains("飲酒あり 0日／飲酒なし 0日／不明 15日"),"unknown not fabricated as nondrinking");
 assert(await contains("中食（昼・夜）"),"takeout not silently omitted");
 assert(await contains("食事区分の観測・不明"),"lunch and dinner coverage labeled");
 assert(await contains("昼：観測 2日・不明 13日"),"observed and missing lunch");
 assert(await contains("夜：観測 1日・不明 14日"),"observed and missing dinner");
 assert(await js("(()=>{const b=document.querySelector('.mvp-periods section:nth-child(2)');return Boolean(b&&b.innerText.includes('観測なし')&&b.innerText.includes('不明 15日'))})()"),
   "empty period has no fabricated Fit source or nondrinking days");
 // M07: the plan's own button must load matched evidence, not predict future outcomes
 // or auto-write a user verdict; both lack of data and qualified 7-day mean are visible.
 await wait(()=>contains("合成：散歩の実験"),"synthetic registered plan shown");
 await click("この実験の前後を比較");
 await wait(()=>contains("開始前と実行期間の比較"),"M07 evidence panel loaded");
 assert(await contains("実行中（途中経過）"),"future days never treated as completed");
 assert(await contains("7日平均体重"),"qualified seven-day mean shown");
 assert(await contains("測定不足（7日中4日以上が必要）"),"insufficient data is NULL");
 assert(await contains("77.5 kg"),"qualified observed mean shown");
 assert(await contains("飲酒あり・なし・不明"),"actual drinking vs missing included");
 assert(await contains("記録がない杯数は推定しません"),"historical yes does not imply 1 cup");
 assert(await contains("最終判定は本人が行います"),"no automatic decision");
 assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,
   "390px evidence panel overflow");
 // Editing a date must immediately hide stale evidence until re-comparing.
 await js("(()=>{const el=document.querySelector('#compare-title').closest('section').querySelector('input[type=date]');"+
  "const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"+
  "setter.call(el,'2026-01-01');el.dispatchEvent(new Event('input',{bubbles:true}));"+
  "el.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await wait(()=>js("!document.body.innerText.includes('期間内の最初の実測')"),
   "old compare hidden after date edit");
 assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,"390px analysis overflow");
 assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,"drink form 390px overflow");
 assert.equal(await js("window.innerWidth"),390);
 assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,"390px overflow");
 // An already-open SPA must distinguish expired authentication from outage.
 // 503 remains an in-app error; 403 navigates to the same-origin login screen.
 mode="dashboard-unavailable";
 await cmd("Page.navigate",{url:"http://127.0.0.1:5187/#home"});
 await wait(()=>contains("記録を表示できません。ログイン状態を確認してください。"),
   "503 dashboard does not force reauthentication");
 assert.equal(await js("location.pathname"),"/","503 stays in private SPA");
 mode="dashboard-expired";
 await cmd("Page.navigate",{url:"http://127.0.0.1:5187/#home"});
 await wait(()=>contains("SYNTHETIC LOGIN ENTRY"),"403 dashboard routes to same-origin login",22000);
 assert.equal(await js("location.pathname"),"/login","403 directs to local passkey login entry");
 assert.deepEqual([...blockedRemoteOrigins],[],"Chrome tried to request a non-local host");
 console.log(JSON.stringify({result:"PASS",browser:"Chromium",viewport:390,
  verified:["React UI","file picker","normal import isolation","preview","conflict",
   "403 disabled","commit readback","409 no retry","503 no retry","normal import","memo privacy","passkey status UI",
   "Android 390px numeric input","focus selects existing cups","clearing preserves empty","invalid 0/51 blocked",
   "POST number cups","45-day backfill auto history","today counts unchanged","past JST date POST","future date blocked","edit empty/51 blocked","PATCH number cups","45-day manual weight/steps history","audit job and row previous-next","comparison evidence and missing coverage","M03 steps canonical source and zero vs missing","M03 drinking 1/0/unknown coverage","M03 lunch/dinner takeaway and missing coverage","Japanese lifestyle synthetic CSV picker/preview/confirm/reject","original source bytes BOM/CRLF SHA256 explicit confirm","v3 2-target explicit confirm and untrusted time rejection","M07 matched experiment evidence and insufficient 7-day weight","no synthetic auto verdict","stale compare cleared","no overflow",
   "SPA dashboard 503 stays in app","SPA dashboard 403 redirects to login"],
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
