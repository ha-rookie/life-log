#!/usr/bin/env node
// Real Chromium -> real local Workerd -> synthetic local D1.
// Virtual CTAP2 authenticator is a test device, NOT a physical Android passkey.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const [cookieFile,eclearFile,conflictFile,normalFile]=process.argv.slice(2);
assert(cookieFile&&eclearFile&&conflictFile&&normalFile,"synthetic fixture paths required");
const origin="https://localhost:8787";
const dir=await mkdtemp(join(tmpdir(),"lifelog-virtual-passkey-"));
let chrome,ws,id=0;
const pending=new Map(),requests=[];
function cmd(method,params={}){
  return new Promise((resolve,reject)=>{
    const current=++id;
    pending.set(current,{resolve,reject});
    ws.send(JSON.stringify({id:current,method,params}));
    setTimeout(()=>{
      const entry=pending.get(current);
      if(entry){pending.delete(current);entry.reject(Error("CDP timeout "+method));}
    },15000).unref();
  });
}
async function js(expression){
  const result=await cmd("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error("Chromium JS exception: "+result.exceptionDetails.text);
  return result.result.value;
}
async function wait(check,label,max=14000){
  const start=Date.now();
  while(Date.now()-start<max){if(await check())return;await sleep(140);}
  const body=await js("document.body?.innerText");
  throw Error("Timed out "+label+"; UI="+String(body).slice(-900));
}
const contains=text=>js("document.body?.innerText.includes("+JSON.stringify(text)+")");
async function click(text){
  const found=await js("(()=>{const t="+JSON.stringify(text)+";const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes(t));if(!b||b.disabled)return false;b.click();return true;})()");
  assert.equal(found,true,"clickable control: "+text);
}
async function openDetails(heading){
  const found=await js("(()=>{const t="+JSON.stringify(heading)+";const d=[...document.querySelectorAll('details')].find(x=>x.querySelector('summary')?.textContent.includes(t));if(!d)return false;d.open=true;return true;})()");
  assert.equal(found,true,"details: "+heading);
}
async function navigate(path){
  await cmd("Page.navigate",{url:origin+path});
}
async function upload(file){
  const {root}=await cmd("DOM.getDocument");
  const {nodeId}=await cmd("DOM.querySelector",{nodeId:root.nodeId,selector:'input[type="file"]'});
  assert(nodeId,"file selection control");
  await cmd("DOM.setFileInputFiles",{files:[file],nodeId});
  await wait(()=>contains("ECLEARの読み込みが完了しました"),"ECLEAR CSV parsed");
}
async function preview(){
  await click("体組成の不足項目だけ補完");
  await click("不足項目を確認する");
  await wait(()=>contains("補完対象"),"ECLEAR server-side preview");
}
function countRequests(path){
  return requests.filter(x=>x.method==="POST"&&x.path===path).length;
}
try{
  chrome=spawn(process.env.CHROME_BIN||"/usr/bin/google-chrome",[
    "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
    "--disable-background-networking","--no-first-run","--no-default-browser-check",
    "--no-proxy-server","--ignore-certificate-errors","--remote-debugging-port=0",
    "--user-data-dir="+join(dir,"chrome"),"about:blank"
  ],{stdio:"ignore"});
  let port=0;
  await wait(async()=>{
    try{
      port=Number((await readFile(join(dir,"chrome","DevToolsActivePort"),"utf8")).split("\n")[0]);
      return port>0;
    }catch{return false;}
  },"Chrome DevTools",18000);
  const tabs=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();
  ws=new WebSocket(tabs.find(x=>x.type==="page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    ws.addEventListener("open",resolve,{once:true});
    ws.addEventListener("error",reject,{once:true});
  });
  ws.addEventListener("message",event=>{
    const msg=JSON.parse(event.data);
    if(msg.id){
      const task=pending.get(msg.id);
      if(!task)return;pending.delete(msg.id);
      msg.error?task.reject(Error(JSON.stringify(msg.error))):task.resolve(msg.result??{});
    }else if(msg.method==="Network.requestWillBeSent"){
      const url=new URL(msg.params.request.url);
      if(url.protocol==="https:"||url.protocol==="http:"){
        assert.equal(url.origin,origin,"browser must never request a remote host");
        requests.push({path:url.pathname,method:msg.params.request.method});
      }
    }
  });
  await cmd("Page.enable");
  await cmd("Runtime.enable");
  await cmd("Network.enable");
  await cmd("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await cmd("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
  await cmd("WebAuthn.enable",{enableUI:false});
  const authenticator=await cmd("WebAuthn.addVirtualAuthenticator",{
    options:{
      protocol:"ctap2",transport:"internal",
      hasResidentKey:true,hasUserVerification:true,isUserVerified:true,
      automaticPresenceSimulation:true
    }
  });
  assert(authenticator.authenticatorId,"virtual authenticator was not created");
  const bootstrapCookie=(await readFile(cookieFile,"utf8")).trim();
  assert(/^[0-9a-f]{64}$/.test(bootstrapCookie));
  const cookie=await cmd("Network.setCookie",{
    name:"__Host-life_log_session",value:bootstrapCookie,url:origin+"/",
    path:"/",secure:true,httpOnly:true,sameSite:"Strict"
  });
  assert.equal(cookie.success,true,"synthetic bootstrap Owner session cookie");
  await navigate("/#data");
  await wait(()=>contains("CSVを取り込む"),"authenticated private React asset");
  assert.equal(await js("window.innerWidth"),390);
  await openDetails("ログイン・パスキー設定");
  await wait(()=>contains("パスキーを登録する"),"passkey registration eligible");
  await click("パスキーを登録する");
  await wait(()=>contains("パスキーを登録しました"),"real virtual passkey registration",20000);
  const stored=await cmd("WebAuthn.getCredentials",{authenticatorId:authenticator.authenticatorId});
  assert.equal(stored.credentials?.length,1,"one created resident credential");
  await wait(()=>js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('ログアウトしてパスキーでログイン')&&!x.disabled)"),"logout button ready after registration");
  await click("ログアウトしてパスキーでログイン");
  await wait(()=>contains("パスキーでログインしてください"),"logged out login screen");
  const anonymous=await js("(async()=>{const r=await fetch('/api/dashboard');return r.status})()");
  assert.equal(anonymous,403,"no unauthorized dashboard access after logout");
  await click("パスキーでログイン");
  await wait(()=>contains("今日の状況"),"real WebAuthn login and private SPA",22000);
  const sessionStatus=await js("(async()=>{const r=await fetch('/api/auth/passkey/status',{method:'POST',headers:{'Content-Type':'application/json','X-Life-Log-Intent':'passkey-v1'},body:'{}'});return (await r.json()).passkeySession===true})()");
  assert.equal(sessionStatus,true,"real Worker issued an authenticated passkey session");
  await navigate("/#data");
  await wait(()=>contains("CSVを取り込む"),"data page after passkey login");
  await upload(eclearFile);
  await preview();
  await wait(()=>contains("補完する項目"),"server-side counts");
  assert(await contains("5項目"),"five missing ECLEAR fields, not a mocked preview");
  await js("document.querySelector('.eclear-ack input').click()");
  await click("確認して不足項目を保存する");
  await wait(()=>contains("保存結果を再照合しました"),"real Worker confirm + DB readback",25000);
  assert.equal(countRequests("/api/eclear/enrichment/confirm"),1,"single confirmation");
  // Re-uploading exactly the same CSV cannot create extra measurements.
  await upload(eclearFile);
  await preview();
  assert(await contains("0項目"),"no missing cells on second preview");
  await js("document.querySelector('.eclear-ack input').click()");
  await click("確認して不足項目を保存する");
  await wait(()=>contains("保存結果を再照合しました"),"idempotent unchanged confirm");
  await upload(conflictFile);
  await preview();
  await wait(()=>contains("既存の数値とCSVの数値が異なります"),"real DB conflict");
  assert.equal(await js("[...document.querySelectorAll('button')].some(x=>x.textContent.includes('確認して不足項目を保存する')&&!x.disabled)"),false);
  await upload(normalFile);
  assert(await contains("体重・体脂肪率を通常取込"));
  await click("確認して登録する");
  await wait(()=>contains("登録完了：追加 1件"),"real Worker existing normal import",24000);
  assert.equal(countRequests("/api/import/confirm"),1);
  assert.equal(await js("document.documentElement.scrollWidth>window.innerWidth"),false,"390px overflow");
  console.log(JSON.stringify({
    result:"PASS",realBrowser:true,realLocalWorker:true,realLocalD1:true,
    syntheticCredential:true,chromiumWidth:390,remoteD1:0,
    paths:["register WebAuthn","logout 403","login WebAuthn","passkey-session",
      "enrich five cells","readback","duplicate no-op","conflict blocked","normal import"],
    postCalls:requests.filter(x=>x.method==="POST").length
  }));
}catch(error){
  console.error("Worker+D1+virtual passkey browser E2E failed:",error);
  process.exitCode=1;
}finally{
  try{ws?.close();}catch{}
  chrome?.kill();
  await sleep(550);
  try{await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
  catch(error){console.error("Non-fatal Chromium profile cleanup:",String(error));}
}
