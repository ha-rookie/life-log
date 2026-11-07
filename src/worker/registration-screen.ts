/** Initial owner enrollment screen. The server will only accept a one-time setup code. */
export function registrationScreen(): Response {
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>ライフログ｜初期登録</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#101827;color:#f4f6fb}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}
main{width:min(100%,420px);background:#1c293a;padding:28px;border-radius:20px}
h1{font-size:1.5rem;margin:0 0 8px}p{color:#b9c6d8;line-height:1.6}
label{display:block;margin:20px 0 6px;font-weight:600}
input{width:100%;font-size:16px;padding:13px;border:1px solid #718096;border-radius:9px;background:#101827;color:white}
button{margin-top:24px;width:100%;padding:14px;background:#65b5ff;color:#071320;border:0;border-radius:10px;font-weight:700;font-size:16px}
button:disabled{opacity:.5}#status{min-height:24px}small{color:#b9c6d8}
</style></head><body><main>
<h1>ライフログ 初期登録</h1><p>最初の利用者アカウントを登録します。</p>
<form id="register">
<label for="setup">初回登録コード</label><input id="setup" name="setup" type="password" autocomplete="off" required minlength="16">
<label for="password">ログイン用パスワード</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128">
<label for="confirm">パスワード（確認）</label><input id="confirm" type="password" autocomplete="new-password" required minlength="12">
<small>12文字以上。登録コードは管理者が別途発行します。</small>
<button type="submit">アカウントを登録</button><p id="status" role="status" aria-live="polite"></p>
</form></main><script>
const form=document.getElementById('register'),status=document.getElementById('status');
form.addEventListener('submit',async e=>{
 e.preventDefault();const setup=form.setup.value,password=form.password.value;
 if(password!==document.getElementById('confirm').value){status.textContent='パスワードが一致しません';return}
 const button=form.querySelector('button');button.disabled=true;status.textContent='登録中…';
 try{const res=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json','X-Life-Log-Intent':'register-v1'},credentials:'same-origin',body:JSON.stringify({setupCode:setup,password})});
 if(res.ok){status.textContent='登録が完了しました。ログイン画面に進みます。';form.reset();}
 else{status.textContent=res.status===409?'すでに管理者が登録されています':res.status===503?'登録機能の準備中です':'登録できませんでした。コードを確認してください'}
 }catch{status.textContent='通信に失敗しました'}finally{button.disabled=false}
});
</script></body></html>`;
  return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'","X-Robots-Tag":"noindex, nofollow"}});
}
