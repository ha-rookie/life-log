// WORKHUB-compatible Cloudflare Workers Node.js crypto interface.
// Narrow declaration only; avoids widening application ambient Node types.
declare module "node:crypto" {
  export function scrypt(
    password: string,
    salt: Uint8Array,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
    callback: (error: Error | null, derivedKey: Uint8Array) => void,
  ): void;
}
