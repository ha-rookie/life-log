/**
 * Owner session contract shared with WebAuthn. Password enrollment was retired
 * after the successful 2026-11-08 Android passkey UAT.
 * No temporary password verifier, KDF, or login/re-enrollment fallback remains.
 */
import { passkeyRoute } from "./passkey-auth";

type Stmt = { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<{ meta?: { changes?: number } }> } };
export type AuthDb = { prepare(sql: string): Stmt; batch?(statements:unknown[]):Promise<unknown[]> };
export type PasswordAuthEnv = {
  DB: AuthDb;
  PASSWORD_ONLY_UAT?: string;
  AUTH_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: HEADERS });
const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array) => Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
const digest = async (text: string) =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(text))));

const COOKIE = "__Host-life_log_session";
const SEC = 60*60*24*7;
const setCookie = (token: string,age: number) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function cookie(request: Request,name: string) {
  const match=request.headers.get("Cookie")?.match(new RegExp("(?:^|;\\s*)"+name+"=([^;]+)"));
  return match?.[1] ?? null;
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
  // No password-based registration, verification, or recovery route remains.
  if(path==="/api/auth/login"||path==="/api/auth/register")
    return json({error:"PASSWORD_AUTH_RETIRED"},410);
  if(path!=="/api/auth/logout")return json({error:"NOT_FOUND"},404);
  if(request.method!=="POST")return json({error:"METHOD"},405);
  const url=new URL(request.url);
  if(url.protocol!=="https:"||request.headers.get("Origin")!==url.origin||
      request.headers.get("Sec-Fetch-Site")!=="same-origin"||
      request.headers.get("X-Life-Log-Intent")!=="register-v1"||
      !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
    return json({error:"ORIGIN"},403);
  try{
    const token=cookie(request,COOKIE);
    if(token&&/^[0-9a-f]{64}$/.test(token))
      await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash=?")
        .bind(await digest(token)).run();
    return new Response(JSON.stringify({ok:true}),{headers:{
      ...HEADERS,"Content-Type":"application/json","Set-Cookie":setCookie("",0)
    }});
  }catch{return json({error:"UNAVAILABLE"},503);}
}
