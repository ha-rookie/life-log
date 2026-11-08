// Cloudflare Workers 2026-11+ supports the native Node.js crypto API.
// Limited local typing because this project intentionally excludes broad Node globals.
// Node Buffer is a Uint8Array; no ambient Buffer or other Node types are required.
declare module "node:crypto" {
  export function pbkdf2Sync(
    password: string,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: "sha256",
  ): Uint8Array;
}
