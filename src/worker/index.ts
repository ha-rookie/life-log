import { verifyOwner, type AccessEnv } from "./auth";
import { localPreview } from "./local-preview";
import { registrationScreen } from "./registration-screen";
import { loginScreen } from "./login-screen";
import { authRoute, sessionOwner } from "./password-auth";
import { getSummary, type Database } from "./summary";
import { handleImport, isSafeLocalImport, type ImportDb } from "./import";
import { handleAuditHistory } from "./audit-history";
import { handleWeightTrend, type TrendDb } from "./weight-trend";
import { handleManualEntry, type ManualDb } from "./manual-entry";

export interface Env extends AccessEnv {
  DB: Database;
  OWNER_SETUP_CODE?: string;
  PASSWORD_ONLY_UAT?: string;
  AUTH_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  // Opt-in must be set only in a trusted loopback-local runtime, never deployed.
  IMPORT_LOCAL_ONLY?: string;
  // Separate opt-in for manual writes. Must never be set in a remote Worker.
  MANUAL_ENTRY_LOCAL_ONLY?: string;
  // UAT-only: independently provisioned, deliberately absent from all deploy configs.
  MANUAL_REMOTE_WRITE_ENABLED?: string;
  MANUAL_REMOTE_TARGET?: string;
  MANUAL_REMOTE_ORIGIN?: string;
  ASSETS: { fetch(input: Request): Promise<Response> };
}

type Authorizer = (request: Request, env: AccessEnv) => Promise<"owner" | null>;
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function createHandler(authorize: Authorizer = verifyOwner) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      // Isolated local-device preview: no D1 reads/writes, cookies, or authenticated API.
      if (new URL(request.url).pathname === "/preview" && request.method === "GET") return localPreview();
      if (new URL(request.url).pathname === "/register" && request.method === "GET") return registrationScreen();
      if (new URL(request.url).pathname === "/login" && request.method === "GET") return loginScreen();
      if (new URL(request.url).pathname.startsWith("/api/auth/")) return authRoute(request, env as unknown as Parameters<typeof authRoute>[1]);
      // Every other pathname, including index.html and hashed assets, enters this gate.
      // No unauthenticated /health, static-asset exception, or dev bypass.
      // Password-only UAT never accepts Access identity in place of a password session.
      let ownerId = env.PASSWORD_ONLY_UAT === "true" ? null : await authorize(request, env);
      let passwordSession = false;
      if (!ownerId) {
        try { ownerId = await sessionOwner(request, env.DB as unknown as Parameters<typeof sessionOwner>[1]); passwordSession = ownerId === "owner"; }
        catch { ownerId = null; }
      }
      if (ownerId !== "owner") return new Response("Forbidden", { status: 403, headers: privateHeaders });

      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) {
        if (path === "/api/weight/trend") return handleWeightTrend(request, env.DB as unknown as TrendDb, ownerId);
        if (path === "/api/manual/records" || path === "/api/manual/weight" || path === "/api/manual/steps") return handleManualEntry(request, env.DB as unknown as ManualDb, ownerId,
          env.MANUAL_ENTRY_LOCAL_ONLY, {
            // Remote writes without Access require an authenticated password session AND explicit UAT opt-in.
            enabled: env.PASSWORD_ONLY_UAT === "true" && !passwordSession ? "false" : env.MANUAL_REMOTE_WRITE_ENABLED,
            target: env.MANUAL_REMOTE_TARGET,
            origin: env.MANUAL_REMOTE_ORIGIN,
          });
        if (path === "/api/import/history" || path.startsWith("/api/import/history/")) return handleAuditHistory(request,env.DB as unknown as ImportDb,ownerId);
        if (path === "/api/import/confirm") {
          if (request.method !== "POST") {
            return Response.json({ error: "METHOD" }, { status: 405, headers: { ...privateHeaders, Allow: "POST" } });
          }
          // Signed owner verification above AND a trusted local-runtime opt-in
          // are required before ANY confirm-path D1 read or write.
          if (!isSafeLocalImport(request, env.IMPORT_LOCAL_ONLY)) {
            return Response.json({ error: "LOCAL_IMPORT_DISABLED" }, { status: 403, headers: privateHeaders });
          }
          return handleImport(request,env.DB as unknown as ImportDb,ownerId);
        }
        if (path === "/api/import/preview") return handleImport(request,env.DB as unknown as ImportDb,ownerId);
        if (path !== "/api/summary") return Response.json({ error: "Not found" }, { status: 404, headers: privateHeaders });
        if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...privateHeaders, Allow: "GET" } });
        try {
          const summary = await getSummary(env.DB, ownerId);
          return Response.json(summary, { headers: privateHeaders });
        } catch {
          return Response.json({ error: "Data temporarily unavailable" }, { status: 503, headers: privateHeaders });
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: privateHeaders });
      if (!env.ASSETS) return new Response("Assets unavailable", { status: 503, headers: privateHeaders });
      try {
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        for (const [name, value] of Object.entries(privateHeaders)) headers.set(name, value);
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
      } catch {
        return new Response("Assets unavailable", { status: 503, headers: privateHeaders });
      }
    },
  };
}

export default createHandler();
