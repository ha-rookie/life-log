import { passkeyRoute } from "./passkey-auth";
import { scrypt as nodeScrypt } from "node:crypto";

type Stmt = { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<{ meta?: { changes?: number } }> } };
export type AuthDb = { prepare(sql: string): Stmt; batch?(statements:unknown[]):Promise<unknown[]> };
export type PasswordAuthEnv = { DB: AuthDb; OWNER_SETUP_CODE?: string; PASSWORD_ONLY_UAT?: string; AUTH_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> } };
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: HEADERS });
const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array) => Array.from(bytes, x => x.toString(16).padStart(2,"0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map(x=>parseInt(x,16)));
async function digest(text: string) { return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))); }
const LEGACY_COLUMN_ITERATIONS = 100000;
const SCRYPT_N = 32768, SCRYPT_R = 8, SCRYPT_P = 3, SCRYPT_MAXMEM = 64 * 1024 * 1024;
// Reuse the WORKHUB scrypt N=32768, r=8, p=3 profile. The UAT password
// verifier is temporary, and is never persisted to D1 or re-enabled after passkey setup.
const UAT_TEMP_SALT = "01224a57fdb3e657d6bf74181e7cb403";
const UAT_TEMP_HASH = "b230594443d6290f0507815bcc6471efa44d8373c3897da5771fad26c4a4c484";
async function passwordHash(password: string, salt: string): Promise<string> {
  if(!/^[a-f0-9]{32}$/.test(salt))throw Error("INVALID_SCRYPT_SALT");
  return new Promise((resolve,reject)=>{
    nodeScrypt(password.normalize("NFC"),fromHex(salt),32,
      {N:SCRYPT_N,r:SCRYPT_R,p:SCRYPT_P,maxmem:SCRYPT_MAXMEM},
      (error,bytes)=>error?reject(error):resolve(toHex(bytes)));
  });
}
function equal(a: string,b: string) {
  if(a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function cookie(request: Request,name: string) {
  const match=request.headers.get("Cookie")?.match(new RegExp("(?:^|;\\s*)"+name+"=([^;]+)"));
  return match?.[1] ?? null;
}
const COOKIE = "__Host-life_log_session";
const SEC = 60*60*24*7;
const setCookie = (token: string,age: number) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function allowed(request: Request) {
  const url=new URL(request.url);
  return url.protocol==="https:" && request.headers.get("Origin")===url.origin
    && request.headers.get("Sec-Fetch-Site")==="same-origin"
    && request.headers.get("X-Life-Log-Intent")==="register-v1"
    && request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json");
}
async function body(request: Request):Promise<Record<string,unknown>|null>{
  if(Number(request.headers.get("Content-Length")||0)>1024)return null;
  const text=await request.text();if(encoder.encode(text).length>1024)return null;
  try {const value:unknown=JSON.parse(text);return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;}
}
async function issue(db:AuthDb):Promise<Response>{
  const token=toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now=Math.floor(Date.now()/1000);
  await db.prepare("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES(?,?,?,?)")
    .bind(await digest(token),"owner",now+SEC,now).run();
  return new Response(JSON.stringify({ok:true}),{headers:{...HEADERS,"Content-Type":"application/json","Set-Cookie":setCookie(token,SEC)}});
}

export async function sessionIsPasskey(request:Request,db:AuthDb):Promise<boolean>{
  const token=cookie(request,COOKIE);
  if(!token||!/^[0-9a-f]{64}$/.test(token))return false;
  const row=await db.prepare("SELECT s.owner_id FROM owner_sessions s JOIN owner_passkey_sessions p ON p.token_hash=s.token_hash WHERE s.token_hash=? AND s.owner_id='owner' AND s.expires_at>?")
    .bind(await digest(token),Math.floor(Date.now()/1000)).first<{owner_id:string}>();
  return row?.owner_id==="owner";
}

export async function issuePasskeySession(db:AuthDb):Promise<Response>{
  if(!db.batch)throw Error("D1 batch required");
  const token=toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash=await digest(token),now=Math.floor(Date.now()/1000);
  await db.batch([
    db.prepare("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES(?,?,?,?)")
      .bind(tokenHash,"owner",now+SEC,now),
    db.prepare("INSERT INTO owner_passkey_sessions(token_hash) VALUES(?)").bind(tokenHash),
  ]);
  return new Response(JSON.stringify({authenticated:true}),{headers:{...HEADERS,"Content-Type":"application/json","Set-Cookie":setCookie(token,SEC)}});
}
export async function sessionOwner(request:Request,db:AuthDb):Promise<"owner"|null>{
  const token=cookie(request,COOKIE);
  if(!token||!/^[0-9a-f]{64}$/.test(token))return null;
  const row=await db.prepare("SELECT owner_id AS owner FROM owner_sessions WHERE token_hash=? AND expires_at>?")
    .bind(await digest(token),Math.floor(Date.now()/1000)).first<{owner:string}>();
  return row?.owner==="owner"?"owner":null;
}
export async function authRoute(request:Request,env:PasswordAuthEnv):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path.startsWith("/api/auth/passkey/"))return passkeyRoute(request,env as never);
  if(request.method!=="POST")return json({error:"METHOD"},405);
  if(!allowed(request))return json({error:"ORIGIN"},403);
  // Password-only internet-facing UAT must have a platform-backed limiter.
  // Missing/broken bindings fail closed before credential lookup or D1 mutation.
  if(env.PASSWORD_ONLY_UAT==="true" && (path==="/api/auth/login" || path==="/api/auth/register")) {
    const ip=request.headers.get("CF-Connecting-IP");
    if(!ip || !env.AUTH_RATE_LIMITER)return json({error:"AUTH_PROTECTION_UNAVAILABLE"},503);
    try {
      const result=await env.AUTH_RATE_LIMITER.limit({key:`${path}:${ip}`});
      if(!result.success)return json({error:"RATE_LIMITED"},429);
      // Also limit the single owner account, so rotating source IPs cannot evade the per-IP gate.
      const account=await env.AUTH_RATE_LIMITER.limit({key:`${path}:owner`});
      if(!account.success)return json({error:"RATE_LIMITED"},429);
    } catch {return json({error:"AUTH_PROTECTION_UNAVAILABLE"},503);}
  }
  try {
    if(path==="/api/auth/logout"){
      const token=cookie(request,COOKIE);
      if(token&&/^[0-9a-f]{64}$/.test(token))await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash=?").bind(await digest(token)).run();
      return new Response(JSON.stringify({ok:true}),{headers:{...HEADERS,"Content-Type":"application/json","Set-Cookie":setCookie("",0)}});
    }
    const data=await body(request);
    if(!data||typeof data.password!=="string"||data.password.length<12||data.password.length>128)return json({error:"INVALID"},422);
    if(path==="/api/auth/register"){
      if(env.PASSWORD_ONLY_UAT==="true")return json({error:"INITIAL_LOGIN_ONLY"},404);
      const setup=env.OWNER_SETUP_CODE;
      if(!setup||setup.length<32)return json({error:"SETUP_NOT_READY"},503);
      if(typeof data.setupCode!=="string"||!equal(await digest(data.setupCode),await digest(setup)))return json({error:"INVALID_CODE"},403);
      const existing=await env.DB.prepare("SELECT owner_id FROM owner_credentials LIMIT 1").bind().first();
      if(existing)return json({error:"ALREADY_REGISTERED"},409);
      // Owner may already exist from imported data. A registered passkey, not
      // the owners row, proves bootstrap was previously completed.
      const passkey=await env.DB.prepare("SELECT credential_id FROM owner_passkey_credentials LIMIT 1").bind().first();
      if(passkey)return json({error:"ALREADY_REGISTERED"},409);
      const salt=toHex(crypto.getRandomValues(new Uint8Array(16)));
      const hash=await passwordHash(data.password,salt);
      await env.DB.prepare("INSERT OR IGNORE INTO owners(id,created_at) VALUES(?,?)").bind("owner",new Date().toISOString()).run();
      const result=await env.DB.prepare("INSERT OR IGNORE INTO owner_credentials(owner_id,password_salt,password_hash,iterations,created_at) VALUES(?,?,?,?,?)")
        .bind("owner",salt,`scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${hash}`,LEGACY_COLUMN_ITERATIONS,new Date().toISOString()).run();
      if(result.meta?.changes!==1)return json({error:"ALREADY_REGISTERED"},409);
      return issue(env.DB);
    }
    if(path==="/api/auth/login"){
      if(data.username!==undefined&&data.username!=="owner")return json({error:"INVALID_CREDENTIALS"},401);
      if(env.PASSWORD_ONLY_UAT==="true"){
        // First-use personal UAT: no password DB enrollment, no legacy verifier path.
        // Once any passkey exists, the temporary password is immediately unusable.
        if(new URL(request.url).origin!=="https://life-log-uat.ha-rookie.workers.dev")
          return json({error:"INVALID_CREDENTIALS"},401);
        const passkey=await env.DB.prepare("SELECT credential_id FROM owner_passkey_credentials LIMIT 1").bind().first();
        if(passkey)return json({error:"INVALID_CREDENTIALS"},401);
        const candidate=await passwordHash(data.password,UAT_TEMP_SALT);
        if(!equal(candidate,UAT_TEMP_HASH))return json({error:"INVALID_CREDENTIALS"},401);
        // Password session only: existing owners row may already exist from previous UAT.
        await env.DB.prepare("INSERT OR IGNORE INTO owners(id,created_at) VALUES(?,?)")
          .bind("owner",new Date().toISOString()).run();
        return issue(env.DB);
      }
      const cred=await env.DB.prepare("SELECT password_salt AS salt,password_hash AS hash FROM owner_credentials WHERE owner_id=?")
        .bind("owner").first<{salt:string;hash:string}>();
      const match=cred?.hash.match(/^scrypt\\$32768\\$8\\$3\\$([a-f0-9]{64})$/);
      if(!cred||!match)return json({error:"INVALID_CREDENTIALS"},401);
      const candidate=await passwordHash(data.password,cred.salt);
      if(!equal(candidate,match[1]))return json({error:"INVALID_CREDENTIALS"},401);
      return issue(env.DB);
    }
    return json({error:"NOT_FOUND"},404);
  }catch{return json({error:"UNAVAILABLE"},503);}
}
