import { useEffect, useState } from "react";

type AuthStatus={registered:boolean;passwordEnabled:boolean;passkeySession:boolean};
type Options={flowId:string;options:unknown};
const call=async(path:string,data:unknown)=>{
  const response=await fetch("/api/auth/passkey/"+path,{
    method:"POST",credentials:"same-origin",cache:"no-store",
    headers:{"Content-Type":"application/json","X-Life-Log-Intent":"passkey-v1"},
    body:JSON.stringify(data),
  });
  if(!response.ok)throw new Error("HTTP "+response.status);
  return response.json() as Promise<Record<string,unknown>>;
};
function supported(){
  return window.isSecureContext&&typeof PublicKeyCredential!=="undefined"&&
    typeof PublicKeyCredential.parseCreationOptionsFromJSON==="function"&&
    typeof navigator.credentials?.create==="function";
}
export function PasskeySetup(){
  const [status,setStatus]=useState<AuthStatus|null>(null);
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  async function refresh(){
    const result=await call("status",{}) as AuthStatus;
    setStatus(result);
  }
  useEffect(()=>{void refresh().catch(()=>setNotice("認証設定を取得できません。"));},[]);
  async function register(){
    if(busy)return;setBusy(true);setNotice("");
    try{
      if(!supported())throw Error("Unsupported browser");
      const flow=await call("register/options",{}) as Options;
      const options=PublicKeyCredential.parseCreationOptionsFromJSON(
        flow.options as PublicKeyCredentialCreationOptionsJSON);
      const credential=await navigator.credentials.create({publicKey:options});
      if(!credential||!("toJSON" in credential)||typeof credential.toJSON!=="function")
        throw Error("No credential");
      const done=await call("register/verify",{flowId:flow.flowId,credential:credential.toJSON()});
      if(done.registered!==true)throw Error("Registration failed");
      setNotice("パスキーを登録しました。いったんログアウトし、パスキーでログインしてください。");
      await refresh();
    }catch{
      setNotice("パスキーを登録できませんでした。端末と画面ロック設定を確認してください。");
    }finally{setBusy(false);}
  }
  async function logout(){
    if(busy)return;setBusy(true);
    try{
      const response=await fetch("/api/auth/logout",{method:"POST",credentials:"same-origin",
        headers:{"Content-Type":"application/json","X-Life-Log-Intent":"register-v1"},
        body:"{}"});
      if(!response.ok)throw Error("Logout failed");
      window.location.assign("/login");
    }catch{setNotice("ログアウトできませんでした。");setBusy(false);}
  }
  async function disable(){
    if(busy)return;setBusy(true);setNotice("");
    try{
      const data=await call("disable-password",{});
      if(data.passwordDisabled!==true)throw Error("Not disabled");
      setNotice("仮パスワード認証を無効化しました。今後はパスキーだけでログインできます。");
      await refresh();
    }catch{setNotice("無効化できませんでした。パスキーで再ログインした状態か確認してください。");}
    finally{setBusy(false);}
  }
  return <section className="panel" aria-labelledby="passkey-title">
    <h2 id="passkey-title">ログイン設定（Android UAT）</h2>
    {!status&&<p>認証設定を確認中…</p>}
    {status&&!status.registered&&<p>
      <button type="button" disabled={busy} onClick={()=>void register()}>パスキーを登録する</button>
    </p>}
    {status&&status.registered&&!status.passkeySession&&<p>
      パスキー登録済み。パスキーで再ログインした後、仮パスワードを無効化できます。
      <button type="button" disabled={busy} onClick={()=>void logout()}>ログアウトしてパスキーでログイン</button>
    </p>}
    {status&&status.registered&&status.passkeySession&&status.passwordEnabled&&<p>
      パスキーでのログインを確認しました。
      <button type="button" disabled={busy} onClick={()=>void disable()}>仮パスワード認証を無効化する</button>
    </p>}
    {status&&status.registered&&status.passkeySession&&!status.passwordEnabled&&
      <p>パスキー認証が有効です。仮パスワード認証は無効です。</p>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
