import { describe, expect, it } from "vitest";
import { passkeyRoute } from "../src/worker/passkey-auth";

const origin="https://life-log-uat.ha-rookie.workers.dev";
const request=(path:string,body:unknown={},extra:Record<string,string>={})=>
  new Request(origin+path,{method:"POST",headers:{
    Origin:origin,"Sec-Fetch-Site":"same-origin",
    "X-Life-Log-Intent":"passkey-v1","Content-Type":"application/json",
    ...extra,
  },body:JSON.stringify(body)});
const unavailable={DB:{prepare(){throw Error("DB must remain untouched");}}};
const route=(path:string)=>"/api/auth/passkey/"+path;

describe("Owner-only Android passkey boundary",()=>{
  it("is unavailable outside explicit UAT mode and never reads D1",async()=>{
    const res=await passkeyRoute(request(route("login/options")),unavailable as never);
    expect(res.status).toBe(404);
  });
  it("rejects cross-origin, wrong intent and missing browser metadata before DB",async()=>{
    for(const override of ([
      {Origin:"https://evil.invalid"},
      {"Sec-Fetch-Site":"cross-site"},
      {"Sec-Fetch-Site":""},
      {"X-Life-Log-Intent":"register-v1"},
      {"Content-Type":"text/plain"},
    ] as Record<string,string>[])){
      const res=await passkeyRoute(request(route("register/options"),{},override),{
        ...unavailable,PASSWORD_ONLY_UAT:"true",
      } as never);
      expect(res.status,JSON.stringify(override)).toBe(403);
    }
  });
  it("never creates public login challenges without a working limiter",async()=>{
    const res=await passkeyRoute(request(route("login/options")),{
      ...unavailable,PASSWORD_ONLY_UAT:"true",
    } as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({error:"AUTH_PROTECTION_UNAVAILABLE"});
  });
  it("fails closed when rate limiter denies before reading D1",async()=>{
    const res=await passkeyRoute(request(route("login/options"),{},
      {"CF-Connecting-IP":"203.0.113.5"}),{
      ...unavailable,PASSWORD_ONLY_UAT:"true",
      AUTH_RATE_LIMITER:{limit:async()=>({success:false})},
    } as never);
    expect(res.status).toBe(503);
  });
  it("rejects unauthenticated passkey enrollment before D1 write",async()=>{
    const statements:string[]=[];
    const db={prepare(sql:string){
      statements.push(sql);
      return {bind:()=>({first:async()=>null})};
    }};
    const res=await passkeyRoute(request(route("register/options")),{
      DB:db,PASSWORD_ONLY_UAT:"true",
    } as never);
    expect(res.status).toBe(401);
    expect(statements).toEqual([]);
  });
  it("requires a passkey session to retire the temporary password",async()=>{
    const cookie="__Host-life_log_session="+ "a".repeat(64);
    const queries:string[]=[];
    let batches=0;
    const db={
      prepare(sql:string){
        queries.push(sql);
        return {bind:()=>({first:async()=>{
          if(sql.includes("SELECT owner_id AS owner"))return {owner:"owner"};
          if(sql.includes("JOIN owner_passkey_sessions"))return null;
          return null;
        }})};
      },batch:async()=>{batches++;return [];}
    };
    const res=await passkeyRoute(request(route("disable-password"),{},
      {Cookie:cookie}),{DB:db,PASSWORD_ONLY_UAT:"true"} as never);
    expect(res.status).toBe(403);
    expect(batches).toBe(0);
    expect(queries.some(sql=>sql.includes("DELETE"))).toBe(false);
  });
  it("retires password and password sessions as a single D1 batch after passkey login",async()=>{
    const cookie="__Host-life_log_session="+ "a".repeat(64);
    const statements:string[]=[];
    let batch:string[]=[];
    const db={
      prepare(sql:string){
        statements.push(sql);
        return {bind:()=>({
          first:async()=>{
            if(sql.includes("SELECT owner_id AS owner"))return {owner:"owner"};
            if(sql.includes("JOIN owner_passkey_sessions"))return {owner_id:"owner"};
            if(sql.includes("SELECT credential_id"))return {credential_id:"example"};
            return null;
          },run:async()=>({meta:{changes:1}}),
          sql,
        })};
      },
      batch:async(s:{sql:string}[])=>{batch=s.map(v=>v.sql);return [];}
    };
    const res=await passkeyRoute(request(route("disable-password"),{},
      {Cookie:cookie}),{DB:db,PASSWORD_ONLY_UAT:"true"} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({passwordDisabled:true});
    expect(batch).toHaveLength(2);
    expect(batch[0]).toContain("DELETE FROM owner_credentials");
    expect(batch[1]).toContain("NOT IN (SELECT token_hash FROM owner_passkey_sessions)");
  });
});


describe("exact loopback WebAuthn synthetic acceptance boundary",()=>{
  const localOrigin="https://localhost:8787";
  const localReq=(url:string,origin=localOrigin)=>
    new Request(url,{method:"POST",headers:{
      Origin:origin,"Sec-Fetch-Site":"same-origin",
      "X-Life-Log-Intent":"passkey-v1","Content-Type":"application/json"
    },body:"{}"});
  it("never enables localhost RP without the explicit flag, even in UAT password-only mode",async()=>{
    const res=await passkeyRoute(localReq(localOrigin+route("register/options")),{
      ...unavailable,PASSWORD_ONLY_UAT:"true",
    } as never);
    expect(res.status).toBe(403);
  });
  it("with flag, still rejects localhost different port, HTTP, false origin and UAT origin",async()=>{
    for(const [url,origin] of [
      ["https://localhost:8788"+route("register/options"),"https://localhost:8788"],
      ["http://localhost:8787"+route("register/options"),"http://localhost:8787"],
      [localOrigin+route("register/options"),"https://evil.example"],
      [origin+route("register/options"),origin],
    ]){
      const res=await passkeyRoute(localReq(url,origin),{
        ...unavailable,PASSWORD_ONLY_UAT:"true",PASSKEY_LOCAL_E2E_ONLY:"true",
      } as never);
      expect(res.status,url).toBe(403);
    }
  });
  it("generates localhost RP only after explicit flag and an Owner cookie, not globally",async()=>{
    const seen:string[]=[];
    const db={prepare(sql:string){seen.push(sql);return {bind:()=>({
      first:async()=>sql.includes("SELECT owner_id AS owner")?{owner:"owner"}:null,
      run:async()=>({meta:{changes:1}})
    })};}};
    const req=localReq(localOrigin+route("register/options"));
    req.headers.set("Cookie","__Host-life_log_session="+"a".repeat(64));
    const res=await passkeyRoute(req,{
      DB:db,PASSWORD_ONLY_UAT:"true",PASSKEY_LOCAL_E2E_ONLY:"true"
    } as never);
    expect(res.status).toBe(200);
    const response=await res.json() as {options:{rp:{id:string}}};
    expect(response.options.rp.id).toBe("localhost");
    expect(seen.some(sql=>sql.includes("owner_passkey_challenges"))).toBe(true);
  });
  it("does not bypass rate limiter on local public passkey login",async()=>{
    const res=await passkeyRoute(localReq(localOrigin+route("login/options")),{
      ...unavailable,PASSWORD_ONLY_UAT:"true",PASSKEY_LOCAL_E2E_ONLY:"true",
      AUTH_RATE_LIMITER:{limit:async()=>({success:false})}
    } as never);
    expect(res.status).toBe(503);
  });
});
