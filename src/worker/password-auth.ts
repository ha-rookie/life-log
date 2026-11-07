import { passkeyRoute } from "./passkey-auth";

type Stmt = { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<{ meta?: { changes?: number } }> } };
export type AuthDb = { prepare(sql: string): Stmt; batch?(statements:unknown[]):Promise<unknown[]> };
export type PasswordAuthEnv = { DB: AuthDb; OWNER_SETUP_CODE?: string; PASSWORD_ONLY_UAT?: string; AUTH_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> } };
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: HEADERS });
const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array) => Array.from(bytes, x => x.toString(16).padStart(2,"0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map(x=>parseInt(x,16)));
async function digest(text: string) { return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))); }
const ITERATIONS = 210000;
async function passwordHash(password: string, salt: string, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2",salt:fromHex(salt),iterations,hash:"SHA-256"},key,256);
  return toHex(new Uint8Array(bits));
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
      const setup=env.OWNER_SETUP_CODE;
      if(!setup||setup.length<32)return json({error:"SETUP_NOT_READY"},503);
      if(typeof data.setupCode!=="string"||!equal(await digest(data.setupCode),await digest(setup)))return json({error:"INVALID_CODE"},403);
      const existing=await env.DB.prepare("SELECT id FROM owners WHERE id='owner'").bind().first();
      if(existing)return json({error:"ALREADY_REGISTERED"},409);
      const salt=toHex(crypto.getRandomValues(new Uint8Array(16)));
      const hash=await passwordHash(data.password,salt);
      await env.DB.prepare("INSERT OR IGNORE INTO owners(id,created_at) VALUES(?,?)").bind("owner",new Date().toISOString()).run();
      const result=await env.DB.prepare("INSERT OR IGNORE INTO owner_credentials(owner_id,password_salt,password_hash,iterations,created_at) VALUES(?,?,?,?,?)")
        .bind("owner",salt,hash,ITERATIONS,new Date().toISOString()).run();
      if(result.meta?.changes!==1)return json({error:"ALREADY_REGISTERED"},409);
      return issue(env.DB);
    }
    if(path==="/api/auth/login"){
      if(data.username!==undefined&&data.username!=="owner")return json({error:"INVALID_CREDENTIALS"},401);
      const cred=await env.DB.prepare("SELECT password_salt AS salt,password_hash AS hash,iterations FROM owner_credentials WHERE owner_id=?")
        .bind("owner").first<{salt:string;hash:string;iterations:number}>();
      if(!cred)return json({error:"INVALID_CREDENTIALS"},401);
      const hash=await passwordHash(data.password,cred.salt,cred.iterations);
      if(!equal(hash,cred.hash))return json({error:"INVALID_CREDENTIALS"},401);
      return issue(env.DB);
    }
    return json({error:"NOT_FOUND"},404);
  }catch{return json({error:"UNAVAILABLE"},503);}
}
