// Signed OIDC browser round-trip on stock celld; all processes and credentials are disposable.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, openSync, closeSync } from "node:fs";

const [app, base, celld] = process.argv.slice(2);
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "integration", alg: "RS256", use: "sig" };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
let issuer;
let identity = "admin@it.test";
let nonce;
const idp = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/token") {
    const payload = `${encode({ alg: "RS256", kid: jwk.kid })}.${encode({ iss: issuer, aud: "baskule-test", sub: identity, nonce, email: identity, email_verified: true, name: "SSO admin", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(payload));
    return res.end(JSON.stringify({ access_token: "fixture-access", token_type: "Bearer", id_token: `${payload}.${Buffer.from(signature).toString("base64url")}` }));
  }
  res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] }));
});
await new Promise(resolve => idp.listen(0, "127.0.0.1", resolve));
issuer = `http://127.0.0.1:${idp.address().port}`;
appendFileSync(`${app}/.dev.vars`, `\nAUTH_CONFIG=${JSON.stringify({ password: false, providers: [{ id: "company", name: "Company", type: "oidc", options: { clientId: "baskule-test", clientSecret: "fixture-secret", discoveryUrl: `${issuer}/.well-known/openid-configuration`, scopes: ["openid", "email", "profile"] } }] })}\n`);
const fd = openSync(`${app}/../oidc-celld.log`, "w");
const child = spawn(celld, ["dev", app, "--port", new URL(base).port, "--no-watch", "--logs", "--clean"], { stdio: ["ignore", fd, fd] });
const exited = new Promise(resolve => child.once("exit", resolve));
const cookies = new Map();
const request = async (path, body, formPost = false) => {
  const r = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", redirect: "manual", headers: { origin: formPost ? issuer : base, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...(body ? { "content-type": formPost ? "application/x-www-form-urlencoded" : "application/json" } : {}) }, body: body ? formPost ? new URLSearchParams(body) : JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [name, ...value] = c.split(";")[0].split("="); cookies.set(name, value.join("=")); }
  return r;
};
try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const r = await request("/"); await r.body?.cancel(); break; } catch (error) {
      if (child.exitCode !== null || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100)); // no-fixed-sleep-allow: Retry server readiness until the deadline or child exit.
    }
  }
  const login = async (email, formPost = false) => {
    identity = email;
    const start = await request("/auth/sign-in/social", { provider: "company", callbackURL: "/", errorCallbackURL: "/login?error=provider", disableRedirect: true, requestSignUp: true });
    assert.equal(start.status, 200);
    const authorize = new URL((await start.json()).url);
    nonce = authorize.searchParams.get("nonce");
    const callback = new URL(authorize.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", authorize.searchParams.get("state"));
    callback.searchParams.set("code", "fixture-code");
    if (!formPost) return request(callback.pathname + callback.search);
    const posted = await request(callback.pathname, Object.fromEntries(callback.searchParams), true);
    assert.equal(posted.status, 302);
    const redirected = new URL(posted.headers.get("location"), base);
    assert.equal(redirected.origin, base);
    return request(redirected.pathname + redirected.search);
  };
  const outsider = await login("outsider@it.test");
  assert.match(outsider.headers.get("location"), /error=/);
  assert.equal((await request("/api/baskule/me")).status, 401);
  const admin = await login("admin@it.test");
  assert.equal(admin.status, 302);
  assert.equal(new URL(admin.headers.get("location"), base).href, `${base}/`);
  const me = await request("/api/baskule/me");
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.role, "admin");
  await request("/auth/sign-out", {}); cookies.clear();
  assert.equal((await login("admin@it.test", true)).status, 302);
  assert.equal((await request("/api/baskule/me")).status, 200);
  assert.equal((await request("/auth/callback/unknown", { code: "forged", state: "forged" }, true)).status, 403);
  console.log("OIDC: signed GET/form_post callbacks on stock celld admit the existing admin and refuse public registration");
} finally {
  child.kill("SIGTERM"); await exited; closeSync(fd);
  idp.closeAllConnections(); await new Promise(resolve => idp.close(resolve));
}
