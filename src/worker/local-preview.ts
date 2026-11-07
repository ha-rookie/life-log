/** Device-only Android preview. This endpoint never touches D1 or protected APIs. */
export function localPreview(): Response {
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#102a38">
<title>ライフログ｜今日の記録</title>
<style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#eaf3f6;background:#091b26;color-scheme:dark}
*{box-sizing:border-box}body{margin:0}.wrap{max-width:580px;margin:auto;padding:24px 18px 64px}
small,.muted{color:#a4b7c0}h1{font-size:30px;margin:8px 0}h2{font-size:19px;margin:0 0 15px}
.lead{line-height:1.7;color:#c5d7dc;margin:8px 0 24px}.card{background:#142d3b;border:1px solid #305064;border-radius:18px;padding:20px;margin:14px 0}
label{display:block;font-size:14px;color:#c3d8df;margin:12px 0 6px}input{display:block;width:100%;font-size:18px;padding:12px;background:#0b202c;border:1px solid #56717c;border-radius:10px;color:white}
button{font-size:16px;font-weight:650;padding:13px 16px;border:0;border-radius:11px;background:#65dbc0;color:#09222b;cursor:pointer}
button.secondary{background:#294857;color:#e7f7f6}button.danger{background:#52333d;color:#ffe3e7;padding:7px 10px;font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px}.notice{border-left:3px solid #65dbc0;padding:10px 13px;background:#163743;line-height:1.6}
li{padding:11px 0;border-bottom:1px solid #345060;display:flex;align-items:center;justify-content:space-between;gap:8px}
ul{padding:0;list-style:none}strong.num{font-size:28px;color:#65dbc0}footer{margin-top:24px;font-size:12px;line-height:1.7;color:#afc1c7}
</style></head><body><div class="wrap">
<small>PERSONAL LIFE LOG · ANDROID PREVIEW</small><h1>今日の記録</h1>
<p class="lead">まずはAndroidで使える画面から。体重と歩数を簡単に記録できます。</p>
<div class="notice">このプレビューの記録は<b>この端末のブラウザ内だけ</b>に保存します。Cloudflare D1には送信しません。端末変更やブラウザデータ削除で消えるため、JSONバックアップを利用してください。</div>
<section class="card"><h2>体重を記録</h2><form id="weight-form">
<label for="weight-date">測定日時</label><input id="weight-date" type="datetime-local" required>
<label for="weight-value">体重（kg）</label><input id="weight-value" type="number" min="0.1" max="499.9" step="0.1" inputmode="decimal" placeholder="例：78.5" required>
<div class="actions"><button type="submit">体重を保存</button></div></form></section>
<section class="card"><h2>歩数を記録</h2><form id="steps-form">
<label for="steps-date">日付</label><input id="steps-date" type="date" required>
<label for="steps-value">歩数</label><input id="steps-value" type="number" min="0" max="300000" step="1" inputmode="numeric" placeholder="例：6500" required>
<div class="actions"><button type="submit">歩数を保存</button></div></form></section>
<section class="card"><h2>記録一覧</h2><p id="count" class="muted">読み込み中</p><ul id="records"></ul>
<div class="actions"><button id="export" class="secondary" type="button">JSONバックアップを保存</button></div></section>
<p id="status" role="status" aria-live="polite" class="muted"></p>
<footer>本人認証付きクラウド保存は準備中です。この画面では外部API・D1への書き込みは行いません。共有端末での利用は避けてください。</footer>
</div><script>
(()=>{
"use strict";
const KEY="life-log-android-preview-v1";
const el=id=>document.getElementById(id);
const now=new Date(),jst=new Date(now.getTime()+9*3600000).toISOString();
el("weight-date").value=jst.slice(0,16);el("steps-date").value=jst.slice(0,10);
el("steps-date").max=jst.slice(0,10);el("weight-date").max=jst.slice(0,16);
let rows=[];
try{const saved=JSON.parse(localStorage.getItem(KEY)||"[]");if(Array.isArray(saved))rows=saved.filter(x=>x&&["weight","steps"].includes(x.type)&&typeof x.date==="string"&&typeof x.value==="number").slice(0,10000)}catch{}
function store(){localStorage.setItem(KEY,JSON.stringify(rows))}
function show(){const ul=el("records");ul.replaceChildren();el("count").textContent=rows.length+"件";
for(const item of [...rows].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,100)){
const li=document.createElement("li"),span=document.createElement("span"),btn=document.createElement("button");
span.textContent=item.date.replace("T"," ")+" · "+(item.type==="weight"?item.value.toFixed(1)+" kg":item.value.toLocaleString()+" 歩");
btn.type="button";btn.className="danger";btn.textContent="取消";
btn.addEventListener("click",()=>{if(!confirm("この記録を取り消しますか？"))return;rows=rows.filter(x=>x.id!==item.id);try{store();show();el("status").textContent="取り消しました"}catch{el("status").textContent="保存に失敗しました"}});
li.append(span,btn);ul.append(li)}}
function add(type,date,value){if(!date||!Number.isFinite(value)||rows.length>=10000)return;
const item={id:crypto.randomUUID(),type,date,value};rows.push(item);
try{store();show();el("status").textContent="この端末に保存しました"}catch{rows.pop();el("status").textContent="端末への保存に失敗しました。空き容量やブラウザ設定を確認してください"}}
el("weight-form").addEventListener("submit",e=>{e.preventDefault();const d=el("weight-date").value,v=Number(el("weight-value").value);
if(!d||new Date(d).getTime()>Date.now()+60000||!(v>0&&v<500))return;add("weight",d,v);});
el("steps-form").addEventListener("submit",e=>{e.preventDefault();const d=el("steps-date").value,v=Number(el("steps-value").value);
if(!d||d>new Date(Date.now()+9*3600000).toISOString().slice(0,10)||!Number.isSafeInteger(v)||v<0||v>300000)return;add("steps",d,v);});
el("export").addEventListener("click",()=>{const blob=new Blob([JSON.stringify({format:"life-log-local-preview-v1",exportedAt:new Date().toISOString(),records:rows},null,2)],{type:"application/json"});
const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="life-log-backup-"+new Date().toISOString().slice(0,10)+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),3000)});
show();
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
