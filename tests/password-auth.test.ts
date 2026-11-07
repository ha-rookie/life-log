import { describe, expect, it } from "vitest";
import { authRoute, sessionOwner } from "../src/worker/password-auth";

const url = "https://life-log-uat.ha-rookie.workers.dev";
const req = (path:string, payload:unknown, origin=url) => new Request(url+path,{
 method:"POST",headers:{"Origin":origin,"Sec-Fetch-Site":"same-origin","X-Life-Log-Intent":"register-v1","Content-Type":"application/json"},
 body:JSON.stringify(payload)
});
describe("owner password authentication boundary",()=>{
 const unavailable={DB:{prepare:()=>{throw new Error("DB must not be accessed")}}};
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
 it("rejects missing and malformed session cookies without DB access",async()=>{
  expect(await sessionOwner(new Request(url+"/"),unavailable.DB as never)).toBeNull();
  expect(await sessionOwner(new Request(url+"/",{headers:{Cookie:"__Host-life_log_session=bad"}}),unavailable.DB as never)).toBeNull();
 });
});
