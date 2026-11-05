import { verifyOwner, type AccessEnv } from "./auth";
import { getSummary, type Database } from "./summary";
import { handleImport, isSafeLocalImport, type ImportDb } from "./import";
import { handleAuditHistory } from "./audit-history";

export interface Env extends AccessEnv {
  DB: Database;
  // Opt-in must be set only in a trusted loopback-local runtime, never deployed.
  IMPORT_LOCAL_ONLY?: string;
  ASSETS: { fetch(input: Request): Promise<Response> };
}

type Authorizer = (request: Request, env: AccessEnv) => Promise<"owner" | null>;
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function createHandler(authorize: Authorizer = verifyOwner) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      // Every pathname, including index.html and hashed assets, enters this gate.
      // No unauthenticated /health, static-asset exception, or dev bypass.
      const ownerId = await authorize(request, env);
      if (ownerId !== "owner") return new Response("Forbidden", { status: 403, headers: privateHeaders });

      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) {
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
