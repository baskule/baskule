import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { base64, sha256 } from "../../src/control/plugin-import";
import { ConnectionCipher, digest, pkce } from "../../src/control/connection-crypto";
import { canonicalResource, discoverOAuth } from "../../src/control/connection-oauth";
import { asAdmin, call, createUser, makeService, ORIGIN, personalSpaceOf, signIn, type H } from "../support/harness";
import { fakeOAuth } from "../fixtures/oauth.mjs";
import { INTERNAL_HEADER } from "../../src/shared/contract";

const API = "/api/baskule";
async function install(h: H, resource: string) {
  const a = await asAdmin(h);
  const p = (await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { groups: [], source: { type: "url", url: resource } } })).body;
  await call(h, "PATCH", `${API}/admin/plugins/${p.id}`, { creds: a.creds, body: { enabled: true, servers: [{ name: "remote", credential: "user-oauth" }] } });
  await call(h, "PATCH", `${API}/admin/groups/everyone`, { creds: a.creds, body: { plugins: [p.id] } });
  const input = { spaceId: personalSpaceOf(h, a.userId), userId: a.userId, pluginId: p.id, server: "remote" };
  const accounts = async () => (await call(h, "GET", `${API}/plugins`, { creds: a.creds })).body.plugins.find((entry: { id: string }) => entry.id === p.id).servers.find((entry: { name: string }) => entry.name === "remote").accounts;
  return { a, p, input, start: async () => {
    const existing = (await accounts())[0];
    return call(h, "GET", `${API}/plugins/${p.id}/connect${existing ? `?account=${existing.id}` : ""}`, { creds: a.creds });
  }, disconnect: async () => {
    const existing = (await accounts())[0];
    if (existing) return call(h, "DELETE", `${API}/plugins/${p.id}/accounts/${existing.id}`, { creds: a.creds });
  }, credential: () => call(h, "POST", "/_baskule/plugin-credential", { headers: { [INTERNAL_HEADER]: "1" }, body: input }) };

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

});

