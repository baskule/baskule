import { describe, expect, it, vi } from "vitest";
import { ConnectionCipher, digest, pkce } from "../../src/control/connection-crypto";
import { canonicalResource, discoverOAuth } from "../../src/control/connection-oauth";
import { loginIdentityAudience, microsoftAudience } from "../../src/control/connections";
import { asAdmin, call, createUser, makeService, ORIGIN, personalSpaceOf, signIn, type H } from "../support/harness";
import { fakeOAuth } from "../fixtures/oauth.mjs";
import type { PluginServer } from "../../../app/packages/contracts/src/baskule-plugins";
import { INTERNAL_HEADER } from "../../src/shared/contract";

const API = "/api/baskule";
async function install(h: H, resource: string) {
  const a = await asAdmin(h);
  const p = (await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { source: { type: "url", url: resource } } })).body;
  await call(h, "PATCH", `${API}/admin/plugins/${p.id}`, { creds: a.creds, body: { enabled: true, servers: [{ name: "remote", credential: "user-oauth", personal: true }] } });
  await call(h, "PATCH", `${API}/admin/groups/everyone`, { creds: a.creds, body: { plugins: [p.id] } });
  await call(h, "PUT", `${API}/plugins/${p.id}/enabled`, { creds: a.creds, body: { enabled: true } });
  const input = { spaceId: personalSpaceOf(h, a.userId), userId: a.userId, pluginId: p.id, server: "remote" };
  return { a, p, input, start: () => call(h, "GET", `${API}/plugins/${p.id}/connect`, { creds: a.creds }),
    credential: () => call(h, "POST", "/_baskule/plugin-credential", { headers: { [INTERNAL_HEADER]: "1" }, body: input }) };
}
async function authorized(start: Awaited<ReturnType<typeof call>>) {
  expect(start.status, JSON.stringify(start.body)).toBe(302);
  const url = start.headers.get("location")!;
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get("location")!);
  return callback.pathname + callback.search;
}

describe("connection primitives", () => {
  it("derives an authenticated encryption key and binds ciphertext to its row", async () => {
    const cipher = new ConnectionCipher("installation-secret");
    const encrypted = await cipher.seal({ access: "private", refresh: "private-refresh" }, "alice:plugin:server");
    expect(encrypted).not.toContain("private");
    expect(await cipher.open(encrypted, "alice:plugin:server")).toEqual({ access: "private", refresh: "private-refresh" });
    expect(await cipher.seal({ access: "private" }, "alice:plugin:server")).not.toBe(encrypted);
    await expect(cipher.open(encrypted, "bob:plugin:server")).rejects.toThrow();
    await expect(new ConnectionCipher("other-secret").open(encrypted, "alice:plugin:server")).rejects.toThrow();
  });
  it("uses S256 PKCE with 256-bit independent verifiers", async () => {
    const proof = await pkce();
    expect(proof.verifier).toMatch(/^[\w-]{43}$/);
    expect(proof.challenge).toBe(await digest(proof.verifier));
    expect((await pkce()).verifier).not.toBe(proof.verifier);
  });
  it("canonicalizes resources and rejects insecure or ambiguous targets", () => {
    expect(canonicalResource("https://MCP.example.test")).toBe("https://mcp.example.test");
    for (const u of ["http://example.test/mcp", "https://example.test/mcp#fragment", "https://example.test/mcp?q=1", "https://user:pass@example.test/mcp"]) expect(() => canonicalResource(u)).toThrow();
  });
  it("only permits provider-owned destinations with the declared resource audience", () => {
    const google: PluginServer = { name: "g", url: "https://bigquery.googleapis.com/mcp", credential: "login-identity", personal: true, loginIdentity: { provider: "google", scopes: ["https://www.googleapis.com/auth/cloud-platform"], audience: "https://bigquery.googleapis.com/mcp" } };
    expect(loginIdentityAudience(google)).toBe(true);
    for (const u of ["https://googleapis.com.evil.test/mcp", "https://customer.googleapis.com.evil.test/mcp", "https://mcp.customer.test/mcp", "https://bigquery.googleapis.com/redirect", "https://bigquery.googleapis.com/mcp?redirect=x", "http://bigquery.googleapis.com/mcp"]) expect(loginIdentityAudience({ ...google, url: u })).toBe(false);
    expect(loginIdentityAudience({ ...google, loginIdentity: { ...google.loginIdentity!, audience: "https://other.googleapis.com/mcp" } })).toBe(false);
    const microsoft: PluginServer = { ...google, url: "https://workiq.svc.cloud.microsoft/mcp", loginIdentity: { provider: "microsoft", scopes: ["api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask"], audience: "api://workiq.svc.cloud.microsoft" } };
    expect(loginIdentityAudience(microsoft)).toBe(true);
    expect(loginIdentityAudience({ ...microsoft, loginIdentity: { ...microsoft.loginIdentity!, audience: "https://graph.microsoft.com" } })).toBe(false);
    const jwt = (aud: string, exp = Date.now() / 1000 + 3600) => `header.${Buffer.from(JSON.stringify({ aud, exp })).toString("base64url")}.signature`;
    expect(microsoftAudience(jwt("api://workiq.svc.cloud.microsoft"), "api://workiq.svc.cloud.microsoft")).toBe(true);
    expect(microsoftAudience(jwt("https://graph.microsoft.com"), "api://workiq.svc.cloud.microsoft")).toBe(false);
    expect(microsoftAudience(jwt("api://workiq.svc.cloud.microsoft", 0), "api://workiq.svc.cloud.microsoft")).toBe(false);
  });
});

