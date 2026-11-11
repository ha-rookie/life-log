/**
 * Owner-only WebAuthn for the personal Android UAT. Reuses the existing
 * owner_sessions cookie; no LINE, invitations, external identity, or bootstrap secret.
 * Cryptographic challenge, RP, origin and UV checks follow mahjong-score PR #358.
 */
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON, AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { sessionOwner, issuePasskeySession, sessionIsPasskey } from "./password-auth";

type Statement = { bind(...args:unknown[]): {
  first<T>():Promise<T|null>;run():Promise<{meta?:{changes?:number}}> } };
type DB = { prepare(sql:string):Statement;batch(statements:unknown[]):Promise<unknown[]> };
type Env = {
  DB:DB;PASSWORD_ONLY_UAT?:string;
  // Exact loopback TLS synthetic browser test only. Never deploy this flag.
  PASSKEY_LOCAL_E2E_ONLY?:string;
  AUTH_RATE_LIMITER?:{limit(input:{key:string}):Promise<{success:boolean}>};
};
const ORIGIN="https://life-log-uat.ha-rookie.workers.dev";
const RP_ID="life-log-uat.ha-rookie.workers.dev";
const LOCAL_E2E_ORIGIN="https://localhost:8787";
type PasskeyTarget={origin:string;rpID:string};
function targetFor(request:Request,env:Env):PasskeyTarget|null{
  if(env.PASSKEY_LOCAL_E2E_ONLY==="true"){
    // Fail closed outside the exact loopback TLS test host and port.
    return new URL(request.url).origin===LOCAL_E2E_ORIGIN
      ? {origin:LOCAL_E2E_ORIGIN,rpID:"localhost"} : null;
  }
  return {origin:ORIGIN,rpID:RP_ID};
}
const TTL_SECONDS=120;
const HEADERS={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const encoder=new TextEncoder();
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:HEADERS});
const base64url=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes))
  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const decode=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")
  .padEnd(Math.ceil(value.length/4)*4,"=")),x=>x.charCodeAt(0));
const canonical=(value:unknown):value is string=>typeof value==="string"&&
  /^[a-zA-Z0-9_-]{1,2048}$/.test(value)&&value.length%4!==1&&base64url(decode(value))===value;
