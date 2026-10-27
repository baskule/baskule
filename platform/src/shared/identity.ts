import { IDENTITY_HEADER, type Identity } from "./contract";

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encodes the identity header value: base64url(JSON), with exactly the contract's keys in a fixed order. */
export function encodeIdentity(id: Identity): string {
  const { userId, name, email, role, sessionId, spaceRole } = id;
  return toBase64Url(enc.encode(JSON.stringify({ userId, name, email, role, sessionId, spaceRole })));
}

/** Decodes the identity header. Returns null when absent or malformed. For use by SpaceCell (trusts the Worker). */
export function decodeIdentity(value: string | null | undefined): Identity | null {
  if (!value) return null;
  try {
    const o = JSON.parse(dec.decode(fromBase64Url(value)));
    if (
      typeof o?.userId === "string" &&
      typeof o.sessionId === "string" &&
      typeof o.email === "string" &&
      typeof o.name === "string" &&
      (o.role === "admin" || o.role === "member") &&
      (o.spaceRole === "owner" || o.spaceRole === "member")
    )
      return o as Identity;
  } catch {}
  return null;
}

export function identityFromRequest(req: Request): Identity | null {
  return decodeIdentity(req.headers.get(IDENTITY_HEADER));
}
