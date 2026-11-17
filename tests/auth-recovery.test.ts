import {describe,it,expect,vi} from "vitest";
import {redirectOnExpiredOwnerSession} from "../src/client/auth-recovery";

describe("Owner session recovery is not a blanket 403 redirect",()=>{
  it("redirects an exact Worker raw Forbidden without consuming the response",async()=>{
    const redirect=vi.fn();
    const res=new Response("Forbidden",{status:403,headers:{"Cache-Control":"private, no-store"}});
    expect(await redirectOnExpiredOwnerSession(res,redirect)).toBe(true);
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
    expect(await res.text()).toBe("Forbidden");
  });
  it("does not mistake feature-disabled JSON 403 or other errors for expiry",async()=>{
    const redirect=vi.fn();
    for(const response of [
      Response.json({error:"ECLEAR_LOCAL_DISABLED"},{status:403}),
      Response.json({error:"LOCAL_IMPORT_DISABLED"},{status:403}),
      new Response("Forbidden!",{status:403}),
      new Response("Forbidden",{status:503}),
      new Response("Forbidden",{status:403,headers:{"Content-Type":"text/html"}}),
      new Response("Forbidden",{status:200})
    ]){
      expect(await redirectOnExpiredOwnerSession(response,redirect)).toBe(false);
    }
    expect(redirect).not.toHaveBeenCalled();
  });
});
