import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyOwner } from "../src/worker/auth";

const domain = "testteam.cloudflareaccess.com";
const env = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "test-audience", OWNER_EMAIL: "owner@example.invalid" };

describe("signed Cloudflare Access identity", () => {
  async function fixture() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", kid: "test-key" }] });
    const sign = (email: string, overrides: { issuer?: string; audience?: string; expired?: boolean } = {}) => {
      const expires = overrides.expired ? Math.floor(Date.now() / 1000) - 60 : Math.floor(Date.now() / 1000) + 300;
      return new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(overrides.issuer ?? `https://${domain}`)
        .setAudience(overrides.audience ?? "test-audience")
        .setIssuedAt().setExpirationTime(expires).sign(privateKey);
    };
    return { keys, sign };
  }
  it("accepts only correctly signed identity and matching owner", async () => {
    const { keys, sign } = await fixture();
    const jwt = await sign("owner@example.invalid");
    expect(await verifyOwner(new Request("https://app.example.invalid/", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env, keys)).toBe("owner");
    for (const token of [
      await sign("someoneelse@example.invalid"), await sign("owner@example.invalid",{audience:"bad"}),
      await sign("owner@example.invalid",{issuer:"https://other.cloudflareaccess.com"}),
      await sign("owner@example.invalid",{expired:true}),
    ]) {
      expect(await verifyOwner(new Request("https://app.example.invalid/", { headers: { "Cf-Access-Jwt-Assertion": token } }), env, keys)).toBeNull();
    }
  });
  it("rejects missing config, spoofed headers and forged token", async () => {
    const { keys } = await fixture();
    const req = new Request("https://app.example.invalid/", { headers: { "Cf-Access-Authenticated-User-Email": env.OWNER_EMAIL } });
    expect(await verifyOwner(req, env, keys)).toBeNull();
    expect(await verifyOwner(new Request("https://app.example.invalid/", {headers:{"Cf-Access-Jwt-Assertion":"forged"}}), env, keys)).toBeNull();
    expect(await verifyOwner(req, { ...env, ACCESS_AUD: "" }, keys)).toBeNull();
    expect(await verifyOwner(req, { ...env, ACCESS_TEAM_DOMAIN: "attacker.invalid" }, keys)).toBeNull();
  });
});
