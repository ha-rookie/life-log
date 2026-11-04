import { createRemoteJWKSet, jwtVerify } from "jose";

// A signed Access JWT is required on every request. Do not trust unverified
// CF-Access-Authenticated-User-Email, Cookie, X-User, or locally forged headers.
export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
}

type KeyResolver = Parameters<typeof jwtVerify>[1];
const jwksCache = new Map<string, KeyResolver>();

function remoteKeys(team: string): KeyResolver {
  let keys = jwksCache.get(team);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, keys);
  }
  return keys;
}

export async function verifyOwner(
  request: Request,
  env: AccessEnv,
  keysOverride?: KeyResolver,
): Promise<"owner" | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const audience = env.ACCESS_AUD?.trim();
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!team || !audience || !owner || !token) return null;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !owner.includes("@")) return null;
  try {
    const { payload } = await jwtVerify(token, keysOverride ?? remoteKeys(team), {
      issuer: `https://${team}`,
      audience,
      algorithms: ["RS256"],
    });
    return typeof payload.email === "string" && payload.email.trim().toLowerCase() === owner
      ? "owner"
      : null;
  } catch {
    return null;
  }
}
