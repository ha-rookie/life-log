import { describe, expect, it } from "vitest";
import {
  authRoute, issuePasskeySession, sessionIsPasskey, sessionOwner
} from "../src/worker/password-auth";

const origin="https://life-log-uat.ha-rookie.workers.dev";
function request(path:string,extra:Record<string,string>={}){
 return new Request(origin+path,{method:"POST",headers:{
  Origin:origin,"Sec-Fetch-Site":"same-origin",
  "X-Life-Log-Intent":"register-v1","Content-Type":"application/json",
  ...extra
 },body:"{}"});
}
describe("passkey-only UAT session and retired password boundary",()=>{
 const forbidden={DB:{prepare(){throw Error("No DB query expected");}}};
 it("rejects password login and registration permanently without reading D1",async()=>{
  for(const path of ["/api/auth/login","/api/auth/register"]){
    for(const method of ["POST","GET"]){
      const res=await authRoute(new Request(origin+path,{method}),forbidden as never);
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({error:"PASSWORD_AUTH_RETIRED"});
    }
  }
 });
 it("retired endpoints cannot be used to re-bootstrap or bypass passkeys",async()=>{
  const res=await authRoute(request("/api/auth/login"),{
    ...forbidden,PASSWORD_ONLY_UAT:"true",
  } as never);
  expect(res.status).toBe(410);
 });
 it("preserves CSRF, origin and method protection for logout",async()=>{
  const wrong=[
    request("/api/auth/logout",{Origin:"https://evil.invalid"}),
    request("/api/auth/logout",{"Sec-Fetch-Site":"cross-site"}),
    request("/api/auth/logout",{"X-Life-Log-Intent":"bad"}),
    request("/api/auth/logout",{"Content-Type":"text/plain"}),
  ];
  for(const r of wrong){
    expect((await authRoute(r,forbidden as never)).status).toBe(403);
  }
  expect((await authRoute(new Request(origin+"/api/auth/logout"),forbidden as never)).status).toBe(405);
 });
 it("keeps existing passkey session cookie and verifies owner against D1",async()=>{
  let tokenHash="",passkeySessionHash="",createdSessions=0;
  const db={
    prepare(sql:string){
      return {bind:(...args:unknown[])=>({
        sql,args,
        first:async()=>{
          if(sql.includes("JOIN owner_passkey_sessions"))
            return args[0]===passkeySessionHash?{owner_id:"owner"}:null;
          if(sql.includes("SELECT owner_id AS owner"))
            return args[0]===tokenHash?{owner:"owner"}:null;
          return null;
        },
        run:async()=>{
          if(sql.startsWith("DELETE FROM owner_sessions"))tokenHash="";
          return {meta:{changes:1}};
        }
      })};
    },
    batch:async(statements:{sql:string;args:unknown[]}[])=>{
      expect(statements).toHaveLength(2);
      expect(statements[0].sql).toContain("INSERT INTO owner_sessions");
      expect(statements[1].sql).toContain("INSERT INTO owner_passkey_sessions");
      tokenHash=String(statements[0].args[0]);
      passkeySessionHash=String(statements[1].args[0]);
      createdSessions++;
      return [];
    }
  };
  const response=await issuePasskeySession(db as never);
  expect(response.status).toBe(200);
  expect(createdSessions).toBe(1);
  const cookie=response.headers.get("Set-Cookie");
  expect(cookie).toMatch(/^__Host-life_log_session=[a-f0-9]{64};/);
  expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
  const sessionRequest=new Request(origin+"/api/summary",{
    headers:{Cookie:cookie!.split(";")[0]}
  });
  expect(await sessionOwner(sessionRequest,db as never)).toBe("owner");
  expect(await sessionIsPasskey(sessionRequest,db as never)).toBe(true);
  expect(await sessionIsPasskey(new Request(origin+"/"),db as never)).toBe(false);
  expect(await sessionOwner(new Request(origin+"/"),db as never)).toBeNull();
 });
 it("allows protected logout and invalidates cookie with a D1 delete",async()=>{
  const sqls:string[]=[];
  const db={prepare(sql:string){sqls.push(sql);return {bind:()=>({
    run:async()=>({meta:{changes:1}}),
    first:async()=>null
  })}}};
  const res=await authRoute(request("/api/auth/logout",{
    Cookie:"__Host-life_log_session="+"a".repeat(64)
  }),{DB:db} as never);
  expect(res.status).toBe(200);
  expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(sqls).toEqual([expect.stringContaining("DELETE FROM owner_sessions")]);
 });
});