describe("MCP OAuth connections", () => {
  it.each(["issuer", "token", "metadata"])("refuses private %s from a public server before contacting it", async part => {
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input); seen.push(url);
      if (url === "https://resource.test/mcp") return new Response(null, { status: 401, headers: part === "metadata" ? { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/metadata"' } : {} });
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://resource.test/mcp", authorization_servers: [part === "issuer" ? "http://127.0.0.1" : "https://idp.test"] });
      return Response.json({ issuer: "https://idp.test", authorization_endpoint: "https://idp.test/authorize", token_endpoint: "http://127.0.0.1/token", code_challenge_methods_supported: ["S256"], response_types_supported: ["code"] });
    };
    await expect(discoverOAuth("https://resource.test/mcp", fetcher)).rejects.toMatchObject({ code: "address_not_allowed" });
    expect(seen.every(url => !url.includes("127.0.0.1"))).toBe(true);
  });
  it("discovers resource → AS metadata, refuses mismatched resource/issuer and missing S256", async () => {
    const f = await fakeOAuth();
    try {
      expect(await discoverOAuth(f.resource, fetch, "private")).toMatchObject({ resource: f.resource, scopes: ["files.read"], as: { issuer: f.issuer } });
      f.state.resourceMismatch = true;
      await expect(discoverOAuth(f.resource, fetch, "private")).rejects.toMatchObject({ code: "oauth_resource_mismatch" });
      f.state.resourceMismatch = false; f.state.issuerMismatch = true;
      await expect(discoverOAuth(f.resource, fetch, "private")).rejects.toMatchObject({ code: "invalid_authorization_metadata" });
      f.state.issuerMismatch = false; f.state.pkce = false;
      await expect(discoverOAuth(f.resource, fetch, "private")).rejects.toMatchObject({ code: "invalid_authorization_metadata" });
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
  it.each(["https://accounts.google.com", "https://api.box.com"])("accepts only the authority-root slash equivalence for %s", async issuer => {
    let declared = issuer;
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://resource.test/mcp") return new Response(null, { status: 401 });
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://resource.test/mcp", authorization_servers: [issuer + "/"] });
      return Response.json({ issuer: declared, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", code_challenge_methods_supported: ["S256"], response_types_supported: ["code"] });
    };
    expect((await discoverOAuth("https://resource.test/mcp", fetcher)).as.issuer).toBe(issuer);
    expect((await discoverOAuth("https://resource.test/mcp", fetcher, "public", issuer)).as.issuer).toBe(issuer);
    for (const other of [issuer + "/tenant", "https://other.test", issuer.toUpperCase()]) {
      declared = other;
      await expect(discoverOAuth("https://resource.test/mcp", fetcher)).rejects.toMatchObject({ code: "invalid_authorization_metadata" });
    }
  });
  it("uses an explicit catalog resource without treating endpoint queries or other paths as that identifier", async () => {
    const fetcher = async (input: string | URL | Request) => {
      if (String(input) === "https://resource.test/mcp?tools=all") return new Response(null, { status: 401 });
      if (String(input).includes("oauth-protected-resource")) return Response.json({ resource: "https://resource.test", authorization_servers: ["https://idp.test"] });
      return Response.json({ issuer: "https://idp.test", authorization_endpoint: "https://idp.test/authorize", token_endpoint: "https://idp.test/token", code_challenge_methods_supported: ["S256"], response_types_supported: ["code"] });
    };
    expect((await discoverOAuth("https://resource.test/mcp?tools=all", fetcher, "public", undefined, "https://resource.test")).resource).toBe("https://resource.test");
    await expect(discoverOAuth("https://resource.test/mcp?tools=all", fetcher)).rejects.toMatchObject({ code: "invalid_oauth_resource" });
    await expect(discoverOAuth("https://resource.test/mcp?tools=all", fetcher, "public", undefined, "https://other.test")).rejects.toMatchObject({ code: "invalid_oauth_resource" });
  });
  it("completes PKCE/DCR with resource on both requests, encrypts tokens, lists state and disconnects", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      expect((await x.credential()).body).toMatchObject({ error: "connect" });
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
      expect((await call(h, "GET", `${API}/plugins`, { creds: x.a.creds })).body.plugins[0].servers).toMatchObject([{ name: "remote", credential: "user-oauth", status: "ready", accounts: [{ default: true, status: "ready" }] }]);
      expect((await call(h, "GET", callback, { creds: x.a.creds })).headers.get("location")).toContain("connectionError=invalid_oauth_state");
      await x.disconnect();
      expect((await x.credential()).body.error).toBe("connect");
    } finally { await f.close(); }
  });
  it("binds state to user/session/origin, expires it and validates callback issuer before token exchange", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      const bob = await createUser(h, x.a.creds, "bob@os.test", "Bob");
      const b = await signIn(h, bob.email, "user-password-1");
      const callback = await authorized(await x.start());
      expect((await call(h, "GET", callback, { creds: b.creds })).headers.get("location")).toContain("connectionError=invalid_oauth_state");
      const wrongOrigin = await h.svc.handle(new Request("http://other.test" + callback, { headers: { cookie: x.a.creds.cookie! } }));
      expect(wrongOrigin.headers.get("location")).toContain("connectionError=invalid_oauth_state");
      const a2 = await asAdmin(h);
      expect((await call(h, "GET", callback, { creds: a2.creds })).headers.get("location")).toContain("connectionError=invalid_oauth_state");
      const forged = new URL(ORIGIN + callback); forged.searchParams.set("iss", f.issuer + "/wrong");
      const done = await call(h, "GET", forged.pathname + forged.search, { creds: x.a.creds });
      expect(done.headers.get("location")).toContain("oauth_issuer_mismatch");
      expect(f.state.exchanges).toBe(0);
      const expired = await authorized(await x.start());
      h.storage.sql.exec("update plugin_oauth_state set expires_at=0").toArray();
      expect((await call(h, "GET", expired, { creds: x.a.creds })).headers.get("location")).toContain("connectionError=invalid_oauth_state");
      const start = await call(h, "GET", `${API}/plugins/${x.p.id}/connect?returnTo=https://evil.test`, { creds: x.a.creds });
      expect(start.headers.get("location")).toContain("connectionError=invalid_return_url");
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
      const row = h.storage.sql.exec("select id,data from plugin_connection").toArray()[0];
      const key = JSON.stringify(["connection", row.id, x.a.userId, x.p.id, "remote"]);
      const c = await cipher.open<any>(row.data as string, key); c.oauth.tokens.expiresAt = 0;
      h.storage.sql.exec("update plugin_connection set data=?", await cipher.seal(c, key)).toArray();
      f.state.invalidGrant = true;
      expect((await x.credential()).body.error).toBe("reconnect");
      expect((await call(h, "GET", `${API}/plugins`, { creds: x.a.creds })).body.plugins[0].status).toBe("reconnect");
    } finally { await f.close(); }
  });
  it("never reads/refreshes personal credentials when team policy, grants or enablement refuse them", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
      const team = (await call(h, "POST", `${API}/spaces`, { creds: x.a.creds, body: { name: "Team" } })).body.space.id;
      const resolve = () => h.svc.connections.credential({ ...x.input, spaceId: team });
      expect(await resolve()).toEqual({ error: "unavailable" }); expect(f.state.refreshes).toBe(0);
      await call(h, "PUT", `${API}/spaces/${team}/plugins`, { creds: x.a.creds, body: { personalPluginsAllowed: true, disabled: [] } });
      expect(await resolve()).toHaveProperty("headers.Authorization"); expect(f.state.refreshes).toBe(1);
      await call(h, "PATCH", `${API}/admin/groups/everyone`, { creds: x.a.creds, body: { plugins: [] } });
      expect((await x.credential()).body).toEqual({ error: "unavailable" });
      expect((await call(h, "POST", "/_baskule/plugin-credential", { body: x.input })).status).toBe(404);
    } finally { await f.close(); }
  });
  it("does not restore a connection disconnected during refresh or callback exchange", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
      const disconnect = async () => { await x.disconnect(); };
      f.state.onRefresh = disconnect;
      expect((await x.credential()).body.error).toBe("connect");
      expect(h.storage.sql.exec("select * from plugin_connection").toArray()).toEqual([]);
      f.state.onRefresh = null;
      await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
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
      expect((await x.start()).headers.get("location")).toContain("connectionError=oauth_client_configuration_required");
      const clientPath = `${API}/admin/vendors/${x.p.id}`;
      expect((await call(h, "PUT", clientPath, { creds: x.a.creds, body: { clientId: "fake-client", clientSecret: "private-secret", tokenEndpointAuthMethod: "client_secret_post" } })).status).toBe(200);
      expect(JSON.stringify(h.storage.sql.exec("select * from vendor_setup").toArray())).not.toContain("private-secret");
      await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds });
      expect(f.requests[0].client_secret).toBe("private-secret");
      expect(JSON.stringify((await call(h, "GET", `${API}/admin/plugins`, { creds: x.a.creds })).body)).not.toContain("private-secret");
      await call(h, "PUT", clientPath, { creds: x.a.creds, body: null });
      expect((await x.credential()).body.error).toBe("connect");
    } finally { await f.close(); }
  });
});