const hash=async(v:string)=>base64url(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(v))));
type Challenge={id:string;challenge:string;expiresAt:number};
type Stored={challengeHash:string};
const now=()=>Math.floor(Date.now()/1000);
async function issueChallenge(db:DB,purpose:"register"|"login"):Promise<Challenge>{
  const id=crypto.randomUUID(),challenge=base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt=now()+TTL_SECONDS;
  await db.prepare("INSERT INTO owner_passkey_challenges(id,challenge_hash,purpose,expires_at) VALUES(?,?,?,?)")
    .bind(id,await hash(challenge),purpose,expiresAt).run();
  return {id,challenge,expiresAt};
}
const validFlow=(id:unknown):id is string=>typeof id==="string"&&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
async function readChallenge(db:DB,id:string,purpose:"register"|"login"):Promise<Stored|null>{
  return db.prepare("SELECT challenge_hash AS challengeHash FROM owner_passkey_challenges WHERE id=? AND purpose=? AND consumed_at IS NULL AND expires_at>?")
    .bind(id,purpose,now()).first<Stored>();
}
async function consume(db:DB,id:string,purpose:"register"|"login",verifiedChallenge:string):Promise<boolean>{
  const row=await db.prepare("UPDATE owner_passkey_challenges SET consumed_at=? WHERE id=? AND purpose=? AND challenge_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING id")
    .bind(now(),id,purpose,await hash(verifiedChallenge),now()).first<{id:string}>();
  return row?.id===id;
}
function extractedChallenge(response:{response:{clientDataJSON:string}}):string{
  const data=JSON.parse(new TextDecoder().decode(decode(response.response.clientDataJSON))) as {challenge?:unknown};
  if(!canonical(data.challenge))throw Error("invalid challenge");
  return data.challenge;
}
const validRequest=(request:Request,target:PasskeyTarget)=>{
  const u=new URL(request.url);
  return u.origin===target.origin && request.headers.get("Origin")===target.origin
    && request.headers.get("Sec-Fetch-Site")==="same-origin"
    && request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")
    && request.headers.get("X-Life-Log-Intent")==="passkey-v1";
};
async function readBody(request:Request):Promise<Record<string,unknown>|null>{
  if(Number(request.headers.get("Content-Length")||0)>24000)return null;
  const text=await request.text();
  if(encoder.encode(text).length>24000)return null;
  try{const data:unknown=JSON.parse(text);return data&&typeof data==="object"&&!Array.isArray(data)?data as Record<string,unknown>:null;}
  catch{return null;}
}
async function limit(request:Request,env:Env,target:PasskeyTarget):Promise<boolean>{
  // Local Workerd lacks a real Cloudflare connecting IP. Still use the
  // configured limiter with a loopback test key instead of bypassing it.
  const ip=request.headers.get("CF-Connecting-IP")
    ??(env.PASSKEY_LOCAL_E2E_ONLY==="true"&&target.origin===LOCAL_E2E_ORIGIN
      ?"127.0.0.1":null);
  if(!ip||!env.AUTH_RATE_LIMITER)return false;
  try{
    const perIp=await env.AUTH_RATE_LIMITER.limit({key:"passkey:"+ip});
    const perAccount=await env.AUTH_RATE_LIMITER.limit({key:"passkey:owner"});
    return perIp.success&&perAccount.success;
  }catch{return false;}
}
async function registerOptions(env:Env,target:PasskeyTarget){
  const exists=await env.DB.prepare("SELECT credential_id FROM owner_passkey_credentials LIMIT 1").bind().first();
  if(exists)return json({error:"PASSKEY_ALREADY_REGISTERED"},409);
  const challenge=await issueChallenge(env.DB,"register");
  const options=await generateRegistrationOptions({
    rpName:"ライフログ",rpID:target.rpID,userName:"owner",
    userID:encoder.encode("life-log:owner"),
    challenge:decode(challenge.challenge),attestationType:"none",
    supportedAlgorithmIDs:[-7],timeout:TTL_SECONDS*1000,
    authenticatorSelection:{residentKey:"required",userVerification:"required"},
  });
  if(options.challenge!==challenge.challenge)throw Error("challenge mismatch");
  return json({flowId:challenge.id,options,expiresAt:challenge.expiresAt});
}
async function registerVerify(env:Env,data:Record<string,unknown>,target:PasskeyTarget){
  if(!validFlow(data.flowId)||!data.credential||typeof data.credential!=="object"||Array.isArray(data.credential))
    return json({error:"INVALID"},400);
  const response=data.credential as RegistrationResponseJSON;
  if(!canonical(response.id))return json({error:"INVALID"},400);
  const pending=await readChallenge(env.DB,data.flowId,"register");
  if(!pending)return json({error:"CHALLENGE_EXPIRED"},409);
  const result=await verifyRegistrationResponse({
    response,
    expectedChallenge:async value=>canonical(value)&&await hash(value)===pending.challengeHash,
    expectedOrigin:target.origin,expectedRPID:target.rpID,
    requireUserVerification:true,supportedAlgorithmIDs:[-7],
  });
  const c=result.registrationInfo?.credential;
  if(!result.verified||!c||c.id!==response.id||!c.publicKey?.byteLength
    ||!Number.isSafeInteger(c.counter)||c.counter<0)return json({error:"INVALID_PASSKEY"},403);
  if(!await consume(env.DB,data.flowId,"register",extractedChallenge(response)))
    return json({error:"CHALLENGE_USED"},409);
  // Unique owner credential, and unique credential ID, enforced by D1.
  const existing=await env.DB.prepare("SELECT credential_id FROM owner_passkey_credentials LIMIT 1").bind().first();
  if(existing)return json({error:"PASSKEY_ALREADY_REGISTERED"},409);
  await env.DB.prepare("INSERT INTO owner_passkey_credentials(credential_id,public_key,sign_count,transports,created_at) VALUES(?,?,?,?,?)")
    .bind(c.id,c.publicKey,c.counter,JSON.stringify(c.transports??[]),new Date().toISOString()).run();
  return json({registered:true},201);
}
async function loginOptions(env:Env,target:PasskeyTarget){
  const challenge=await issueChallenge(env.DB,"login");
  const options=await generateAuthenticationOptions({
    rpID:target.rpID,challenge:decode(challenge.challenge),
    allowCredentials:[],userVerification:"required",timeout:TTL_SECONDS*1000,
  });
  if(options.challenge!==challenge.challenge)throw Error("challenge mismatch");
  return json({flowId:challenge.id,options,expiresAt:challenge.expiresAt});
}
async function loginVerify(env:Env,data:Record<string,unknown>,target:PasskeyTarget){
  if(!validFlow(data.flowId)||!data.credential||typeof data.credential!=="object"||Array.isArray(data.credential))
    return json({error:"INVALID"},400);
  const response=data.credential as AuthenticationResponseJSON;
  if(!canonical(response.id))return json({error:"INVALID"},400);
  const pending=await readChallenge(env.DB,data.flowId,"login");
  if(!pending)return json({error:"CHALLENGE_EXPIRED"},409);
  const row=await env.DB.prepare("SELECT credential_id AS credentialId,public_key AS publicKey,sign_count AS signCount,transports FROM owner_passkey_credentials WHERE credential_id=?")
    .bind(response.id).first<{credentialId:string;publicKey:Uint8Array|ArrayBuffer;signCount:number;transports:string}>();
  if(!row||row.credentialId!==response.id||!Number.isSafeInteger(row.signCount)||row.signCount<0)
    return json({error:"UNKNOWN_PASSKEY"},401);
  const checked=await verifyAuthenticationResponse({
    response,
    expectedChallenge:async value=>canonical(value)&&await hash(value)===pending.challengeHash,
    expectedOrigin:target.origin,expectedRPID:target.rpID,
    credential:{
      id:row.credentialId,publicKey:new Uint8Array(row.publicKey),
      counter:row.signCount,
      transports:JSON.parse(row.transports) as AuthenticatorTransport[],
    },
    requireUserVerification:true,
  });
  if(!checked.verified||!checked.authenticationInfo?.userVerified)return json({error:"INVALID_PASSKEY"},403);
  const counter=checked.authenticationInfo.newCounter;
  if(!Number.isSafeInteger(counter)||counter<0)return json({error:"INVALID_PASSKEY"},403);
  if(!await consume(env.DB,data.flowId,"login",extractedChallenge(response)))
    return json({error:"CHALLENGE_USED"},409);
  const updated=await env.DB.prepare("UPDATE owner_passkey_credentials SET sign_count=?,last_used_at=? WHERE credential_id=? AND sign_count=?")
    .bind(counter,new Date().toISOString(),row.credentialId,row.signCount).run();
  if(updated.meta?.changes!==1)return json({error:"CONCURRENT_AUTH"},409);
  return issuePasskeySession(env.DB);
}
async function status(request:Request,env:Env){
  if(await sessionOwner(request,env.DB)!=="owner")return json({error:"UNAUTHORIZED"},401);
  const registered=await env.DB.prepare("SELECT credential_id FROM owner_passkey_credentials LIMIT 1").bind().first();
  const password=await env.DB.prepare("SELECT owner_id FROM owner_credentials WHERE owner_id='owner'").bind().first();
  return json({registered:Boolean(registered),passwordEnabled:Boolean(password),
    passkeySession:await sessionIsPasskey(request,env.DB)});
}
async function disablePassword(request:Request,env:Env){
  if(await sessionOwner(request,env.DB)!=="owner"||!await sessionIsPasskey(request,env.DB))
    return json({error:"PASSKEY_LOGIN_REQUIRED"},403);
  const registered=await env.DB.prepare("SELECT credential_id FROM owner_passkey_credentials LIMIT 1").bind().first();
  if(!registered)return json({error:"PASSKEY_NOT_REGISTERED"},409);
  // D1.batch is transactional. Revokes all prior password sessions atomically
  // with password deletion, while preserving passkey sessions.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM owner_credentials WHERE owner_id='owner'").bind(),
    env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash NOT IN (SELECT token_hash FROM owner_passkey_sessions)").bind(),
  ]);
  return json({passwordDisabled:true});
}
export async function passkeyRoute(request:Request,env:Env):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(env.PASSWORD_ONLY_UAT!=="true")return json({error:"NOT_AVAILABLE"},404);
  if(request.method!=="POST")return json({error:"METHOD"},405);
  const target=targetFor(request,env);
  if(!target||!validRequest(request,target))return json({error:"ORIGIN"},403);
  const publicRoute=path==="/api/auth/passkey/login/options"||path==="/api/auth/passkey/login/verify";
  if(publicRoute && !await limit(request,env,target))return json({error:"AUTH_PROTECTION_UNAVAILABLE"},503);
  const data=await readBody(request);
  if(!data)return json({error:"INVALID"},400);
  try{
    if(path==="/api/auth/passkey/login/options")return loginOptions(env,target);
    if(path==="/api/auth/passkey/login/verify")return loginVerify(env,data,target);
    if(path==="/api/auth/passkey/status")return status(request,env);
    if(path==="/api/auth/passkey/disable-password")return disablePassword(request,env);
    if(await sessionOwner(request,env.DB)!=="owner")return json({error:"UNAUTHORIZED"},401);
    if(path==="/api/auth/passkey/register/options")return registerOptions(env,target);
    if(path==="/api/auth/passkey/register/verify")return registerVerify(env,data,target);
    return json({error:"NOT_FOUND"},404);
  }catch{return json({error:"UNAVAILABLE"},503);}
}
