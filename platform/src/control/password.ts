// celld 0.6.3 lacks node:crypto scrypt, and Better Auth's `workerd` export picks it. This replacement uses
// @noble/hashes scrypt with Better Auth's exact parameters and format (`<salt hex>:<key hex>`, N=16384 r=16 p=1
// dkLen=64, NFKC), so hashes stay portable to Node/Bun. Tested in spikes/auth-better-auth (≈0.26 s per hash in a DO).
import { scryptAsync } from "@noble/hashes/scrypt.js";

const PARAMS = { N: 16384, r: 16, p: 1, dkLen: 64, maxmem: 128 * 16384 * 16 * 2 };
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const key = await scryptAsync(password.normalize("NFKC"), salt, PARAMS);
  return `${salt}:${hex(key)}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const k = await scryptAsync(password.normalize("NFKC"), salt, PARAMS);
  return equalHex(hex(k), key);
}