describe("MCP OAuth connections", () => {
  it("discovers resource → AS metadata, refuses mismatched resource/issuer and missing S256", async () => {
    const f = await fakeOAuth();
    try {
      expect(await discoverOAuth(f.resource)).toMatchObject({ resource: f.resource, scopes: ["files.read"], as: { issuer: f.issuer } });
      f.state.resourceMismatch = true;
      await expect(discoverOAuth(f.resource)).rejects.toMatchObject({ code: "oauth_resource_mismatch" });
      f.state.resourceMismatch = false; f.state.issuerMismatch = true;
      await expect(discoverOAuth(f.resource)).rejects.toMatchObject({ code: "invalid_authorization_metadata" });
      f.state.issuerMismatch = false; f.state.pkce = false;
      await expect(discoverOAuth(f.resource)).rejects.toMatchObject({ code: "invalid_authorization_metadata" });
    } finally { await f.close(); }
  });
  it("uses the RFC 8414 and both OIDC metadata locations for an issuer with a path", async () => {
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const u = String(input); seen.push(u);
      if (u === "https://resource.test/mcp") return new Response(null, { status: 401 });
      if (u === "https://resource.test/.well-known/oauth-protected-resource") return Response.json({ resource: "https://resource.test/mcp", authorization_servers: ["https://idp.test/tenant"] });
      if (u === "https://idp.test/tenant/.well-known/openid-configuration") return Response.json({ issuer: "https://idp.test/tenant", authorization_endpoint: "https://idp.test/authorize", token_endpoint: "https://idp.test/token", code_challenge_methods_supported: ["S256"], response_types_supported: ["code"] });
      return new Response(null, { status: 404 });
    };
    expect((await discoverOAuth("https://resource.test/mcp", fetcher)).as.issuer).toBe("https://idp.test/tenant");
    expect(seen).toEqual(["https://resource.test/mcp", "https://resource.test/.well-known/oauth-protected-resource/mcp", "https://resource.test/.well-known/oauth-protected-resource", "https://idp.test/.well-known/oauth-authorization-server/tenant", "https://idp.test/.well-known/openid-configuration/tenant", "https://idp.test/tenant/.well-known/openid-configuration"]);
  });
  it("completes PKCE/DCR with resource on both requests, encrypts tokens, lists state and disconnects", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      expect((await x.credential()).body).toMatchObject({ error: "needs_connection", connectUrl: `${API}/plugins/${x.p.id}/connect?server=remote` });
      const start = await x.start();
      const authorize = new URL(start.headers.get("location")!);
      expect(authorize.searchParams.get("resource")).toBe(f.resource);
      const callback = await authorized(start);
      const done = await call(h, "GET", callback, { creds: x.a.creds });
      expect(done.headers.get("location")).toContain("pluginConnection=connected");
      expect(f.state.registrations).toBe(1); expect(f.state.exchanges).toBe(1);
      const credential = await x.credential();
      expect(credential.body.headers.Authorization).toMatch(/^Bearer /);
      expect(credential.body.expiresAt).toBeGreaterThan(Date.now());
      expect((await fetch(f.resource, { headers: credential.body.headers })).status).toBe(200);
      const ciphertext = h.storage.sql.exec("select data from plugin_connection").toArray()[0].data as string;
      expect(ciphertext).not.toContain(credential.body.headers.Authorization.slice(7));
      expect(ciphertext).not.toContain("refreshToken");
      expect(f.requests[0]).toMatchObject({ grant_type: "authorization_code", resource: f.resource });
      expect((await call(h, "GET", `${API}/plugins`, { creds: x.a.creds })).body.plugins[0].connections).toEqual([{ server: "remote", state: "connected" }]);
      expect((await call(h, "GET", callback, { creds: x.a.creds })).body.error).toBe("invalid_oauth_state");
      await call(h, "DELETE", `${API}/plugins/${x.p.id}/connection`, { creds: x.a.creds });
      expect((await x.credential()).body.error).toBe("needs_connection");
    } finally { await f.close(); }
  });
  it("binds state to user/session/origin, expires it and validates callback issuer before token exchange", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      const bob = await createUser(h, x.a.creds, "bob@os.test", "Bob");
      const b = await signIn(h, bob.email, "user-password-1");
      const callback = await authorized(await x.start());
      expect((await call(h, "GET", callback, { creds: b.creds })).body.error).toBe("invalid_oauth_state");
      const wrongOrigin = await h.svc.handle(new Request("http://other.test" + callback, { headers: { cookie: x.a.creds.cookie! } }));
      expect((await wrongOrigin.json() as { error: string }).error).toBe("invalid_oauth_state");
      const a2 = await asAdmin(h);
      expect((await call(h, "GET", callback, { creds: a2.creds })).body.error).toBe("invalid_oauth_state");
      const forged = new URL(ORIGIN + callback); forged.searchParams.set("iss", f.issuer + "/wrong");
      const done = await call(h, "GET", forged.pathname + forged.search, { creds: x.a.creds });
      expect(done.headers.get("location")).toContain("oauth_issuer_mismatch");
      expect(f.state.exchanges).toBe(0);
      const expired = await authorized(await x.start());
      h.storage.sql.exec("update plugin_oauth_state set expires_at=0").toArray();
      expect((await call(h, "GET", expired, { creds: x.a.creds })).body.error).toBe("invalid_oauth_state");
      const start = await call(h, "GET", `${API}/plugins/${x.p.id}/connect?returnTo=https://evil.test`, { creds: x.a.creds });
      expect(start.body.error).toBe("invalid_return_url");
    } finally { await f.close(); }
  });
  it("refreshes on demand once for concurrent calls, rotates refresh tokens and handles invalid grants", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      const callback = await authorized(await x.start());
      await call(h, "GET", callback, { creds: x.a.creds });
      f.state.shortLived = false;
      const results = await Promise.all([x.credential(), x.credential()]);
      expect(results[0].body.headers).toEqual(results[1].body.headers);
      for (const result of results) expect(result.body.expiresAt).toBeGreaterThan(Date.now());
      expect(f.state.refreshes).toBe(1);
      expect(f.requests[1]).toMatchObject({ grant_type: "refresh_token", resource: f.resource });
      // Force expiry without a fixed sleep.
      const cipher = new ConnectionCipher(h.storage.sql.exec("select value from kv where key='auth_secret'").toArray()[0].value as string);
      const key = JSON.stringify([x.a.userId, x.p.id, "remote"]);
      const row = h.storage.sql.exec("select data from plugin_connection").toArray()[0];
      const c = await cipher.open<any>(row.data as string, key); c.oauth.tokens.expiresAt = 0;
      h.storage.sql.exec("update plugin_connection set data=?", await cipher.seal(c, key)).toArray();
      f.state.invalidGrant = true;
      expect((await x.credential()).body.error).toBe("needs_connection");
      expect(h.storage.sql.exec("select * from plugin_connection").toArray()).toEqual([]);
    } finally { await f.close(); }
  });
  it("never reads/refreshes personal credentials when team policy, grants or enablement refuse them", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
      const team = (await call(h, "POST", `${API}/spaces`, { creds: x.a.creds, body: { name: "Team" } })).body.space.id;
      const resolve = () => h.svc.connections.credential({ ...x.input, spaceId: team });
      expect(await resolve()).toEqual({ error: "not_allowed" }); expect(f.state.refreshes).toBe(0);
      await call(h, "PUT", `${API}/spaces/${team}/plugins`, { creds: x.a.creds, body: { personalPluginsAllowed: true, disabled: [] } });
      expect(await resolve()).toHaveProperty("headers.Authorization"); expect(f.state.refreshes).toBe(1);
      await call(h, "PATCH", `${API}/admin/groups/everyone`, { creds: x.a.creds, body: { plugins: [] } });
      expect((await x.credential()).body).toEqual({ error: "not_allowed" });
      expect((await call(h, "POST", "/_baskule/plugin-credential", { body: x.input })).status).toBe(404);
    } finally { await f.close(); }
  });
  it("does not restore a connection disconnected during refresh or callback exchange", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
      const disconnect = async () => { await call(h, "DELETE", `${API}/plugins/${x.p.id}/connection`, { creds: x.a.creds }); };
      f.state.onRefresh = disconnect;
      expect((await x.credential()).body.error).toBe("needs_connection");
      expect(h.storage.sql.exec("select * from plugin_connection").toArray()).toEqual([]);
      f.state.onExchange = disconnect;
      const done = await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
      expect(done.headers.get("location")).toContain("pluginConnection=error");
      expect(h.storage.sql.exec("select * from plugin_connection").toArray()).toEqual([]);
    } finally { await f.close(); }
  });
  it("uses encrypted admin client settings when DCR is unavailable and invalidates existing grants on change", async () => {
    const f = await fakeOAuth(); f.state.dcr = false;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      expect((await x.start()).body.error).toBe("oauth_client_configuration_required");
      const clientPath = `${API}/admin/plugins/${x.p.id}/oauth`;
      expect((await call(h, "PUT", clientPath, { creds: x.a.creds, body: { server: "remote", client: { clientId: "fake-client", clientSecret: "private-secret", tokenEndpointAuthMethod: "client_secret_post" } } })).status).toBe(200);
      expect(JSON.stringify(h.storage.sql.exec("select * from plugin_oauth_client").toArray())).not.toContain("private-secret");
      await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
      expect(f.requests[0].client_secret).toBe("private-secret");
      expect(JSON.stringify((await call(h, "GET", `${API}/admin/plugins`, { creds: x.a.creds })).body)).not.toContain("private-secret");
      await call(h, "PUT", clientPath, { creds: x.a.creds, body: { server: "remote", client: null } });
      expect((await x.credential()).body.error).toBe("needs_connection");
    } finally { await f.close(); }
  });
});

