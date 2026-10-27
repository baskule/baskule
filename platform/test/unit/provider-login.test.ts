import { createServer } from "node:http";
import { defaultSettings } from "../../src/control/settings";
import { describe, expect, it } from "vitest";
import { makeService, call, cookieFrom } from "../support/harness";

describe("OIDC admission", () => {
  it("verifies a provider identity, permits existing invited users, and refuses unsolicited registration", async () => {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
    let issuer = "";
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/jwks" ? { keys: [jwk] } : {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const idToken = async (email: string, verified = true, aud = "baskule-test") => {
      const payload = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({ iss: issuer, aud, sub: email, email, email_verified: verified, name: "Test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(payload));
      return `${payload}.${Buffer.from(signature).toString("base64url")}`;
    };
    try {
      const h = await makeService({ AUTH_CONFIG: JSON.stringify({ password: false, providers: [{
        id: "company", name: "Company SSO", type: "oidc", options: { clientId: "baskule-test", clientSecret: "test-secret", discoveryUrl: `${issuer}/.well-known/openid-configuration`, scopes: ["openid", "email", "profile"] },
      }] }) });
      const login = async (email: string, verified = true, aud?: string) => call(h, "POST", "/auth/sign-in/social", { body: { provider: "company", requestSignUp: true, idToken: { token: await idToken(email, verified, aud), accessToken: "oidc-fixture-access", refreshToken: "oidc-fixture-refresh" } } });
      // The configured OIDC provider remains invitation-only even with matching Google signup domains.
      h.storage.sql.exec("insert into kv(key,value) values ('product_settings', ?)", JSON.stringify({ ...defaultSettings, googleSignupDomains: ["os.test"] }));
      const unknown = await login("outsider@os.test");
      expect(unknown.status).not.toBe(200);
      expect(h.storage.sql.exec("select id from user where email='outsider@os.test'").toArray()).toEqual([]);
      expect((await login("admin@os.test", false)).status).not.toBe(200);
      expect((await login("admin@os.test", true, "another-app")).status).not.toBe(200);
      const admin = await login("admin@os.test");
      expect(admin.status, JSON.stringify(admin.body)).toBe(200);
      const me = await call(h, "GET", "/api/baskule/me", { creds: { cookie: cookieFrom(admin) } });
      expect(me.body.user.role).toBe("admin");
      const account = h.storage.sql.exec("select id,user_id,access_token,refresh_token,id_token from account where provider_id='company'").toArray()[0];
      expect(account.access_token).not.toBe("oidc-fixture-access");
      expect(account.refresh_token).not.toBe("oidc-fixture-refresh");
      expect(account.id_token).toBeNull();
      expect((await h.svc.auth.api.getAccessToken({ body: { accountId: account.id as string, userId: account.user_id as string } })).accessToken).toBe("oidc-fixture-access");
      expect((await call(h, "POST", "/auth/sign-in/email", { body: { email: "admin@os.test", password: "admin-password-1" } })).status).not.toBe(200);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
