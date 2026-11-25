import {beforeAll,describe,expect,it} from "vitest";
import {
  GOOGLE_TOKEN_ENDPOINT,GOOGLE_DRIVE_FILE_SCOPE,GOOGLE_SPREADSHEETS_SCOPE,
  createServiceAssertion,requestSyntheticGoogleToken,
  type ServiceIdentity,type TokenTransport,type TokenExchangeRequest
} from "../src/worker/ai-google-auth";

const NOW=Date.parse("2026-11-25T04:00:00Z");
const MOCK_EMAIL="synthetic-sync@test-project.iam.gserviceaccount.com";
let keys:CryptoKeyPair;
const identity=(fields:Partial<ServiceIdentity>={}):ServiceIdentity=>({
  clientEmail:MOCK_EMAIL,privateKey:keys.privateKey,scope:GOOGLE_DRIVE_FILE_SCOPE,...fields
});
function decodePart(input:string):Record<string,unknown>{
  const encoded=input.replace(/-/g,"+").replace(/_/g,"/");
  return JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,"="))) as Record<string,unknown>;
}
function transport(status=200,json:unknown={
  access_token:"synthetic_only_access_token",token_type:"Bearer",expires_in:600
}):TokenTransport & {calls:TokenExchangeRequest[]}{
  const calls:TokenExchangeRequest[]=[];
  return {calls,exchange:async request=>{calls.push(request);return {status,json};}};
}

describe("B3 OAuth service-account JWT — synthetic transport only",()=>{
  beforeAll(async()=>{
    keys=await crypto.subtle.generateKey({
      name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
      publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"
    },true,["sign","verify"]) as CryptoKeyPair;
  },60000);

  it("O01: pinned RS256 audience, scope, claims, signature and short-lived expiry",async()=>{
    const issued=await createServiceAssertion(identity(),NOW);
    const parts=issued.jwt.split(".");
    expect(parts).toHaveLength(3);
    expect(decodePart(parts[0])).toEqual({alg:"RS256",typ:"JWT"});
    const body=decodePart(parts[1]);
    expect(body).toMatchObject({
      iss:MOCK_EMAIL,scope:GOOGLE_DRIVE_FILE_SCOPE,aud:GOOGLE_TOKEN_ENDPOINT,
      iat:NOW/1000,exp:NOW/1000+600
    });
    const sig=Uint8Array.from(atob(parts[2].replace(/-/g,"+").replace(/_/g,"/")),x=>x.charCodeAt(0));
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5",keys.publicKey,
      sig,new TextEncoder().encode(parts[0]+"."+parts[1]))).toBe(true);
    expect(issued.expiresAt-issued.issuedAt).toBe(600);
  });

  it("O02: token exchange is injected, endpoint fixed, never real fetch",async()=>{
    const fake=transport(),result=await requestSyntheticGoogleToken(identity(),fake,NOW);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].endpoint).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(fake.calls[0].contentType).toBe("application/x-www-form-urlencoded");
    const form=new URLSearchParams(fake.calls[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);
    expect(result).toEqual({
      accessToken:"synthetic_only_access_token",
      expiresAtMs:NOW+600000,scope:GOOGLE_DRIVE_FILE_SCOPE
    });
  });

  it("O03: only exact allowlisted scopes; no broad drive/domain delegation or altered audience",async()=>{
    const sheets=await createServiceAssertion(identity({scope:GOOGLE_SPREADSHEETS_SCOPE}),NOW);
    expect(decodePart(sheets.jwt.split(".")[1]).scope).toBe(GOOGLE_SPREADSHEETS_SCOPE);
    await expect(createServiceAssertion(identity({
      scope:"https://www.googleapis.com/auth/drive" as never
    }),NOW)).rejects.toThrow("INVALID_SERVICE_IDENTITY");
    await expect(createServiceAssertion(identity({
      audience:"https://example.org/oauth"
    }),NOW)).rejects.toThrow("INVALID_SERVICE_IDENTITY");
    await expect(createServiceAssertion(identity({
      clientEmail:"owner@gmail.com"
    }),NOW)).rejects.toThrow("INVALID_SERVICE_IDENTITY");
  });

  it("O04: malformed key, out-of-range clock and expired assertions reject",async()=>{
    await expect(createServiceAssertion(identity({privateKey:keys.publicKey}),NOW))
      .rejects.toThrow("INVALID_SIGNING_KEY");
    await expect(createServiceAssertion(identity(),0)).rejects.toThrow("INVALID_AUTH_TIME");
    await expect(createServiceAssertion(identity(),NOW,10)).rejects.toThrow("INVALID_AUTH_TIME");
    await expect(createServiceAssertion(identity(),NOW,3601)).rejects.toThrow("INVALID_AUTH_TIME");
  });

  it("O05: revoked/expired OAuth responses fail closed, no token text in exception",async()=>{
    for(const status of [401,403,429,500]){
      const fake=transport(status,{error:"private_token_DO_NOT_LOG"});
      try{
        await requestSyntheticGoogleToken(identity(),fake,NOW);
        expect.fail("Expected denial");
      }catch(e){
        expect((e as Error).message).toBe(
          status===401||status===403?"TOKEN_DENIED":
            status===429?"TOKEN_RATE_LIMITED":"TOKEN_EXCHANGE_UNKNOWN");
        expect((e as Error).message).not.toContain("DO_NOT_LOG");
      }
    }
    await expect(requestSyntheticGoogleToken(identity(),{
      exchange:async()=>{throw Error("secret:private_token_DO_NOT_LOG");}
    },NOW)).rejects.toThrow("TOKEN_EXCHANGE_UNKNOWN");
  });

  it("O06: malformed token/invalid expiry/type fail closed, never report authenticated",async()=>{
    for(const value of [
      null,{},{access_token:"too",token_type:"Bearer",expires_in:600},
      {access_token:"synthetic_token",token_type:"not-bearer",expires_in:600},
      {access_token:"synthetic_token",token_type:"Bearer",expires_in:-1},
      {access_token:"synthetic_token",token_type:"Bearer",expires_in:999999},
      {access_token:"synthetic_token",token_type:"Bearer",expires_in:"600"}
    ]){
      await expect(requestSyntheticGoogleToken(identity(),transport(200,value),NOW))
        .rejects.toThrow("INVALID_TOKEN_RESPONSE");
    }
  });

  it("O07: no default exchange means no network fallback",async()=>{
    await expect(requestSyntheticGoogleToken(identity(),null as never,NOW))
      .rejects.toThrow("TOKEN_TRANSPORT_REQUIRED");
  });
});
