import { verifyOwner, type AccessEnv } from "./auth";
import { localPreview } from "./local-preview";
import { loginScreen } from "./login-screen";
import { authRoute, sessionOwner, sessionIsPasskey } from "./password-auth";
import { getSummary, getDashboard, type Database } from "./summary";
import { handleImport, isSafeLocalImport, type ImportDb } from "./import";
import { handleEclearEnrichment, isSafeRemoteEclear } from "./eclear-enrichment-route";
import { isSafeRemoteManual } from "./manual-entry";
import { handleAuditHistory } from "./audit-history";
import { handleWeightTrend, type TrendDb } from "./weight-trend";
import { handleStepsTrend, type StepsTrendDb } from "./steps-trend";
import { handleManualEntry, type ManualDb } from "./manual-entry";
import { handleMvpFeatures, type MvpDb } from "./mvp-features";

export interface Env extends AccessEnv {
  DB: Database;
  OWNER_SETUP_CODE?: string;
  PASSWORD_ONLY_UAT?: string;
  AUTH_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  // Opt-in must be set only in a trusted loopback-local runtime, never deployed.
  IMPORT_LOCAL_ONLY?: string;
  // v2 enrichment is an independent local-only feature; never set on UAT/Production.
  ECLEAR_ENRICHMENT_LOCAL_ONLY?: string;
  ECLEAR_ENRICHMENT_REVIEW_KEY?: string;
  // Dedicated UAT v2 opt-in. Deliberately absent from every deployed config.
  ECLEAR_ENRICHMENT_REMOTE_ENABLED?: string;
  ECLEAR_ENRICHMENT_REMOTE_TARGET?: string;
  ECLEAR_ENRICHMENT_REMOTE_ORIGIN?: string;
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
      if (new URL(request.url).pathname === "/register" && request.method === "GET")
        return new Response(null,{status:302,headers:{...privateHeaders,Location:"/login"}});
      if (new URL(request.url).pathname === "/login" && request.method === "GET") return loginScreen();
      if (new URL(request.url).pathname.startsWith("/api/auth/")) return authRoute(request, env as unknown as Parameters<typeof authRoute>[1]);
      // Every other pathname, including index.html and hashed assets, enters this gate.
      // No unauthenticated /health, static-asset exception, or dev bypass.
      // Owner-only UAT never accepts Access identity in place of the WebAuthn session.
      let ownerId = env.PASSWORD_ONLY_UAT === "true" ? null : await authorize(request, env);
      let ownerSession = false;
      if (!ownerId && env.PASSWORD_ONLY_UAT === "true") {
        try { ownerId = await sessionOwner(request, env.DB as unknown as Parameters<typeof sessionOwner>[1]); ownerSession = ownerId === "owner"; }
        catch { ownerId = null; }
      }
      if (ownerId !== "owner") {
        // Only top-level browser HTML navigation gets a public sign-in entry.
        // Private APIs, other paths, assets and non-navigation requests remain 403.
        const url = new URL(request.url);
        if (request.method === "GET" &&
            (url.pathname === "/" || url.pathname === "/index.html") &&
            request.headers.get("Accept")?.includes("text/html")) {
          return new Response(null, { status: 302, headers: { ...privateHeaders, Location: "/login" } });
        }
        return new Response("Forbidden", { status: 403, headers: privateHeaders });
      }

      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) {
        if (path === "/api/weight/trend") return handleWeightTrend(request, env.DB as unknown as TrendDb, ownerId);
        if (path === "/api/steps/trend") return handleStepsTrend(request,env.DB as unknown as StepsTrendDb,ownerId);
        if (path.startsWith("/api/mvp/")) return handleMvpFeatures(request,env.DB as unknown as MvpDb,ownerId,{
          local:env.MANUAL_ENTRY_LOCAL_ONLY,
          remote:{
            enabled:env.PASSWORD_ONLY_UAT === "true" && !ownerSession ? "false" : env.MANUAL_REMOTE_WRITE_ENABLED,
            target:env.MANUAL_REMOTE_TARGET,origin:env.MANUAL_REMOTE_ORIGIN
          }
        });
        if (path === "/api/manual/records" || path === "/api/manual/weight" || path === "/api/manual/steps") return handleManualEntry(request, env.DB as unknown as ManualDb, ownerId,
          env.MANUAL_ENTRY_LOCAL_ONLY, {
            // Remote writes without Access require an authenticated Owner session AND explicit UAT opt-in.
            enabled: env.PASSWORD_ONLY_UAT === "true" && !ownerSession ? "false" : env.MANUAL_REMOTE_WRITE_ENABLED,
            target: env.MANUAL_REMOTE_TARGET,
            origin: env.MANUAL_REMOTE_ORIGIN,
          });
        if (path === "/api/eclear/enrichment/preview" || path === "/api/eclear/enrichment/confirm") {
          const remote={
            enabled:env.ECLEAR_ENRICHMENT_REMOTE_ENABLED,
            target:env.ECLEAR_ENRICHMENT_REMOTE_TARGET,
            origin:env.ECLEAR_ENRICHMENT_REMOTE_ORIGIN,
            passkeySession:false
          };
          const eclearConfig={
            enabled:env.ECLEAR_ENRICHMENT_LOCAL_ONLY,
            reviewKey:env.ECLEAR_ENRICHMENT_REVIEW_KEY,
            remote
          };
          // Remote request metadata and the independent opt-in are checked
          // before querying session credentials. Never trust request headers
          // alone or treat a legacy Owner session as a WebAuthn session.
          if(env.PASSWORD_ONLY_UAT==="true"&&ownerSession&&
             isSafeRemoteEclear(request,{...eclearConfig,remote:{...remote,passkeySession:true}})){
            try{
              remote.passkeySession=await sessionIsPasskey(
                request,env.DB as unknown as Parameters<typeof sessionIsPasskey>[1]
              );
            }catch{
              return Response.json({error:"ECLEAR_AUTH_UNAVAILABLE"},{status:503,headers:privateHeaders});
            }
          }
          return handleEclearEnrichment(request,env.DB as unknown as ImportDb,ownerId,eclearConfig);
        }
        if (path === "/api/import/history" || path.startsWith("/api/import/history/")) return handleAuditHistory(request,env.DB as unknown as ImportDb,ownerId);
        if (path === "/api/import/confirm") {
          if (request.method !== "POST") {
            return Response.json({ error: "METHOD" }, { status: 405, headers: { ...privateHeaders, Allow: "POST" } });
          }
          // Signed owner verification above AND a trusted local-runtime opt-in
          // are required before ANY confirm-path D1 read or write.
          const remoteImport = ownerSession && env.PASSWORD_ONLY_UAT === "true" &&
            isSafeRemoteManual(request, {
              enabled: env.MANUAL_REMOTE_WRITE_ENABLED,
              target: env.MANUAL_REMOTE_TARGET,
              origin: env.MANUAL_REMOTE_ORIGIN
            });
          if (!isSafeLocalImport(request, env.IMPORT_LOCAL_ONLY) && !remoteImport) {
            return Response.json({ error: "LOCAL_IMPORT_DISABLED" }, { status: 403, headers: privateHeaders });
          }
          return handleImport(request,env.DB as unknown as ImportDb,ownerId);
        }
        if (path === "/api/import/preview") return handleImport(request,env.DB as unknown as ImportDb,ownerId);
        if (path === "/api/dashboard") {
          if(request.method!=="GET")return Response.json({error:"METHOD"},{status:405,
            headers:{...privateHeaders,Allow:"GET"}});
          try {return Response.json(await getDashboard(env.DB,ownerId),{headers:privateHeaders});}
          catch {return Response.json({error:"DATA_UNAVAILABLE"},{status:503,headers:privateHeaders});}
        }
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
