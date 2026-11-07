export function loginScreen():Response {
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ライフログ｜ログイン</title><style>:root{font-family:system-ui;color-scheme:dark;background:#101827;color:white}body{min-height:100vh;display:grid;place-items:center;margin:0;padding:20px}main{width:min(100%,400px);background:#1c293a;border-radius:20px;padding:28px}input,button{box-sizing:border-box;width:100%;padding:14px;font-size:16px;border-radius:9px}input{background:#101827;color:white;border:1px solid #718096}button{margin-top:18px;background:#65b5ff;border:0;color:#071320;font-weight:700}label{display:block;margin:16px 0 8px}a{color:#8fcaff}#status{min-height:24px}</style></head><body><main><h1>ライフログ</h1><form id="login"><label for="username">ユーザーID</label><input id="username" type="text" autocomplete="username" value="owner" required><label for="password">仮パスワード</label><input id="password" type="password" autocomplete="current-password" minlength="12" required><button>ログイン</button><p id="status" role="status"></p></form><button type="button" id="passkey">パスキーでログイン</button><p>初めて利用する場合は <a href="/register">初回登録</a></p></main><script>document.getElementById('login').addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('status');status.textContent='確認中…';try{const res=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Life-Log-Intent':'register-v1'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});if(res.ok){location.replace('/');return}status.textContent='ログインできませんでした'}catch{status.textContent='通信に失敗しました'}})
document.getElementById('passkey').addEventListener('click',async()=>{
 const status=document.getElementById('status');status.textContent='パスキーで認証中…';
 try{
  if(!window.isSecureContext||typeof PublicKeyCredential==='undefined'||
   typeof PublicKeyCredential.parseRequestOptionsFromJSON!=='function')
   throw Error('Unsupported browser');
  const post=async(path,body)=>{
   const res=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json','X-Life-Log-Intent':'passkey-v1'},
    body:JSON.stringify(body)});
   if(!res.ok)throw Error('Request rejected');
   return res.json();
  };
  const flow=await post('/api/auth/passkey/login/options',{});
  const options=PublicKeyCredential.parseRequestOptionsFromJSON(flow.options);
  const credential=await navigator.credentials.get({publicKey:options});
  if(!credential||typeof credential.toJSON!=='function')throw Error('Credential unavailable');
  const done=await post('/api/auth/passkey/login/verify',{flowId:flow.flowId,credential:credential.toJSON()});
  if(done.authenticated!==true)throw Error('Login not confirmed');
  location.replace('/');
 }catch{status.textContent='パスキーでログインできませんでした。端末のパスキー設定を確認してください。'}
});
</script></body></html>`;
 return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'","X-Robots-Tag":"noindex, nofollow"}});
}
