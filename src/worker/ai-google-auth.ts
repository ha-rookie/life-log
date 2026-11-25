/**
 * Phase B3 unregistered, synthetic-only service identity boundary.
 * No token endpoint fetch, key loading, Worker binding, or real credentials here.
 * Any transport must be supplied explicitly by a later separately reviewed caller.
 */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token" as const;
export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;
export const GOOGLE_SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets" as const;
export type GoogleScope = typeof GOOGLE_DRIVE_FILE_SCOPE|typeof GOOGLE_SPREADSHEETS_SCOPE;
export type ServiceIdentity = {
  clientEmail:string;
  privateKey:CryptoKey;
  scope:GoogleScope;
  /** Reject any token audience substitution rather than following an input URL. */
  audience?:string;
};
export type TokenExchangeRequest = {
  endpoint:typeof GOOGLE_TOKEN_ENDPOINT;
  contentType:"application/x-www-form-urlencoded";
  body:string;
};
export interface TokenTransport {
  exchange(request:TokenExchangeRequest):Promise<{status:number;json:unknown}>;
}
export type EphemeralToken={accessToken:string;expiresAtMs:number;scope:GoogleScope};

const enc=new TextEncoder();
const b64url=(data:Uint8Array):string=>{
  let binary="";
  for(const b of data)binary+=String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/u,"");
};
const encoded=(value:unknown)=>b64url(enc.encode(JSON.stringify(value)));
const validClock=(nowMs:number)=>Number.isSafeInteger(nowMs)&&
  nowMs>=Date.UTC(2020,0,1)&&nowMs<Date.UTC(2100,0,1);
function validateIdentity(config:ServiceIdentity):void{
  if(!config||typeof config.clientEmail!=="string"||
    !/^[a-z0-9][a-z0-9_.-]*@[a-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(config.clientEmail)||
    (config.scope!==GOOGLE_DRIVE_FILE_SCOPE&&config.scope!==GOOGLE_SPREADSHEETS_SCOPE)||
    (config.audience!==undefined&&config.audience!==GOOGLE_TOKEN_ENDPOINT))
    throw Error("INVALID_SERVICE_IDENTITY");
  const key=config.privateKey;
  if(!key||key.type!=="private"||key.algorithm.name!=="RSASSA-PKCS1-v1_5"||
    !key.usages.includes("sign"))
    throw Error("INVALID_SIGNING_KEY");
}
export async function createServiceAssertion(
  identity:ServiceIdentity,nowMs:number,lifetimeSeconds=600
):Promise<{jwt:string;issuedAt:number;expiresAt:number}>{
  validateIdentity(identity);
  if(!validClock(nowMs)||!Number.isSafeInteger(lifetimeSeconds)||
     lifetimeSeconds<60||lifetimeSeconds>3600)
    throw Error("INVALID_AUTH_TIME");
  const issuedAt=Math.floor(nowMs/1000),expiresAt=issuedAt+lifetimeSeconds;
  const input=encoded({alg:"RS256",typ:"JWT"})+"."+
    encoded({iss:identity.clientEmail,scope:identity.scope,
      aud:GOOGLE_TOKEN_ENDPOINT,iat:issuedAt,exp:expiresAt});
  try{
    const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",identity.privateKey,enc.encode(input));
    return {jwt:input+"."+b64url(new Uint8Array(sig)),
      issuedAt,expiresAt};
  }catch{
    // Never include key material, signed JWT or a provider response in error output.
    throw Error("SERVICE_SIGNING_FAILED");
  }
}
/** No default network implementation and no credential persistence. */
export async function requestSyntheticGoogleToken(
  identity:ServiceIdentity,transport:TokenTransport,nowMs:number
):Promise<EphemeralToken>{
  const assertion=await createServiceAssertion(identity,nowMs);
  if(!transport||typeof transport.exchange!=="function")
    throw Error("TOKEN_TRANSPORT_REQUIRED");
  const body=new URLSearchParams({
    grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion:assertion.jwt
  }).toString();
  let reply:{status:number;json:unknown};
  try{
    reply=await transport.exchange({
      endpoint:GOOGLE_TOKEN_ENDPOINT,contentType:"application/x-www-form-urlencoded",body
    });
  }catch{
    throw Error("TOKEN_EXCHANGE_UNKNOWN");
  }
  if(reply?.status===401||reply?.status===403)throw Error("TOKEN_DENIED");
  if(reply?.status===429)throw Error("TOKEN_RATE_LIMITED");
  if(!reply||reply.status!==200)throw Error("TOKEN_EXCHANGE_UNKNOWN");
  const payload=reply.json;
  if(!payload||typeof payload!=="object"||Array.isArray(payload))
    throw Error("INVALID_TOKEN_RESPONSE");
  const data=payload as Record<string,unknown>;
  const token=data.access_token,expires=data.expires_in;
  if(data.token_type!=="Bearer"||typeof token!=="string"||token.length<8||
     token.length>4096||/[\u0000-\u0020]/u.test(token)||
     !Number.isSafeInteger(expires)||typeof expires!=="number"||
     expires<60||expires>3600)
    throw Error("INVALID_TOKEN_RESPONSE");
  return {accessToken:token,expiresAtMs:nowMs+expires*1000,scope:identity.scope};
}
