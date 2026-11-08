import { describe, expect, it, vi } from "vitest";
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
 it("allows the issued UAT verifier for a legacy Owner credential without overwriting it",async()=>{
  // Test only the committed verifier, never the plaintext temporary password.
  const verifierBytes=Uint8Array.from("9992a444eb48fd6383004bbbb404d0b53227bdbe3242edc3788d19ed08e7eeac".match(/../g)!,v=>parseInt(v,16));
  const spy=vi.spyOn(crypto.subtle,"deriveBits").mockResolvedValue(verifierBytes.buffer as ArrayBuffer);
  const queries:string[]=[];
  const db={prepare:(sql:string)=>{
    queries.push(sql);
    return {bind:()=>({
      first:async()=>{
        if(sql.includes("SELECT password_salt"))return {salt:"b8a1ebd3d6144479ed597ede5d76fa65",hash:"0".repeat(64),iterations:210000};
        if(sql.includes("owner_passkey_credentials"))return null;
        return null;
      },
      run:async()=>({meta:{changes:1}}),
    })};
  }};
  try{
    const request=req("/api/auth/login",{username:"owner",password:"test-temporary-placeholder"});
    request.headers.set("CF-Connecting-IP","203.0.113.1");
    const response=await authRoute(request,{DB:db,PASSWORD_ONLY_UAT:"true",
      AUTH_RATE_LIMITER:{limit:async()=>({success:true})}} as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-life_log_session=");
    expect(queries.some(sql=>sql.includes("INSERT INTO owner_sessions"))).toBe(true);
    expect(queries.some(sql=>sql.includes("INSERT OR IGNORE INTO owner_credentials"))).toBe(false);
  }finally{spy.mockRestore();}
 });
 it("rejects the UAT recovery credential once a passkey exists",async()=>{
  const queries:string[]=[];
  const db={prepare:(sql:string)=>{
    queries.push(sql);
    return {bind:()=>({
      first:async()=>{
        if(sql.includes("SELECT password_salt"))return {salt:"b8a1ebd3d6144479ed597ede5d76fa65",hash:"0".repeat(64),iterations:210000};
        if(sql.includes("owner_passkey_credentials"))return {credential_id:"registered"};
        return null;
      },
      run:async()=>({meta:{changes:1}}),
    })};
  }};
  const request=req("/api/auth/login",{username:"owner",password:"test-temporary-placeholder"});
  request.headers.set("CF-Connecting-IP","203.0.113.1");
  const response=await authRoute(request,{DB:db,PASSWORD_ONLY_UAT:"true",
    AUTH_RATE_LIMITER:{limit:async()=>({success:true})}} as never);
  expect(response.status).toBe(401);
  expect(queries.some(sql=>sql.includes("INSERT"))).toBe(false);
 });
 it("never enables temporary password fallback on a non-UAT host",async()=>{
  const statements:string[]=[];
  const db={prepare:(sql:string)=>{
    statements.push(sql);
    return {bind:()=>({
      first:async()=>({salt:"b8a1ebd3d6144479ed597ede5d76fa65",hash:"0".repeat(64),iterations:210000}),
      run:async()=>{throw Error("No write expected");},
    })};
  }};
  const host="https://example.org";
  const request=new Request(host+"/api/auth/login",{method:"POST",headers:{
    Origin:host,"Sec-Fetch-Site":"same-origin","X-Life-Log-Intent":"register-v1",
    "Content-Type":"application/json","CF-Connecting-IP":"203.0.113.1",
  },body:JSON.stringify({username:"owner",password:"not-the-issued-password"})});
  const response=await authRoute(request,{DB:db,PASSWORD_ONLY_UAT:"true",
    AUTH_RATE_LIMITER:{limit:async()=>({success:true})}} as never);
  expect(response.status).toBe(401);
  expect(statements.some(sql=>sql.includes("owner_passkey_credentials"))).toBe(false);
 });
 it("provides specific but non-sensitive login error diagnostics in the HTML",async()=>{
  const {loginScreen}=await import("../src/worker/login-screen");
  const html=await loginScreen().text();
  expect(html).toContain("res.status");
  expect(html).toContain("AUTH_PROTECTION_UNAVAILABLE");
  expect(html).toContain("ログイン試行回数の上限");
  expect(html).not.toContain("test-temporary-placeholder");
 });

});
