import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import type { AdminPlugin, MemberPluginList, PluginCredential, SpacePlugins } from "../../../app/packages/contracts/src/baskule-plugins";
import { INTERNAL_HEADER } from "../../src/shared/contract";
import { parsePluginDirectory } from "../../src/control/plugins/package";
import type { StoredPlugin } from "../../src/control/plugins/state";
import { asAdmin, call, createUser, makeService, personalSpaceOf, signIn, type H } from "../support/harness";
import { fakeFetch, ok, type Seen } from "../support/fake-fetch";

const API = "/api/baskule";
const fixture = (path: string) => readFileSync(new URL(`../fixtures/marketplace/${path}`, import.meta.url), "utf8");
const [SHA] = fixture("SHAS").trim().split("\n") as [string];
const TREE = "1".repeat(40);
const RAW = `https://raw.githubusercontent.com/cursor/plugins/${SHA}`;
const GMAIL = "https://gmailmcp.googleapis.com/mcp/v1";
const GOOGLE = "https://accounts.google.com";

/** GitHub serving the recorded Cursor registry, Google's recorded MCP metadata, and the vendors a test adds. */
function world() {
  const tokens: Seen[] = [];
  let tokenAnswer: (seen: Seen) => Response = () => ok({ access_token: "google-access-1", refresh_token: "google-refresh", token_type: "Bearer", expires_in: 3600, scope: "https://mail.google.com/" });
  const fake = fakeFetch({
    "https://api.github.com/repos/cursor/plugins/commits/*": ok({ sha: SHA, commit: { tree: { sha: TREE } } }),
    [`https://api.github.com/repos/cursor/plugins/git/trees/${TREE}?recursive=1`]: ok(fixture("cursor/tree.json")),
    [`${RAW}/.cursor-plugin/marketplace.json`]: ok(fixture("cursor/marketplace.json")),
    ...Object.fromEntries(["gmail", "netsuite", "github"].flatMap(name => [
      [`${RAW}/third_party/${name}/.cursor-plugin/plugin.json`, ok(fixture(`cursor/${name}/plugin.json`))],
      [`${RAW}/third_party/${name}/mcp.json`, ok(fixture(`cursor/${name}/mcp.json`))],
    ])),
    "https://api.github.com/repos/xai-org/plugin-marketplace/*": new Response("", { status: 503 }),
    [GMAIL]: ok({ jsonrpc: "2.0", id: 1, result: {} }),
    "https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1": ok({ authorization_servers: [`${GOOGLE}/`], resource: GMAIL, scopes_supported: ["https://mail.google.com/"] }),
    [`${GOOGLE}/.well-known/oauth-authorization-server`]: ok({ issuer: GOOGLE, authorization_endpoint: `${GOOGLE}/o/oauth2/v2/auth`, token_endpoint: "https://oauth2.googleapis.com/token",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"] }),
    "https://oauth2.googleapis.com/token": seen => { tokens.push(seen); return tokenAnswer(seen); },
    "https://api.githubcopilot.com/mcp/": new Response("", { status: 401 }),
  });
  return { ...fake, tokens, answerTokens: (answer: typeof tokenAnswer) => { tokenAnswer = answer; } };
}

async function setup(fetch = world()) {
  const h = await makeService({}, true, fetch.fetcher);
  const admin = (await asAdmin(h)).creds;
  await createUser(h, admin, "ada@acme.test", "Ada");
  const ada = await signIn(h, "ada@acme.test", "user-password-1");
  return { h, admin, ada, fetch };
}
const internal = (h: H, path: string, body: unknown) => call(h, "POST", path, { headers: { [INTERNAL_HEADER]: "1" }, body, origin: null });
const credential = async (h: H, body: { spaceId: string; userId: string; pluginId: string; serverId: string }) => (await internal(h, "/_baskule/plugin-credential", body)).body as PluginCredential;
const settings = async (h: H, spaceId: string) => (await internal(h, "/_baskule/settings", { spaceId })).body.plugins as SpacePlugins;

async function install(h: H, admin: { cookie?: string }, ref: unknown, extra: Record<string, unknown> = {}) {
  const preview = await call(h, "POST", `${API}/admin/plugins/preview`, { creds: admin, body: { ref } });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const installed = await call(h, "POST", `${API}/admin/plugins`, { creds: admin, body: { ref, digest: preview.body.digest, access: { kind: "everyone" }, values: {}, ...extra } });
  expect(installed.status, JSON.stringify(installed.body)).toBe(201);
  return { preview: preview.body, plugin: installed.body as AdminPlugin };
}

describe("marketplace plugins in ControlCell", () => {
  it("keeps only the servers an administrator chose from a pack, and lists the pack's blank slots as not added", async () => {
    const { h, admin, fetch } = await setup();
    const ref = { kind: "github", url: "https://github.com/acme/pack" };
    const raw = `https://raw.githubusercontent.com/acme/pack/${SHA}`;
    fetch.routes["https://api.github.com/repos/acme/pack/commits/HEAD"] = ok({ sha: SHA, commit: { tree: { sha: TREE } } });
    fetch.routes[`https://api.github.com/repos/acme/pack/git/trees/${TREE}?recursive=1`] = ok({ tree: [
      { path: "plugin.json", type: "blob", mode: "100644" }, { path: ".mcp.json", type: "blob", mode: "100644" },
    ] });
    fetch.routes[`${raw}/plugin.json`] = ok({ name: "pack" });
    fetch.routes[`${raw}/.mcp.json`] = ok({ mcpServers: { crm: { type: "http", url: "https://crm.test/mcp" }, chat: { type: "http", url: "https://chat.test/mcp" },
      gmail: { type: "http", url: "" } } });
    for (const host of ["crm.test", "chat.test"]) fetch.routes[`https://${host}/mcp`] = ok({ jsonrpc: "2.0", id: 1, result: {} });
    const preview = await call(h, "POST", `${API}/admin/plugins/preview`, { creds: admin, body: { ref } });
    expect(preview.body).toMatchObject({ servers: [{ name: "chat" }, { name: "crm" }], skipped: [{ kind: "blank_server", subject: "gmail" }] });
    const add = (servers: string[]) => call(h, "POST", `${API}/admin/plugins`, { creds: admin, body: { ref, digest: preview.body.digest, access: { kind: "everyone" }, values: {}, servers } });
    expect((await add(["crm", "calendar"])).body).toMatchObject({ error: "invalid_request" });
    expect((await add([])).body).toMatchObject({ error: "plugin_empty" });
    const added = await add(["crm"]);
    expect(added.status).toBe(201);
    expect((added.body as AdminPlugin).servers.map(s => s.name)).toEqual(["crm"]);
  });

  it("enforces public source URLs before header auth at preview, install, update and credential time", async () => {
    const { h, admin, ada, fetch } = await setup();
    const ref = { kind: "github", url: "https://github.com/acme/plugin" };
    const raw = `https://raw.githubusercontent.com/acme/plugin/${SHA}`;
    fetch.routes["https://api.github.com/repos/acme/plugin/commits/HEAD"] = ok({ sha: SHA, commit: { tree: { sha: TREE } } });
    fetch.routes[`https://api.github.com/repos/acme/plugin/git/trees/${TREE}?recursive=1`] = ok({ tree: [
      { path: "plugin.json", type: "blob", mode: "100644" }, { path: "mcp.json", type: "blob", mode: "100644" },
    ] });
    const manifest = JSON.stringify({ name: "guarded" });
    fetch.routes[`${raw}/plugin.json`] = ok(manifest);
    const source = async (url: string) => {
      const content = JSON.stringify({ mcpServers: { guarded: { url, headers: { Authorization: "Bearer ${KEY}" } } } });
      fetch.routes[`${raw}/mcp.json`] = ok(content);
      return (await parsePluginDirectory([{ path: "plugin.json", content: manifest }, { path: "mcp.json", content }], "plugin")).digest;
    };
    const digest = await source("https://127.0.0.1/mcp");
    expect((await call(h, "POST", `${API}/admin/plugins/preview`, { creds: admin, body: { ref } })).body).toMatchObject({ error: "invalid_server" });
    expect((await call(h, "POST", `${API}/admin/plugins`, { creds: admin, body: { ref, digest, access: { kind: "everyone" }, values: { guarded: { KEY: "secret" } } } })).body)
      .toMatchObject({ error: "invalid_server" });

    await source("${KEY}");
    await install(h, admin, ref);
    const update = (KEY: string) => call(h, "PATCH", `${API}/admin/plugins/guarded`, { creds: admin, body: { values: { guarded: { KEY } } } });
    expect((await update("https://127.0.0.1/mcp")).body).toMatchObject({ error: "invalid_server" });
    expect((await update("https://vendor.test/mcp")).status).toBe(200);
    const input = { spaceId: personalSpaceOf(h, ada.userId), userId: ada.userId, pluginId: "guarded", serverId: "guarded" };
    expect(await credential(h, input)).toMatchObject({ ok: true, network: "public" });
    const row = h.storage.sql.exec("select definition from plugin where id='guarded'").toArray()[0]!;
    const def: StoredPlugin = JSON.parse(row.definition as string);
    def.servers[0]!.url = "https://127.0.0.1/mcp";
    h.storage.sql.exec("update plugin set definition=? where id='guarded'", JSON.stringify(def));
    expect(await credential(h, input)).toMatchObject({ ok: false, error: "unavailable" });
    expect((await update("replacement")).body).toMatchObject({ error: "invalid_server" });
    expect(fetch.seen.some(s => s.url.includes("127.0.0.1"))).toBe(false);

    await install(h, admin, { kind: "custom", server: { displayName: "Private", url: "http://127.0.0.1/mcp", auth: "header", headerName: "X-Key" } },
      { values: { Private: { "X-Key": "secret" } } });
    expect(await credential(h, { ...input, pluginId: "private", serverId: "private" })).toMatchObject({ ok: true, network: "private" });
  });

  it("lists the catalog, installs Gmail, asks for Google's OAuth client first, and signs a member in with offline access", async () => {
    const { h, admin, ada, fetch } = await setup();
    expect((await call(h, "GET", `${API}/admin/catalog`, { creds: ada.creds })).status).toBe(403);
    const catalog = await call(h, "GET", `${API}/admin/catalog`, { creds: admin });
    expect(catalog.body.entries.map((e: { name: string }) => e.name)).toEqual(["github", "gmail", "netsuite"]);
    // Only the Cursor registry is recorded here; the others answer 404 and stay listed as unavailable.
    expect(catalog.body.unavailable.map((u: { source: string }) => u.source)).toEqual(["anthropic", "anthropic-work", "xai"]);
    const entryId = "cursor:https://github.com/cursor/plugins#third_party/gmail";
    const { preview, plugin } = await install(h, admin, { kind: "catalog", entryId });
    expect(preview.servers).toEqual([{ name: "gmail", url: GMAIL, transport: "streamable-http", auth: { kind: "oauth", issuer: GOOGLE, registration: "client" }, variables: [] }]);
    expect(preview.origin).toEqual({ kind: "registry", registry: "cursor", repo: "https://github.com/cursor/plugins", path: "third_party/gmail", sha: SHA });
    expect(plugin).toMatchObject({ id: "gmail", status: "needs_setup", logo: `${RAW}/third_party/gmail/assets/logo.svg`, servers: [{ id: "gmail", setup: { state: "needs_oauth_client", issuer: GOOGLE } }] });
    expect((await call(h, "GET", `${API}/admin/catalog`, { creds: admin })).body.entries.find((e: { id: string }) => e.id === entryId).installedPluginId).toBe("gmail");
    expect((await call(h, "POST", `${API}/admin/plugins`, { creds: admin, body: { ref: { kind: "catalog", entryId }, digest: preview.digest, access: { kind: "everyone" }, values: {} } })).body.error).toBe("plugin_exists");

    const list = (await call(h, "GET", `${API}/admin/plugins`, { creds: admin })).body;
    expect(list.oauthClients).toEqual([{ issuer: GOOGLE, configured: false, clientId: null, hasSecret: false, scopes: null, authorizationParams: null,
      callbackUrl: "http://baskule.test/api/baskule/plugins/oauth/callback", hosts: ["gmailmcp.googleapis.com"], usedBy: [{ pluginId: "gmail", displayName: "Gmail" }] }]);
    const member = async () => ((await call(h, "GET", `${API}/plugins`, { creds: ada.creds })).body as MemberPluginList).plugins[0]!;
    expect((await member()).servers[0]!.connection).toEqual({ state: "unavailable" });
    const refused = await call(h, "GET", `${API}/plugins/gmail/servers/gmail/connect`, { creds: ada.creds });
    expect(new URL(refused.headers.get("location")!).search).toBe("?plugin=gmail&connection=error&code=setup_incomplete");

    const saved = await call(h, "PUT", `${API}/admin/oauth-clients`, { creds: admin, body: { issuer: `${GOOGLE}/`, clientId: "baskule.apps.googleusercontent.com", clientSecret: "google-secret" } });
    expect(saved.body).toEqual([expect.objectContaining({ issuer: GOOGLE, configured: true, clientId: "baskule.apps.googleusercontent.com", hasSecret: true })]);
    expect(JSON.stringify(saved.body)).not.toContain("google-secret");
    expect((await member()).servers[0]!.connection).toEqual({ state: "not_connected" });

    const start = await call(h, "GET", `${API}/plugins/gmail/servers/gmail/connect?returnTo=/settings/plugins`, { creds: ada.creds });
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(`${GOOGLE}/o/oauth2/v2/auth`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: "baskule.apps.googleusercontent.com", access_type: "offline", prompt: "consent",
      redirect_uri: "http://baskule.test/api/baskule/plugins/oauth/callback", resource: GMAIL, scope: "https://mail.google.com/", code_challenge_method: "S256" });
    const state = authorize.searchParams.get("state")!;
    const stolen = await call(h, "GET", `${API}/plugins/oauth/callback?state=${state}&code=c&iss=${GOOGLE}`, { creds: admin });
    expect(new URL(stolen.headers.get("location")!).searchParams.get("code")).toBe("invalid_request");
    const done = await call(h, "GET", `${API}/plugins/oauth/callback?state=${state}&code=the-code&iss=${encodeURIComponent(GOOGLE)}`, { creds: ada.creds });
    expect(new URL(done.headers.get("location")!).search).toBe("?plugin=gmail&connection=connected");
    expect(fetch.tokens[0]!.headers.authorization).toBe(`Basic ${btoa("baskule.apps.googleusercontent.com:google-secret")}`);
    expect(Object.fromEntries(new URLSearchParams(fetch.tokens[0]!.body))).toMatchObject({ grant_type: "authorization_code", code: "the-code", resource: GMAIL, code_verifier: expect.any(String) });
    expect((await call(h, "GET", `${API}/plugins/oauth/callback?state=${state}&code=again`, { creds: ada.creds })).headers.get("location")).toContain("code=invalid_request");
    expect((await member()).servers[0]!.connection).toMatchObject({ state: "connected" });

    const space = personalSpaceOf(h, ada.userId);
    const input = { spaceId: space, userId: ada.userId, pluginId: "gmail", serverId: "gmail" };
    expect(await credential(h, input)).toEqual({ ok: true, network: "public", transport: "streamable-http", url: GMAIL, headers: { Authorization: "Bearer google-access-1" } });
    expect(await settings(h, space)).toEqual({ servers: [{ pluginId: "gmail", serverId: "gmail", name: "gmail", displayName: "Gmail", listAs: ada.userId }], skills: [] });

    // Refresh shortly before expiry: an outage keeps the refresh token; only invalid_grant ends the sign-in.
    fetch.answerTokens(() => ok({ access_token: "google-access-2", token_type: "Bearer", expires_in: 30 }));
    await call(h, "DELETE", `${API}/plugins/gmail/servers/gmail/connection`, { creds: ada.creds });
    const again = new URL((await call(h, "GET", `${API}/plugins/gmail/servers/gmail/connect`, { creds: ada.creds })).headers.get("location")!).searchParams.get("state");
    fetch.answerTokens(() => ok({ access_token: "short", refresh_token: "r2", token_type: "Bearer", expires_in: 30 }));
    await call(h, "GET", `${API}/plugins/oauth/callback?state=${again}&code=c2&iss=${encodeURIComponent(GOOGLE)}`, { creds: ada.creds });
    fetch.answerTokens(() => new Response("", { status: 503 }));
    expect(await credential(h, input)).toMatchObject({ ok: false, error: "unavailable" });
    expect((await member()).servers[0]!.connection).toMatchObject({ state: "connected" });
    fetch.answerTokens(() => ok({ access_token: "renewed", token_type: "Bearer", expires_in: 3600 }));
    expect(await credential(h, input)).toEqual({ ok: true, network: "public", transport: "streamable-http", url: GMAIL, headers: { Authorization: "Bearer renewed" } });
    expect(Object.fromEntries(new URLSearchParams(fetch.tokens.at(-1)!.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "r2" });
    expect(await credential(h, input)).toEqual({ ok: true, network: "public", transport: "streamable-http", url: GMAIL, headers: { Authorization: "Bearer renewed" } });

    // A new client ID for the issuer ends sign-ins made with the old one; its pending sign-ins are dropped.
    await call(h, "PUT", `${API}/admin/oauth-clients`, { creds: admin, body: { issuer: GOOGLE, clientId: "rotated.apps.googleusercontent.com", clientSecret: "s2" } });
    expect((await member()).servers[0]!.connection).toEqual({ state: "expired" });
    expect(await credential(h, input)).toMatchObject({ ok: false, error: "sign_in_expired", message: "Your Gmail sign-in expired. Sign in again in Settings → Plugins, then try again." });
  });

  it("delivers an SSE server's selected transport in its credential", async () => {
    const { h, admin, ada, fetch } = await setup();
    fetch.routes[`${RAW}/third_party/github/mcp.json`] = ok({ mcpServers: { github: {
      type: "sse", url: "https://api.githubcopilot.com/sse", headers: { Authorization: "Bearer ${TOKEN}" },
    } } });
    await install(h, admin, { kind: "github", url: "https://github.com/cursor/plugins/tree/main/third_party/github" }, { values: { github: { TOKEN: "secret" } } });
    expect(await credential(h, { spaceId: personalSpaceOf(h, ada.userId), userId: ada.userId, pluginId: "github", serverId: "github" }))
      .toMatchObject({ ok: true, transport: "sse" });
  });

  it.each([
    ["https://login.vendor.test/", "https://login.vendor.test", "connected"],
    ["https://login.vendor.test/tenant/", "https://login.vendor.test/tenant/", "connected"],
    ["https://login.vendor.test/tenant/", "https://login.vendor.test/tenant", "error"],
  ])("compares callback issuer %s with %s without losing path identity", async (issuer, callbackIssuer, result) => {
    const { h, admin, ada, fetch } = await setup();
    fetch.routes["https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1"] = ok({ authorization_servers: [issuer], resource: GMAIL });
    const authority = new URL(issuer);
    const suffix = authority.pathname.replace(/\/$/, "");
    fetch.routes[`${authority.origin}/.well-known/oauth-authorization-server${suffix}`] = ok({
      issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, authorization_response_iss_parameter_supported: true,
    });
    fetch.routes[`${issuer}token`] = ok({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    await install(h, admin, { kind: "catalog", entryId: "cursor:https://github.com/cursor/plugins#third_party/gmail" });
    await call(h, "PUT", `${API}/admin/oauth-clients`, { creds: admin, body: { issuer, clientId: "id" } });
    const start = new URL((await call(h, "GET", `${API}/plugins/gmail/servers/gmail/connect`, { creds: ada.creds })).headers.get("location")!);
    expect(start.pathname).toBe(new URL(`${issuer}authorize`).pathname);
    const callback = await call(h, "GET", `${API}/plugins/oauth/callback?state=${start.searchParams.get("state")}&code=c&iss=${encodeURIComponent(callbackIssuer)}`, { creds: ada.creds });
    expect(new URL(callback.headers.get("location")!).searchParams.get("connection")).toBe(result);
  });

  it("takes an OAuth client for an HTTPS issuer, or a plain HTTP one only on a private network", async () => {
    const { h, admin } = await setup();
    const save = (issuer: string) => call(h, "PUT", `${API}/admin/oauth-clients`, { creds: admin, body: { issuer, clientId: "id", clientSecret: "s" } });
    expect((await save("http://127.0.0.1:9000")).status).toBe(200);
    expect((await save("http://intranet.local")).status).toBe(200);
    expect((await save("http://auth.example.com")).body).toMatchObject({ error: "invalid_oauth_client" });
    expect((await save("https://auth.example.com?x=1")).body).toMatchObject({ error: "invalid_oauth_client" });
  });

  it("reloads discovery as another usable member when invalid_grant expires a sign-in", async () => {
    const { h, admin, ada, fetch } = await setup();
    await createUser(h, admin, "bo@acme.test", "Bo");
    const bo = await signIn(h, "bo@acme.test", "user-password-1");
    const spaceId = (await call(h, "POST", `${API}/spaces`, { creds: admin, body: { name: "Team", members: [{ userId: ada.userId }, { userId: bo.userId }] } })).body.space.id;
    h.storage.sql.exec("update space_member set created_at=1 where space_id=? and user_id=?", spaceId, ada.userId);
    h.storage.sql.exec("update space_member set created_at=2 where space_id=? and user_id=?", spaceId, bo.userId);
    await install(h, admin, { kind: "catalog", entryId: "cursor:https://github.com/cursor/plugins#third_party/gmail" });
    await call(h, "PUT", `${API}/admin/oauth-clients`, { creds: admin, body: { issuer: GOOGLE, clientId: "id", clientSecret: "s" } });
    const reloads = () => h.calls.filter(c => c.path === "/_baskule/reconfigure" && c.spaceId === spaceId).length;
    const beforeConnect = reloads();
    fetch.answerTokens(() => ok({ access_token: "short", refresh_token: "r", token_type: "Bearer", expires_in: 30 }));
    const state = new URL((await call(h, "GET", `${API}/plugins/gmail/servers/gmail/connect`, { creds: ada.creds })).headers.get("location")!).searchParams.get("state");
    await call(h, "GET", `${API}/plugins/oauth/callback?state=${state}&code=c&iss=${encodeURIComponent(GOOGLE)}`, { creds: ada.creds });
    expect(reloads()).toBeGreaterThan(beforeConnect);
    fetch.answerTokens(() => ok({ access_token: "bo", refresh_token: "bo-refresh", token_type: "Bearer", expires_in: 3600 }));
    const boState = new URL((await call(h, "GET", `${API}/plugins/gmail/servers/gmail/connect`, { creds: bo.creds })).headers.get("location")!).searchParams.get("state");
    await call(h, "GET", `${API}/plugins/oauth/callback?state=${boState}&code=b&iss=${encodeURIComponent(GOOGLE)}`, { creds: bo.creds });
    const tokenRequests = fetch.tokens.length;
    expect((await settings(h, spaceId)).servers[0]!.listAs).toBe(ada.userId);
    expect(fetch.tokens).toHaveLength(tokenRequests);
    const beforeExpire = reloads();
    fetch.answerTokens(() => ok({ error: "invalid_grant" }, { status: 400 }));
    const input = { spaceId, userId: ada.userId, pluginId: "gmail", serverId: "gmail" };
    expect(await credential(h, input)).toMatchObject({ ok: false, error: "sign_in_expired" });
    expect(reloads()).toBeGreaterThan(beforeExpire);
    expect((await settings(h, spaceId)).servers[0]!.listAs).toBe(bo.userId);
    h.storage.sql.exec("update plugin_connection set data='unreadable' where user_id=?", bo.userId);
    expect((await settings(h, spaceId)).servers[0]!.listAs).toBeNull();
    const beforeDisconnect = reloads();
    await call(h, "DELETE", `${API}/plugins/gmail/servers/gmail/connection`, { creds: bo.creds });
    expect(reloads()).toBeGreaterThan(beforeDisconnect);
  });

  it("takes values for ${VAR} placeholders, then probes the filled address", async () => {
    const fetch = world();
    const { h, admin, ada } = await setup(fetch);
    const { preview, plugin } = await install(h, admin, { kind: "catalog", entryId: "cursor:https://github.com/cursor/plugins#third_party/netsuite" });
    expect(preview.servers[0]).toMatchObject({ url: "${NETSUITE_MCP_URL}", auth: { kind: "none" }, variables: [{ name: "NETSUITE_MCP_URL", secret: false, where: "url" }] });
    expect(plugin.servers[0]!.setup).toEqual({ state: "needs_values", variables: ["NETSUITE_MCP_URL"] });
    expect((await call(h, "PATCH", `${API}/admin/plugins/netsuite`, { creds: admin, body: { values: { netsuite: { NETSUITE_MCP_URL: "http://1234.suitetalk.api.netsuite.com/mcp" } } } })).body.error).toBe("invalid_server");
    const url = "https://1234-sb1.suitetalk.api.netsuite.com/services/mcp/v1/all";
    fetch.routes[url] = new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://1234-sb1.suitetalk.api.netsuite.com/.well-known/oauth-protected-resource"' } });
    fetch.routes["https://1234-sb1.suitetalk.api.netsuite.com/.well-known/oauth-protected-resource"] = ok({ resource: url, authorization_servers: ["https://system.netsuite.com"] });
    fetch.routes["https://system.netsuite.com/.well-known/oauth-authorization-server"] = ok({ issuer: "https://system.netsuite.com", authorization_endpoint: "https://system.netsuite.com/a",
      token_endpoint: "https://system.netsuite.com/t", registration_endpoint: "https://system.netsuite.com/r" });
    const updated = await call(h, "PATCH", `${API}/admin/plugins/netsuite`, { creds: admin, body: { values: { netsuite: { NETSUITE_MCP_URL: url } } } });
    expect(updated.body).toMatchObject({ status: "ready", servers: [{ auth: { kind: "oauth", issuer: "https://system.netsuite.com", registration: "dynamic" },
      variables: [{ name: "NETSUITE_MCP_URL", set: true }], setup: { state: "ready" } }] });
    expect(JSON.stringify((await call(h, "GET", `${API}/admin/plugins`, { creds: admin })).body)).not.toContain("1234-sb1");
    const input = { spaceId: personalSpaceOf(h, ada.userId), userId: ada.userId, pluginId: "netsuite", serverId: "netsuite" };
    expect(await credential(h, input)).toMatchObject({ ok: false, error: "sign_in_required" });
  });

  it("keeps a header server to its groups, honours pause and the member switch, and delivers it to the space", async () => {
    const { h, admin, ada, fetch } = await setup();
    await createUser(h, admin, "bo@acme.test", "Bo");
    const bo = await signIn(h, "bo@acme.test", "user-password-1");
    const group = (await call(h, "POST", `${API}/admin/groups`, { creds: admin, body: { name: "Sales", members: [ada.userId], permissions: { canCreateSpaces: false } } })).body;
    fetch.routes["https://crm.acme.test/mcp"] = new Response("", { status: 401 });
    const ref = { kind: "custom", server: { displayName: "Acme CRM", url: "https://crm.acme.test/mcp", auth: "header", headerName: "X-API-Key" } };
    const missing = await call(h, "POST", `${API}/admin/plugins`, { creds: admin, body: { ref, digest: "sha256:0", access: { kind: "groups", groups: ["nope"] }, values: {} } });
    expect(missing.body.error).toBe("plugin_changed");
    const { plugin } = await install(h, admin, ref, { access: { kind: "groups", groups: [group.id] } });
    expect(plugin).toMatchObject({ id: "acme-crm", access: { kind: "groups", groups: [group.id] }, servers: [{ id: "acme-crm", auth: { kind: "headers", headers: ["X-API-Key"] },
      setup: { state: "needs_values", variables: ["X-API-Key"] } }] });
    const team = (await call(h, "POST", `${API}/spaces`, { creds: admin, body: { name: "Team", members: [{ userId: ada.userId }, { userId: bo.userId }] } })).body.space.id;
    const ask = (userId: string) => credential(h, { spaceId: team, userId, pluginId: "acme-crm", serverId: "acme-crm" });
    expect((await ask(ada.userId)).ok).toBe(false);
    expect((await settings(h, team)).servers).toEqual([]);
    await call(h, "PATCH", `${API}/admin/plugins/acme-crm`, { creds: admin, body: { values: { "Acme CRM": { "X-API-Key": "crm-key" } } } });
    expect(await ask(ada.userId)).toEqual({ ok: true, network: "public", transport: "streamable-http", url: "https://crm.acme.test/mcp", headers: { "X-API-Key": "crm-key" } });
    expect(await ask(bo.userId)).toMatchObject({ ok: false, error: "not_allowed" });
    expect(((await call(h, "GET", `${API}/plugins`, { creds: bo.creds })).body as MemberPluginList).plugins).toEqual([]);
    expect((await settings(h, team)).servers).toEqual([{ pluginId: "acme-crm", serverId: "acme-crm", name: "Acme CRM", displayName: "Acme CRM", listAs: ada.userId }]);
    expect((await call(h, "PUT", `${API}/plugins/acme-crm`, { creds: bo.creds, body: { on: false } })).status).toBe(404);
    const reloads = h.calls.filter(c => c.path === "/_baskule/reconfigure").length;
    expect((await call(h, "PUT", `${API}/plugins/acme-crm`, { creds: ada.creds, body: { on: false } })).status).toBe(200);
    expect(h.calls.filter(c => c.path === "/_baskule/reconfigure").length).toBeGreaterThan(reloads);
    expect(await ask(ada.userId)).toMatchObject({ ok: false, error: "plugin_off" });
    expect(await settings(h, team)).toEqual({ servers: [], skills: [] });
    await call(h, "PUT", `${API}/plugins/acme-crm`, { creds: ada.creds, body: { on: true } });
    await call(h, "PATCH", `${API}/admin/plugins/acme-crm`, { creds: admin, body: { enabled: false } });
    expect(await ask(ada.userId)).toMatchObject({ ok: false, error: "plugin_off" });
    expect(((await call(h, "GET", `${API}/plugins`, { creds: ada.creds })).body as MemberPluginList).plugins[0]).toMatchObject({ enabled: false, on: true });
    await call(h, "PATCH", `${API}/admin/plugins/acme-crm`, { creds: admin, body: { enabled: true, access: { kind: "everyone" } } });
    expect((await ask(bo.userId)).ok).toBe(true);
    expect((await credential(h, { spaceId: personalSpaceOf(h, ada.userId), userId: bo.userId, pluginId: "acme-crm", serverId: "acme-crm" }))).toMatchObject({ error: "not_allowed" });
    await call(h, "POST", `${API}/admin/users/${bo.userId}/deactivate`, { creds: admin });
    expect(await ask(bo.userId)).toMatchObject({ error: "not_allowed" });
    expect((await call(h, "DELETE", `${API}/admin/plugins/acme-crm`, { creds: admin })).status).toBe(200);
    expect(await ask(ada.userId)).toMatchObject({ error: "not_allowed" });
  });

  it("verifies Pipedream before storing it, lists its apps, and connects a member's one account", async () => {
    const fetch = world();
    const PD = "https://api.pipedream.com";
    Object.assign(fetch.routes, {
      [`${PD}/v1/oauth/token`]: ok({ access_token: "pd-token", expires_in: 3600 }),
      [`${PD}/v1/connect/proj/accounts?*`]: ({ url }: Seen) => new URL(url).searchParams.get("app")
        ? ok({ data: [{ id: "apn_1", name: "ada@acme.test", healthy: true, app: { name_slug: "slack" }, created_at: "2026-11-12T00:00:00Z" }] }) : ok({ data: [] }),
      [`${PD}/v1/connect/apps?limit=100&has_actions=true`]: ok({ data: [{ name_slug: "slack", name: "Slack", img_src: "https://assets.pipedream.net/slack.png" }], page_info: {} }),
      [`${PD}/v1/connect/proj/tokens`]: ok({ connect_link_url: "https://pipedream.com/_static/connect.html?token=t" }),
      [`${PD}/v1/connect/proj/accounts/apn_1`]: new Response(null, { status: 204 }),
    });
    const { h, admin, ada } = await setup(fetch);
    const config = { provider: "pipedream", clientId: "id", clientSecret: "secret", projectId: "proj", environment: "development" };
    fetch.routes[`${PD}/v1/oauth/token`] = ok({ error: "invalid_client" }, { status: 401 });
    expect((await call(h, "PUT", `${API}/admin/plugin-providers/pipedream`, { creds: admin, body: config })).body.error).toBe("provider_rejected");
    fetch.routes[`${PD}/v1/oauth/token`] = ok({ access_token: "pd-token", expires_in: 3600 });
    const saved = await call(h, "PUT", `${API}/admin/plugin-providers/pipedream`, { creds: admin, body: config });
    expect(saved.body).toEqual({ composio: { configured: false }, pipedream: { configured: true, projectId: "proj", environment: "development" } });
    const catalog = (await call(h, "GET", `${API}/admin/catalog`, { creds: admin })).body;
    expect(catalog.providers).toEqual({ composio: false, pipedream: true });
    expect(catalog.entries.at(-1)).toMatchObject({ id: "pipedream:slack", source: "pipedream", displayName: "Slack", logo: "https://assets.pipedream.net/slack.png" });
    const { plugin } = await install(h, admin, { kind: "catalog", entryId: "pipedream:slack" });
    expect(plugin).toMatchObject({ id: "slack", status: "ready", origin: { kind: "provider", provider: "pipedream", app: "slack" }, servers: [{ auth: { kind: "provider", provider: "pipedream", app: "slack" } }] });
    const start = await call(h, "GET", `${API}/plugins/slack/servers/slack/connect`, { creds: ada.creds });
    const link = new URL(start.headers.get("location")!);
    expect(link.searchParams.get("app")).toBe("slack");
    const tokenRequest = JSON.parse(fetch.seen.find(s => s.url.endsWith("/tokens"))!.body);
    const callback = new URL(tokenRequest.success_redirect_uri);
    expect(callback.origin + callback.pathname).toBe("http://baskule.test/api/baskule/plugins/provider/callback");
    expect(tokenRequest.external_user_id).toMatch(/^bsk_[0-9a-f]{64}$/);
    expect(tokenRequest.external_user_id).not.toContain(ada.userId);
    const done = await call(h, "GET", callback.pathname + callback.search, { creds: ada.creds });
    expect(new URL(done.headers.get("location")!).search).toBe("?plugin=slack&connection=connected");
    expect(((await call(h, "GET", `${API}/plugins`, { creds: ada.creds })).body as MemberPluginList).plugins[0]!.servers[0]!.connection).toMatchObject({ state: "connected", account: "ada@acme.test" });
    const input = { spaceId: personalSpaceOf(h, ada.userId), userId: ada.userId, pluginId: "slack", serverId: "slack" };
    expect(await credential(h, input)).toEqual({ ok: true, network: "public", transport: "streamable-http", url: "https://remote.mcp.pipedream.net/v3", headers: expect.objectContaining({
      authorization: "Bearer pd-token", "x-pd-app-slug": "slack", "x-pd-account-id": "apn_1", "x-pd-external-user-id": tokenRequest.external_user_id, "x-pd-environment": "development" }) });
    await call(h, "DELETE", `${API}/plugins/slack/servers/slack/connection`, { creds: ada.creds });
    expect(fetch.seen.at(-1)).toMatchObject({ method: "DELETE", url: `${PD}/v1/connect/proj/accounts/apn_1` });
    expect(await credential(h, input)).toMatchObject({ ok: false, error: "sign_in_required" });
    await call(h, "DELETE", `${API}/admin/plugin-providers/pipedream`, { creds: admin });
    expect((await call(h, "GET", `${API}/admin/plugins/slack`, { creds: admin })).body.servers[0].setup).toEqual({ state: "needs_provider", provider: "pipedream" });
  });
});