describe("vendor setup and recipes", () => {
  it("pins the issuer before secrets are used and clears only this vendor's connections", async () => {
    const f = await fakeOAuth(); f.state.dcr = false;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      const other = (await call(h, "POST", `${API}/admin/plugins`, { creds: x.a.creds, body: { groups: ["everyone"], source: { type: "url", url: f.resource } } })).body;
      await call(h, "PATCH", `${API}/admin/plugins/${other.id}`, { creds: x.a.creds, body: { servers: [{ name: "remote", credential: "user-oauth" }] } });
      await call(h, "PUT", `${API}/admin/vendors/${other.id}`, { creds: x.a.creds, body: { clientId: "fake-client", tokenEndpointAuthMethod: "none" } });
      const otherStart = await call(h, "GET", `${API}/plugins/${other.id}/connect`, { creds: x.a.creds });
      expect((await call(h, "GET", await authorized(otherStart), { creds: x.a.creds })).headers.get("location")).toContain("pluginConnection=connected");
      const previousRequests = f.requests.length;
      await call(h, "PATCH", `${API}/admin/plugins/${x.p.id}`, { creds: x.a.creds, body: { servers: [{ name: "remote", credential: "user-oauth", oauth: { staticClient: true } }] } });
      expect((await call(h, "GET", `${API}/plugins`, { creds: x.a.creds })).body.plugins.find((p: { id: string }) => p.id === x.p.id).status).toBe("needs_setup");
      expect((await call(h, "PATCH", `${API}/admin/plugins/${x.p.id}`, { creds: x.a.creds, body: { servers: [{ name: "remote", credential: "user-oauth", oauth: { params: { state: "overridden" } } }] } })).body.error).toBe("invalid_plugin_input");
      const path = `${API}/admin/vendors/${x.p.id}`;
      expect((await call(h, "PUT", path, { creds: x.a.creds, body: { clientId: "fake-client", clientSecret: "private-secret", tokenEndpointAuthMethod: "client_secret_post" } })).status).toBe(200);
      expect((await call(h, "GET", `${API}/admin/plugins`, { creds: x.a.creds })).body.plugins.find((p: { id: string }) => p.id === x.p.id).vendorConfigured).toBe(true);
      expect((await call(h, "GET", `${API}/plugins`, { creds: x.a.creds })).body.plugins.find((p: { id: string }) => p.id === x.p.id).status).toBe("connect");
      f.state.advertisedIssuer = "https://other-issuer.test";
      expect((await x.start()).headers.get("location")).toContain("connectionError=oauth_issuer_changed");
      expect(f.requests).toHaveLength(previousRequests);
      f.state.advertisedIssuer = null;
      expect((await call(h, "GET", await authorized(await x.start()), { creds: x.a.creds })).headers.get("location")).toContain("pluginConnection=connected");
      await call(h, "PUT", path, { creds: x.a.creds, body: null });
      expect(h.storage.sql.exec("select plugin_id from plugin_connection").toArray()).toEqual([{ plugin_id: other.id }]);
      expect(h.storage.sql.exec("select * from plugin_oauth_state").toArray()).toEqual([]);
    } finally { await f.close(); }
  });
  it.each(["user-oauth", "organization"] as const)("invalidates a custom vendor client only when its %s server changes", async firstCredential => {
    const f = await fakeOAuth(); f.state.dcr = false;
    try {
      const h = await makeService(); const a = await asAdmin(h);
      const archive = zipSync({ ".mcp.json": new TextEncoder().encode(JSON.stringify({ mcpServers: { first: { url: f.resource }, second: { url: f.resource } } })) });
      const added = await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { groups: ["everyone"], source: { type: "archive", sha256: await sha256(archive) }, archive: base64(archive) } });
      expect(added.status).toBe(201);
      const id = added.body.id;
      const servers = ["first", "second"].map(name => ({ name, credential: name === "first" ? firstCredential : "user-oauth", oauth: { staticClient: true } }));
      expect((await call(h, "PATCH", `${API}/admin/plugins/${id}`, { creds: a.creds, body: { servers } })).status).toBe(200);
      await call(h, "PUT", `${API}/admin/vendors/${id}`, { creds: a.creds, body: { clientId: "fake-client", tokenEndpointAuthMethod: "none" } });
      for (const name of firstCredential === "user-oauth" ? ["first", "second"] : ["second"]) {
        const start = await call(h, "GET", `${API}/plugins/${id}/connect?server=${name}`, { creds: a.creds });
        expect((await call(h, "GET", await authorized(start), { creds: a.creds })).headers.get("location")).toContain("pluginConnection=connected");
      }
      expect(h.storage.sql.exec("select * from plugin_connection").toArray()).toHaveLength(firstCredential === "user-oauth" ? 2 : 1);
      await call(h, "PATCH", `${API}/admin/plugins/${id}`, { creds: a.creds, body: { servers: [{ ...servers[0], url: f.resource + "/changed" }] } });
      expect((await call(h, "GET", `${API}/plugins`, { creds: a.creds })).body.plugins[0].servers.map((s: { status: string }) => s.status)).toEqual(firstCredential === "user-oauth" ? ["needs_setup", "needs_setup"] : ["needs_setup", "ready"]);
      expect(h.storage.sql.exec("select * from plugin_connection").toArray()).toHaveLength(firstCredential === "user-oauth" ? 0 : 1);
    } finally { await f.close(); }
  });
  it("uses a pinned issuer without resource metadata, adds recipe params and omits resource", async () => {
    const f = await fakeOAuth(); f.state.dcr = false;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      await call(h, "PATCH", `${API}/admin/plugins/${x.p.id}`, { creds: x.a.creds, body: { servers: [{ name: "remote", credential: "user-oauth", oauth: { params: { prompt: "consent select_account", access_type: "offline" }, resource: false, staticClient: true } }] } });
      await call(h, "PUT", `${API}/admin/vendors/${x.p.id}`, { creds: x.a.creds, body: { clientId: "fake-client", tokenEndpointAuthMethod: "none" } });
      f.state.metadata = false; f.state.resourceParameter = false;
      const start = await x.start();
      const authorization = new URL(start.headers.get("location")!);
      expect(authorization.searchParams.get("prompt")).toBe("consent select_account");
      expect(authorization.searchParams.get("access_type")).toBe("offline");
      expect(authorization.searchParams.has("resource")).toBe(false);
      expect((await call(h, "GET", await authorized(start), { creds: x.a.creds })).headers.get("location")).toContain("pluginConnection=connected");
      expect(f.requests[0]).not.toHaveProperty("resource");
    } finally { await f.close(); }
  });
});