describe("login identity connections", () => {
  it("uses Better Auth incremental consent for the selected login account and keeps credentials server-side", async () => {
    const h = await makeService({ AUTH_CONFIG: JSON.stringify({ providers: [{ id: "google", name: "Google", type: "social", options: { clientId: "test-id", clientSecret: "test-secret" } }] }) });
    const x = await install(h, "https://bigquery.googleapis.com/mcp");
    const identity = { provider: "google", scopes: ["https://www.googleapis.com/auth/cloud-platform"], audience: "https://bigquery.googleapis.com/mcp" };
    await call(h, "PATCH", `${API}/admin/plugins/${x.p.id}`, { creds: x.a.creds, body: { servers: [{ name: "remote", credential: "login-identity", personal: true, loginIdentity: identity }] } });
    expect((await x.start()).body.error).toBe("login_account_required");
    const ctx = await h.svc.auth.$context;
    // Better Auth's internal adapter expects already encrypted tokens, just like its callback's setTokenUtil.
    const { symmetricEncrypt } = await import("better-auth/crypto");
    const account = await ctx.internalAdapter.createAccount({ userId: x.a.userId, providerId: "google", accountId: "google-subject", scope: identity.scopes.join(","),
      accessToken: await symmetricEncrypt({ key: ctx.secretConfig, data: "provider-access" }), refreshToken: await symmetricEncrypt({ key: ctx.secretConfig, data: "provider-refresh" }), accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
    const start = await x.start();
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.get("location")!);
    expect(auth.origin).toBe("https://accounts.google.com");
    expect(auth.searchParams.get("scope")).toContain(identity.scopes[0]);
    expect(auth.searchParams.get("access_type")).toBe("offline");
    expect(auth.searchParams.get("prompt")).toBe("consent");
    expect(auth.searchParams.get("include_granted_scopes")).toBe("true");
    expect(auth.searchParams.get("login_hint")).toBe("admin@os.test");
    expect(start.headers.getSetCookie().length).toBeGreaterThan(0);
    // Simulate only the post-Better-Auth return; provider callbacks themselves are covered by the OIDC fixture.
    const pending = h.storage.sql.exec("select state_hash,data from plugin_oauth_state").toArray()[0];
    const cipher = new ConnectionCipher(h.storage.sql.exec("select value from kv where key='auth_secret'").toArray()[0].value as string);
    const stateData = await cipher.open<any>(pending.data as string, pending.state_hash as string);
    const getTokens = vi.spyOn(h.svc.auth.api, "getAccessToken");
    // The state plaintext is intentionally unavailable in SQLite; derive the return from Better Auth's encrypted state.
    // Consume the pending using a known random state in a test-only sealed record.
    const state = "a".repeat(43), hash = await digest(state);
    h.storage.sql.exec("update plugin_oauth_state set state_hash=?,data=?", hash, await cipher.seal(stateData, hash)).toArray();
    const done = await call(h, "GET", `${API}/plugins/oauth/callback?state=${state}`, { creds: x.a.creds });
    expect(done.headers.get("location")).toContain("pluginConnection=connected");
    expect((await x.credential()).body).toMatchObject({ headers: { Authorization: "Bearer provider-access" }, expiresAt: expect.any(Number) });
    expect(getTokens).toHaveBeenCalledWith({ body: { userId: x.a.userId, accountId: account.id } });
    getTokens.mockRestore();
    await call(h, "DELETE", `${API}/plugins/${x.p.id}/connection`, { creds: x.a.creds });
    expect((await x.credential()).body.error).toBe("needs_connection");
    expect(h.storage.sql.exec("select id from account where id=?", account.id).toArray()).toHaveLength(1);
    expect((await call(h, "POST", "/auth/link-social", { creds: x.a.creds, body: { provider: "google", idToken: { token: "forged", accessToken: "caller-token" } } })).body.error).toBe("provider_code_flow_required");
  });
  it("refuses a third-party wrapper and unavailable login providers before consent", async () => {
    const h = await makeService(); const x = await install(h, "https://customer.test/mcp");
    await call(h, "PATCH", `${API}/admin/plugins/${x.p.id}`, { creds: x.a.creds, body: { servers: [{ name: "remote", credential: "login-identity", personal: true,
      loginIdentity: { provider: "google", scopes: ["drive.read"], audience: "https://customer.test/mcp" } }] } });
    expect((await x.start()).body.error).toBe("login_identity_audience_refused");
  });
  it("rejects a different provider subject even if the email matches", async () => {
    const h = await makeService({ AUTH_CONFIG: JSON.stringify({ providers: [{ id: "google", name: "Google", type: "social", options: { clientId: "test-id", clientSecret: "test-secret" } }] }) });
    const a = await asAdmin(h);
    const ctx = await h.svc.auth.$context;
    await ctx.internalAdapter.createAccount({ userId: a.userId, providerId: "google", accountId: "original-subject" });
    const validate = ctx.options.user!.validateUserInfo!;
    const result = await validate({ user: { id: a.userId, email: "admin@os.test" }, source: { action: "link-account", method: "oauth", oauth: { providerId: "google", profile: { sub: "different-subject", email: "admin@os.test" } } } });
    expect(result).toMatchObject({ error: "login_account_mismatch" });
  });
  it("refreshes Microsoft through Better Auth with the account's granted audience scopes", async () => {
    const h = await makeService({ AUTH_CONFIG: JSON.stringify({ providers: [{ id: "microsoft", name: "Microsoft", type: "social", options: { clientId: "test-id", clientSecret: "test-secret", tenantId: "tenant", disableDefaultScope: true, scope: ["openid", "email", "profile", "offline_access"] } }] }) });
    const a = await asAdmin(h); const ctx = await h.svc.auth.$context;
    const { symmetricEncrypt } = await import("better-auth/crypto");
    const account = await ctx.internalAdapter.createAccount({ userId: a.userId, providerId: "microsoft", accountId: "oid", scope: "openid,offline_access,api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
      accessToken: await symmetricEncrypt({ key: ctx.secretConfig, data: "expired-access" }), refreshToken: await symmetricEncrypt({ key: ctx.secretConfig, data: "refresh" }), accessTokenExpiresAt: new Date(0) });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/token");
      const params = new URLSearchParams(init?.body as string);
      expect(params.get("scope")).toContain("api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask");
      expect(params.get("scope")).not.toContain("User.Read");
      return Response.json({ access_token: "refreshed-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
    });
    try {
      expect((await h.svc.auth.api.getAccessToken({ body: { userId: a.userId, accountId: account.id } })).accessToken).toBe("refreshed-access");
      const stored = h.storage.sql.exec("select access_token,refresh_token,id_token from account where id=?", account.id).toArray()[0];
      expect(stored.access_token).not.toContain("refreshed-access"); expect(stored.refresh_token).not.toContain("rotated-refresh"); expect(stored.id_token).toBeNull();
    } finally { fetcher.mockRestore(); }
  });
});
