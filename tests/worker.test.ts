import { describe, expect, it, vi } from "vitest";
import { createHandler, type Env } from "../src/worker/index";
import { getSummary } from "../src/worker/summary";

function testEnv(weight: number | null = null): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response("<html>private</html>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } })) },
    DB: { prepare: vi.fn((_sql: string) => ({ bind: vi.fn((_owner: unknown) => ({ first: async <T>() => (weight === null ? null : { measured_at: "2026-01-02T07:00:00+09:00", weight_kg: weight } as T) })) })) },
  };
}

describe("worker authorization boundary", () => {
  it("blocks HTML, hashed assets, API and spoofed requests without identity", async () => {
    const env = testEnv();
    const handler = createHandler(async () => null);
    for (const pathname of ["/", "/index.html", "/assets/app.hash.js", "/api/summary", "/favicon.ico"]) {
      const res = await handler.fetch(new Request(`https://app.example.invalid${pathname}`,{headers:{"Cf-Access-Authenticated-User-Email":"owner@example.invalid"}}), env);
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
    }
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it("guides only unauthenticated browser HTML entry to passkey login", async () => {
    const env = testEnv();
    const handler = createHandler(async () => null);
    for (const path of ["/", "/index.html"]) {
      const res = await handler.fetch(new Request("https://app.example.invalid"+path,{
        headers:{Accept:"text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"}
      }),env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/login");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it("keeps private routes and non-navigation requests forbidden even with HTML Accept", async () => {
    const env = testEnv();
    const handler = createHandler(async () => null);
    for (const path of ["/api/dashboard", "/api/mvp/metrics", "/api/mvp/export", "/assets/app.hash.js", "/private", "/favicon.ico"]) {
      const res = await handler.fetch(new Request("https://app.example.invalid"+path,{
        headers:{Accept:"text/html"}
      }),env);
      expect(res.status).toBe(403);
      expect(res.headers.get("Location")).toBeNull();
    }
    for (const method of ["HEAD","POST","OPTIONS"]) {
      const res = await handler.fetch(new Request("https://app.example.invalid/",{
        method,headers:{Accept:"text/html"}
      }),env);
      expect(res.status).toBe(403);
    }
    // Existing curl and API clients use */*, not an HTML navigation.
    for (const accept of ["*/*", "application/json", "application/x-text/html-fake"]) {
      const curl = await handler.fetch(new Request("https://app.example.invalid/",{
        headers:{Accept:accept}
      }),env);
      expect(curl.status).toBe(403);
    }
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it("serves authorized assets without making them publicly cacheable", async () => {
    const env = testEnv();
    const res = await createHandler(async () => "owner").fetch(new Request("https://app.example.invalid/index.html"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("keeps authenticated browser HTML entry private, not redirected", async () => {
    const env=testEnv();
    const res=await createHandler(async()=> "owner").fetch(
      new Request("https://app.example.invalid/",{headers:{Accept:"text/html"}}),env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });
  it("returns null for absent measurements and never accepts mutation endpoints", async () => {
    const env = testEnv();
    const handler = createHandler(async () => "owner");
    const empty = await handler.fetch(new Request("https://app.example.invalid/api/summary"), env);
    expect(await empty.json()).toEqual({ latestWeightKg: null, measuredAt: null });
    const post = await handler.fetch(new Request("https://app.example.invalid/api/summary",{method:"POST"}), env);
    expect(post.status).toBe(405);
    expect(env.DB.prepare).toHaveBeenCalledTimes(1);
    const missing = await handler.fetch(new Request("https://app.example.invalid/api/private/anything"), env);
    expect(missing.status).toBe(404);
  });
  it("scopes D1 reads to owner and retains a real weight", async () => {
    const env = testEnv(72.2);
    expect(await getSummary(env.DB,"owner")).toEqual({latestWeightKg:72.2,measuredAt:"2026-01-02T07:00:00+09:00"});
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE owner_id = ?"));
  });

  it("rejects unsigned identity on every path and method without touching D1 or assets", async () => {
    const env = testEnv(75.3);
    const handler = createHandler();
    for (const path of ["/", "/index.html", "/assets/bundle.abc.js", "/api/summary", "/api/import", "/api/admin"]) {
      for (const method of ["GET","POST","HEAD","OPTIONS"]) {
        const response = await handler.fetch(new Request("https://app.example.invalid" + path, {
          method,
          headers: {
            "Cf-Access-Authenticated-User-Email": "owner@example.invalid",
            "X-User": "owner",
            "Cookie": "CF_Authorization=fake",
          },
        }), env);
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toContain("no-store");
      }
    }
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("password-only UAT rejects Access-only identity and manual mutations", async () => {
    const env = testEnv();
    env.PASSWORD_ONLY_UAT = "true";
    env.MANUAL_REMOTE_WRITE_ENABLED = "true";
    env.MANUAL_REMOTE_TARGET = "uat";
    env.MANUAL_REMOTE_ORIGIN = "https://life-log-uat.ha-rookie.workers.dev";
    const handler = createHandler(async () => "owner");
    for (const path of ["/", "/api/summary", "/api/manual/weight", "/api/manual/steps"]) {
      const method = path.startsWith("/api/manual/") ? "POST" : "GET";
      const res = await handler.fetch(new Request("https://life-log-uat.ha-rookie.workers.dev"+path,{
        method, headers: method === "POST" ? {"Content-Type":"application/json","Origin":"https://life-log-uat.ha-rookie.workers.dev","Sec-Fetch-Site":"same-origin","X-Life-Log-Intent":"manual-write-v1"} : {},
        ...(method === "POST" ? {body:"{}"} : {}),
      }),env);
      expect(res.status).toBe(403);
    }
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it("fails closed when the database is unavailable and exposes no internal exception", async () => {
    const env = testEnv();
    env.DB.prepare = vi.fn(() => { throw new Error("sensitive database internals"); });
    const res = await createHandler(async () => "owner").fetch(
      new Request("https://app.example.invalid/api/summary"), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(await res.text()).not.toContain("sensitive database internals");
  });

  it("never reaches assets for unknown API paths, and blocks static mutations", async () => {
    const env = testEnv(75);
    const handler = createHandler(async () => "owner");
    const missing = await handler.fetch(new Request("https://app.example.invalid/api/unknown"), env);
    expect(missing.status).toBe(404);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    const mutation = await handler.fetch(new Request("https://app.example.invalid/assets/app.js", {method:"PUT"}), env);
    expect(mutation.status).toBe(405);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

});