describe("ready-member discovery and account reloads", () => {
  it("discovers through the second member when the first has no account, without lending that account to calls", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      const bob = await createUser(h, x.a.creds, "discovery@os.test", "Discovery");
      const b = await signIn(h, bob.email, "user-password-1");
      const team = (await call(h, "POST", `${API}/spaces`, { creds: x.a.creds, body: { name: "Discovery", members: [{ userId: bob.id }] } })).body.space.id;
      await call(h, "PUT", `${API}/spaces/${team}/plugins`, { creds: x.a.creds, body: { personalPluginsAllowed: true, disabled: [] } });
      const members = [{ id: x.a.userId, creds: x.a.creds }, { id: bob.id, creds: b.creds }].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const start = await call(h, "GET", `${API}/plugins/${x.p.id}/connect`, { creds: members[1].creds });
      await call(h, "GET", await authorized(start), { creds: members[1].creds });
      expect((await h.svc.plugins.settings(team)).servers[0].catalogUserId).toBe(members[1].id);
      await call(h, "PUT", `${API}/spaces/${team}/plugins`, { creds: x.a.creds, body: { personalPluginsAllowed: false, disabled: [] } });
      expect((await h.svc.plugins.settings(team)).servers).toEqual([]);
      await call(h, "PUT", `${API}/spaces/${team}/plugins`, { creds: x.a.creds, body: { personalPluginsAllowed: true, disabled: [x.p.id] } });
      expect((await h.svc.plugins.settings(team)).servers).toEqual([]);
      await call(h, "PUT", `${API}/spaces/${team}/plugins`, { creds: x.a.creds, body: { personalPluginsAllowed: true, disabled: [] } });
      expect(await h.svc.connections.credential({ ...x.input, spaceId: team, userId: members[0].id })).toEqual({ error: "connect" });
      expect(await h.svc.connections.credential({ ...x.input, spaceId: team, userId: members[1].id })).toMatchObject({ headers: { Authorization: expect.stringMatching(/^Bearer /) } });
      const connected = (await call(h, "GET", `${API}/plugins`, { creds: members[1].creds })).body.plugins[0].servers[0].accounts[0];
      await call(h, "DELETE", `${API}/plugins/${x.p.id}/accounts/${connected.id}`, { creds: members[1].creds });
      expect((await h.svc.plugins.settings(team)).servers).toEqual([]);
    } finally { await f.close(); }
  });

  it("reloads the author's spaces after connect/disconnect and all spaces after setup, but never after refresh", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    try {
      const h = await makeService(); const x = await install(h, f.resource);
      const bob = await createUser(h, x.a.creds, "reload@os.test", "Reload");
      const team = (await call(h, "POST", `${API}/spaces`, { creds: x.a.creds, body: { name: "Reload", members: [{ userId: bob.id }] } })).body.space.id;
      const callback = await authorized(await x.start());
      h.calls.length = 0;
      await call(h, "GET", callback, { creds: x.a.creds });
      const reloads = () => h.calls.filter(c => c.path === "/_baskule/reconfigure").map(c => c.spaceId).sort();
      const own = [team, personalSpaceOf(h, x.a.userId)].sort();
      expect(reloads()).toEqual(own);
      h.calls.length = 0;
      expect((await x.credential()).body.headers.Authorization).toMatch(/^Bearer /);
      expect(f.state.refreshes).toBe(1);
      expect(reloads()).toEqual([]);
      await x.disconnect();
      expect(reloads()).toEqual(own);
      h.calls.length = 0;
      await call(h, "PUT", `${API}/admin/vendors/${x.p.id}`, { creds: x.a.creds, body: { clientId: "fake-client", tokenEndpointAuthMethod: "none" } });
      expect(reloads()).toEqual([...own, personalSpaceOf(h, bob.id)].sort());
    } finally { await f.close(); }
  });
});
