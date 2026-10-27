const enc = new TextEncoder();
export const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(s: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}
export async function pkce() {
  const verifier = randomSecret();
  return { verifier, challenge: await digest(verifier) };
}

/** Domain-separated installation key; row identity is authenticated to prevent ciphertext swapping. */
export class ConnectionCipher {
  private key: Promise<CryptoKey>;
  constructor(secret: string) {
    this.key = crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]).then(k =>
      crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("Baskule/0.4.0"), info: enc.encode("plugin-connections") }, k,
        { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  }
  async seal(value: unknown, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, await this.key, enc.encode(JSON.stringify(value)));
    return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
  }
  async open<T>(value: string, context: string): Promise<T> {
    const [iv, ciphertext] = value.split(".");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: enc.encode(context) }, await this.key, bytes(ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }
}
