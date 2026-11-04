import {describe,it,expect,vi} from "vitest";
import {createHandler,type Env} from "../src/worker/index";
describe("import route signed authorization",()=>{
  it("rejects unauthorized preview and confirm before D1 access",async()=>{
    const env={DB:{prepare:vi.fn(),batch:vi.fn()},ASSETS:{fetch:vi.fn()}} as unknown as Env;
    for(const path of ["/api/import/preview","/api/import/confirm"]){
      const r=await createHandler(async()=>null).fetch(new Request("https://example.invalid"+path,{method:"POST",headers:{"Content-Type":"application/json","Cf-Access-Authenticated-User-Email":"owner@example.invalid"},body:"{}"}),env);
      expect(r.status).toBe(403);
    }
    expect(env.DB.prepare).not.toHaveBeenCalled();expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});
