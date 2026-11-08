import { describe, expect, it } from "vitest";
import { pbkdf2Sync } from "node:crypto";
import { authRoute, sessionOwner } from "../src/worker/password-auth";

const url = "https://life-log-uat.ha-rookie.workers.dev";
const req = (path:string, payload:unknown, origin=url) => new Request(url+path,{
 method:"POST",headers:{"Origin":origin,"Sec-Fetch-Site":"same-origin","X-Life-Log-Intent":"register-v1","Content-Type":"application/json"},
 body:JSON.stringify(payload)
});
describe("owner password authentication boundary",()=>{
 const unavailable={DB:{prepare:()=>{throw new Error("DB must not be accessed")}}};
 it("rejects CSRF variants, insecure transport, wrong intent and missing metadata before D1",async()=>{
  const base=req("/api/auth/login",{password:"a".repeat(12)});
  const variants=[
    {name:"missing origin",headers:{"Origin":null}},
    {name:"cross-site",headers:{"Sec-Fetch-Site":"cross-site"}},
    {name:"missing fetch metadata",headers:{"Sec-Fetch-Site":null}},
    {name:"wrong intent",headers:{"X-Life-Log-Intent":"manual-write-v1"}},
    {name:"wrong content type",headers:{"Content-Type":"text/plain"}},
  ];
  for(const v of variants){
    const headers=new Headers(base.headers);
    for(const [key,value] of Object.entries(v.headers)){if(value===null)headers.delete(key);else headers.set(key,value);}
    const res=await authRoute(new Request(base.url,{method:"POST",headers,body:JSON.stringify({password:"a".repeat(12)})}),unavailable as never);
    expect(res.status,v.name).toBe(403);
  }
  const insecure=new Request("http://life-log-uat.ha-rookie.workers.dev/api/auth/login",{
    method:"POST",headers:{"Origin":"http://life-log-uat.ha-rookie.workers.dev","Sec-Fetch-Site":"same-origin","X-Life-Log-Intent":"register-v1","Content-Type":"application/json"},
    body:JSON.stringify({password:"a".repeat(12)})
  });
  expect((await authRoute(insecure,unavailable as never)).status).toBe(403);
 });
 it("rejects cross-origin enrollment before any DB access",async()=>{
  const res=await authRoute(req("/api/auth/register",{setupCode:"x",password:"a".repeat(12)},"https://attacker.example"),unavailable as never);
  expect(res.status).toBe(403);
 });
 it("does not allow enrollment without a provisioned setup secret",async()=>{
  const res=await authRoute(req("/api/auth/register",{setupCode:"x",password:"a".repeat(12)}),unavailable as never);
  expect(res.status).toBe(503);
 });
 it("rejects weak passwords before accessing D1",async()=>{
  const res=await authRoute(req("/api/auth/register",{setupCode:"x",password:"short"}),unavailable as never);
  expect(res.status).toBe(422);
 });
 it("rejects invalid login even if credentials table is missing",async()=>{
  const res=await authRoute(req("/api/auth/login",{password:"a".repeat(12)}),unavailable as never);
  expect(res.status).toBe(503);
 });
 it("fails closed when password-only UAT has no platform rate limiter",async()=>{
  const res=await authRoute(req("/api/auth/login",{password:"a".repeat(12)}),{
   ...unavailable,PASSWORD_ONLY_UAT:"true",
  } as never);
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({error:"AUTH_PROTECTION_UNAVAILABLE"});
 });
 it("rejects missing client IP in password-only UAT",async()=>{
  const res=await authRoute(req("/api/auth/login",{password:"a".repeat(12)}),{
   ...unavailable,PASSWORD_ONLY_UAT:"true",AUTH_RATE_LIMITER:{limit:async()=>({success:true})},
  } as never);
  expect(res.status).toBe(503);
 });
 it("rejects rate-limited login before touching D1",async()=>{
  const request=req("/api/auth/login",{password:"a".repeat(12)});
  request.headers.set("CF-Connecting-IP","203.0.113.1");
  const res=await authRoute(request,{
   ...unavailable,PASSWORD_ONLY_UAT:"true",AUTH_RATE_LIMITER:{limit:async()=>({success:false})},
  } as never);
  expect(res.status).toBe(429);
 });
 it("rejects broken rate limiter before touching D1",async()=>{
  const request=req("/api/auth/register",{setupCode:"x",password:"a".repeat(12)});
  request.headers.set("CF-Connecting-IP","203.0.113.1");
  const res=await authRoute(request,{
   ...unavailable,PASSWORD_ONLY_UAT:"true",AUTH_RATE_LIMITER:{limit:async()=>{throw Error("unavailable")}},
  } as never);
  expect(res.status).toBe(503);
 });
 it("rejects second enrollment before writing owner credentials",async()=>{
  const statements:string[]=[];
  const db={prepare:(sql:string)=>{
    statements.push(sql);
    return {bind:(..._args:unknown[])=>({
      first:async()=>({owner_id:"owner"}),
      run:async()=>{throw Error("second enrollment must not mutate D1");},
    })};
  }};
  const request=req("/api/auth/register",{setupCode:"s".repeat(32),password:"strong-password-123"});
  const res=await authRoute(request,{DB:db,OWNER_SETUP_CODE:"s".repeat(32)} as never);
  expect(res.status).toBe(409);
  expect(statements).toEqual(["SELECT owner_id FROM owner_credentials LIMIT 1"]);
 });
 it("disables setup-code enrollment in password-only UAT without D1 access",async()=>{
  const request=req("/api/auth/register",{setupCode:"x".repeat(32),password:"strong-password-123"});
  request.headers.set("CF-Connecting-IP","203.0.113.1");
  const env={...unavailable,PASSWORD_ONLY_UAT:"true",
    AUTH_RATE_LIMITER:{limit:async()=>({success:true})}};
  expect((await authRoute(request,env as never)).status).toBe(404);
 });
 it("rejects an incorrect temporary Owner password without provisioning credentials",async()=>{
  const queries:string[]=[];
  const db={prepare:(sql:string)=>{queries.push(sql);return {bind:()=>({
    first:async()=>null,run:async()=>{throw Error("incorrect password must not write");}
  })};}};
  const request=req("/api/auth/login",{username:"owner",password:"incorrect-password"});
  request.headers.set("CF-Connecting-IP","203.0.113.1");
  const res=await authRoute(request,{DB:db,PASSWORD_ONLY_UAT:"true",
    AUTH_RATE_LIMITER:{limit:async()=>({success:true})}} as never);
  expect(res.status).toBe(401);
  expect(queries).not.toContain(expect.stringContaining("INSERT"));
 });
 it("never re-provisions a retired temporary password after passkey enrollment",async()=>{
  const queries:string[]=[];
  const db={prepare:(sql:string)=>{queries.push(sql);return {bind:()=>({
    first:async()=>{
      if(sql.includes("owner_passkey_credentials"))return {credential_id:"registered"};
      return null;
    },
    run:async()=>{throw Error("retired login must not write");}
  })};}};
  const request=req("/api/auth/login",{username:"owner",password:"arbitrary-password"});
  request.headers.set("CF-Connecting-IP","203.0.113.1");
  const res=await authRoute(request,{DB:db,PASSWORD_ONLY_UAT:"true",
    AUTH_RATE_LIMITER:{limit:async()=>({success:true})}} as never);
  expect(res.status).toBe(401);
  expect(queries.filter(sql=>sql.includes("INSERT"))).toHaveLength(0);
 });
 it("rejects missing and malformed session cookies without DB access",async()=>{
  expect(await sessionOwner(new Request(url+"/"),unavailable.DB as never)).toBeNull();
  expect(await sessionOwner(new Request(url+"/",{headers:{Cookie:"__Host-life_log_session=bad"}}),unavailable.DB as never)).toBeNull();
 });
 it("authenticates a synthetic 210k-round Owner verifier and accepts its session",async()=>{
  // The synthetic password is NOT a real UAT credential; no secrets in tests.
  const password="synthetic-owner-credential-2026";
  const salt="11223344556677889900aabbccddeeff";
  const storedHash=pbkdf2Sync(password,Buffer.from(salt,"hex"),210000,32,"sha256").toString("hex");
  let issuedTokenHash:string|null=null, sessionWrites=0;
  const statements:string[]=[];
  const db={prepare:(sql:string)=>{
    statements.push(sql);
    return {bind:(...args:unknown[])=>({
      first:async()=>{
        if(sql.includes("SELECT password_salt"))return {salt,hash:storedHash,iterations:210000};
        if(sql.includes("SELECT owner_id AS owner FROM owner_sessions"))
          return args[0]===issuedTokenHash?{owner:"owner"}:null;
        return null;
      },
      run:async()=>{
        if(sql.includes("INSERT INTO owner_sessions")){
          issuedTokenHash=String(args[0]);
          sessionWrites++;
        }
        return {meta:{changes:1}};
      }
    })};
  }};
  const env={DB:db,PASSWORD_ONLY_UAT:"true",
    AUTH_RATE_LIMITER:{limit:async()=>({success:true})}};
  const wrong=req("/api/auth/login",{username:"owner",password:"incorrect-synthetic-credential"});
  wrong.headers.set("CF-Connecting-IP","203.0.113.15");
  const rejected=await authRoute(wrong,env as never);
  expect(rejected.status).toBe(401);
  expect(sessionWrites).toBe(0);
  const right=req("/api/auth/login",{username:"owner",password});
  right.headers.set("CF-Connecting-IP","203.0.113.15");
  const login=await authRoute(right,env as never);
  expect(login.status).toBe(200);
  expect(sessionWrites).toBe(1);
  const cookie=login.headers.get("Set-Cookie");
  expect(cookie).toContain("__Host-life_log_session=");
  expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
  const token=cookie!.split(";")[0];
  const authenticated=new Request(url+"/api/summary",{headers:{Cookie:token}});
  expect(await sessionOwner(authenticated,db as never)).toBe("owner");
  expect(statements.some(sql=>sql.includes("INSERT INTO owner_credentials"))).toBe(false);
 });
 it("rejects malformed stored KDF parameters without issuing a session",async()=>{
  const db={prepare:(sql:string)=>({bind:()=>({
    first:async()=>sql.includes("SELECT password_salt")?
      {salt:"not-hex",hash:"0".repeat(64),iterations:2000000}:null,
    run:async()=>{throw Error("Must never write a session");}
  })})};
  const request=req("/api/auth/login",{username:"owner",password:"synthetic-owner-credential-2026"});
  request.headers.set("CF-Connecting-IP","203.0.113.15");
  const res=await authRoute(request,{DB:db,PASSWORD_ONLY_UAT:"true",
    AUTH_RATE_LIMITER:{limit:async()=>({success:true})}} as never);
  expect(res.status).toBe(503);
 });

});
