import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { Group, Plugin } from "../../../app/packages/contracts/src/baskule-plugins";
import { asAdmin, call, createUser, makeService, personalSpaceOf, signIn } from "../support/harness";
import { INTERNAL_HEADER } from "../../src/shared/contract";
import { pluginStatus, worstStatus, canUse, type PluginPolicy, Plugins } from "../../src/control/plugins";
import { ConnectionCipher } from "../../src/control/connection-crypto";
import { base64 } from "../../src/control/plugin-package";
import { resolveGroupPermissions } from "../../src/control/groups";

const API = "/api/baskule";
const plugin: Plugin = { id: "plugin", vendor: "plugin", name: "Test", description: "", source: { type: "custom" }, skills: [], servers: [{ name: "remote", url: "https://example.test/mcp", credential: "none", disabledTools: [] }], omitted: [], enabled: true, createdAt: "2026-10-25T00:00:00Z" };
const input = { name: plugin.name, description: plugin.description, source: { type: "custom" }, servers: plugin.servers, skills: [], omitted: [] };
const everyone: Group = { id: "everyone", name: "Everyone", builtin: "everyone", members: [], permissions: { canCreateSpaces: false }, plugins: [plugin.id] };
const snapshot = (): PluginPolicy => ({ user: { id: "alice", banned: false }, space: { id: "team", kind: "team", members: ["alice"], settings: { personalPluginsAllowed: false, disabled: [] } }, plugin: structuredClone(plugin), assigned: true });

describe("pure plugin policy", () => {
  it("unions group grants and capabilities; Everyone includes future users", () => {
    const group: Group = { id: "creators", name: "Creators", members: ["alice"], permissions: { canCreateSpaces: true }, plugins: ["another"] };
    expect(resolveGroupPermissions("alice", [everyone, group])).toEqual({ canCreateSpaces: true, plugins: ["plugin", "another"] });
    expect(resolveGroupPermissions("future", [everyone, group])).toEqual({ canCreateSpaces: false, plugins: ["plugin"] });
  });
  it("requires assignment, membership, Pause and personal-space consent", () => {
    const check = (s: PluginPolicy) => canUse("alice", "team", "plugin", "remote", s);
    expect(check(snapshot())).toEqual({ allowed: true });
    for (const mutate of [
      (s: PluginPolicy) => { s.user = undefined; },
      (s: PluginPolicy) => { s.user!.banned = true; },
      (s: PluginPolicy) => { s.space = undefined; },
      (s: PluginPolicy) => { s.space!.members = []; },
      (s: PluginPolicy) => { s.plugin = undefined; },
      (s: PluginPolicy) => { s.assigned = false; },
      (s: PluginPolicy) => { s.plugin!.servers = []; },
      (s: PluginPolicy) => { s.plugin!.servers[0].credential = "user-oauth"; },
    ]) {
      const s = snapshot(); mutate(s);
      expect(check(s)).toEqual({ allowed: false, error: "unavailable" });
    }
    for (const mutate of [
      (s: PluginPolicy) => { s.plugin!.enabled = false; },
      (s: PluginPolicy) => { s.space!.settings.disabled = ["plugin"]; },
    ]) {
      const s = snapshot(); mutate(s);
      expect(check(s)).toEqual({ allowed: false, error: "unavailable" });
    }
    const personal = snapshot(); personal.plugin!.servers[0].credential = "user-oauth";
    personal.space!.settings.personalPluginsAllowed = true;
    expect(check(personal)).toEqual({ allowed: true });
    personal.space!.settings.personalPluginsAllowed = false; personal.space!.kind = "personal";
    expect(check(personal)).toEqual({ allowed: true });
    expect(canUse("other", "team", "plugin", "remote", snapshot()).allowed).toBe(false);
    expect(canUse("alice", "other", "plugin", "remote", snapshot()).allowed).toBe(false);
    expect(canUse("alice", "team", "other", "remote", snapshot()).allowed).toBe(false);
  });
});

describe("ControlCell plugins and groups", () => {
  it("starts empty, derives space creation from groups, and protects Everyone", async () => {
    const h = await makeService(); const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob");
    const b = await signIn(h, "bob@os.test", "user-password-1");
    const admin = { creds: a.creds };
    expect((await call(h, "GET", `${API}/admin/plugins`, admin)).body).toEqual({ plugins: [] });
    const groups = (await call(h, "GET", `${API}/admin/groups`, admin)).body.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toContain(bob.id);
    expect((await call(h, "GET", `${API}/admin/groups`, { creds: b.creds })).status).toBe(403);
    expect((await call(h, "DELETE", `${API}/admin/groups/everyone`, admin)).status).toBe(409);
    expect((await call(h, "PATCH", `${API}/admin/groups/everyone`, { ...admin, body: { members: [] } })).status).toBe(409);
    expect(b.me.user.canCreateSpaces).toBe(false);
    const created = await call(h, "POST", `${API}/admin/groups`, { ...admin, body: { name: "Creators", members: [bob.id], permissions: { canCreateSpaces: true }, plugins: [] } });
    expect(created.status).toBe(201);
    expect((await call(h, "GET", `${API}/me`, { creds: b.creds })).body.user.canCreateSpaces).toBe(true);
    await call(h, "DELETE", `${API}/admin/groups/${created.body.id}`, admin);
    expect((await call(h, "POST", `${API}/spaces`, { creds: b.creds, body: { name: "Denied" } })).status).toBe(403);
    expect(h.storage.sql.exec("pragma table_info(user_profile)").toArray().map(c => c.name)).not.toContain("can_create_spaces");
    expect((await call(h, "GET", `${API}/admin/users`, admin)).body.users[0]).not.toHaveProperty("canCreateSpaces");
  });

  it("enforces user grants and all switches; organization secrets stay write-only and are deleted with the plugin", async () => {
    const h = await makeService(); const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob"); const b = await signIn(h, "bob@os.test", "user-password-1");
    const admin = { creds: a.creds }; const member = { creds: b.creds };
    expect((await call(h, "POST", `${API}/admin/plugins`, { ...member, body: { groups: [], plugin: input } })).status).toBe(403);
    const installed = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [], plugin: { ...input, name: "Docs" } } });
    expect(installed.status).toBe(201); expect(installed.body.enabled).toBe(true);
    const id = installed.body.id;
    const path = `${API}/admin/plugins/${id}`;
    const spaceId = personalSpaceOf(h, bob.id);
    await call(h, "PATCH", `${API}/admin/groups/everyone`, { ...admin, body: { plugins: [id] } });
    expect(h.svc.plugins.canUse(bob.id, spaceId, id, "remote")).toEqual({ allowed: true });
    await call(h, "PATCH", path, { ...admin, body: { plugin: { ...input, servers: [{ url: "https://example.test/mcp", name: "remote", credential: "organization" }] } } });
    expect((await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "remote", headers: { Authorization: "Bearer private-organization-key" } } })).status).toBe(200);
    expect(h.svc.plugins.canUse(bob.id, spaceId, id, "remote")).toEqual({ allowed: true });
    expect(await h.svc.plugins.organizationHeaders(id, "remote")).toEqual({ Authorization: "Bearer private-organization-key" });
    expect(h.storage.sql.exec("select data from plugin_secret").toArray()[0].data).not.toContain("private-organization-key");
    const requestCredential = (userId = bob.id) => call(h, "POST", "/_baskule/plugin-credential", { headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId, pluginId: id, server: "remote", userId } });
    expect((await requestCredential()).body).toMatchObject({ headers: { Authorization: "Bearer private-organization-key" }, expiresAt: expect.any(Number) });
    expect((await requestCredential("outsider")).body).toEqual({ error: "unavailable" });
    expect((await call(h, "POST", "/_baskule/plugin-credential", { body: { spaceId, pluginId: id, server: "remote", userId: bob.id } })).status).toBe(404);
    await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "remote", headers: null } });
    expect((await requestCredential()).body).toEqual({ error: "needs_setup" });
    await call(h, "PATCH", path, { ...admin, body: { plugin: { ...input, servers: [{ url: "https://example.test/mcp", name: "remote", credential: "none" }] } } });
    expect((await requestCredential()).body).toMatchObject({ headers: {} });
    await call(h, "PATCH", path, { ...admin, body: { plugin: { ...input, servers: [{ url: "https://example.test/mcp", name: "remote", credential: "organization" }] } } });
    await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "remote", headers: { Authorization: "Bearer private-organization-key" } } });
    await call(h, "PATCH", path, { ...admin, body: { plugin: { ...input, servers: [{ name: "remote", url: "https://CHANGED.test/mcp", credential: "organization" }] } } });
    expect(await h.svc.plugins.organizationHeaders(id, "remote")).toBeUndefined();
    await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "remote", headers: { Authorization: "Bearer private-organization-key" } } });
    const mine = await call(h, "GET", `${API}/plugins`, member);
    expect(mine.body.plugins[0]).toMatchObject({ status: "ready", servers: [{ name: "remote", credential: "organization", status: "ready" }] });
    const settings = await call(h, "POST", "/_baskule/settings", { headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId } });
    expect(settings.body.plugins.servers[0]).toMatchObject({ pluginId: id, credential: "organization" });
    for (const value of [mine.body, settings.body, (await call(h, "GET", `${API}/admin/plugins`, admin)).body]) expect(JSON.stringify(value)).not.toContain("private-organization-key");
    expect((await call(h, "POST", "/_baskule/settings", { body: { spaceId } })).status).toBe(404);
    await call(h, "PATCH", `${API}/admin/groups/everyone`, { ...admin, body: { plugins: [] } });
    expect(h.svc.plugins.canUse(bob.id, spaceId, id, "remote")).toEqual({ allowed: false, error: "unavailable" });
    await call(h, "DELETE", path, admin);
    expect(h.storage.sql.exec("select * from plugin_secret").toArray()).toEqual([]);
    expect(h.storage.sql.exec("select name from sqlite_master where name='user_plugin'").toArray()).toEqual([]);
  });

  it("space settings are owner-only; personal servers default off in team spaces and skills remain space-scoped", async () => {
    const h = await makeService(); const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob"); const b = await signIn(h, "bob@os.test", "user-password-1");
    const admin = { creds: a.creds }; const member = { creds: b.creds };
    const team = (await call(h, "POST", `${API}/spaces`, { ...admin, body: { name: "Team", members: [{ userId: bob.id }] } })).body.space.id;
    const installed = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [], plugin: input } });
    const id = installed.body.id;
    await call(h, "PATCH", `${API}/admin/groups/everyone`, { ...admin, body: { plugins: [id] } });
    await call(h, "PATCH", `${API}/admin/plugins/${id}`, { ...admin, body: { plugin: { ...input, servers: [{ url: "https://example.test/mcp", name: "remote", credential: "user-oauth" }] } } });
    expect(await h.svc.plugins.settings(team)).toEqual({ servers: [], skills: [] });
    expect((await h.svc.plugins.settings(personalSpaceOf(h, bob.id))).servers).toEqual([]);
    expect((await call(h, "GET", `${API}/spaces/${team}/plugins`, member)).status).toBe(403);
    expect((await call(h, "PUT", `${API}/spaces/${team}/plugins`, { ...admin, body: { personalPluginsAllowed: true, disabled: [] } })).status).toBe(200);
    expect((await h.svc.plugins.settings(team)).servers).toEqual([]);
    await call(h, "PUT", `${API}/spaces/${team}/plugins`, { ...admin, body: { personalPluginsAllowed: true, disabled: [id] } });
    expect((await h.svc.plugins.settings(team)).servers).toEqual([]);
    expect((await call(h, "GET", `${API}/spaces/${personalSpaceOf(h, bob.id)}/plugins`, admin)).status).toBe(200);
    expect((await call(h, "GET", `${API}/spaces/${personalSpaceOf(h, bob.id)}/plugins`, member)).body).toEqual({ personalPluginsAllowed: false, disabled: [] });
  });

  it("edits a pinned plugin's identity without changing its skills and clears the icon", async () => {
    const h = await makeService(); const a = await asAdmin(h); const admin = { creds: a.creds };
    const original = { ...input, icon: "https://example.com/icon.png", source: { type: "github", repo: "https://github.com/example/plugin", sha: "a".repeat(40) },
      skills: [{ name: "hello", description: "Say hello", instructions: "Hello\n", frontmatter: "license: MIT\n", files: [] }] };
    const created = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [], plugin: original } });
    expect(created.status).toBe(201);
    const path = `${API}/admin/plugins/${created.body.id}`;
    const history = await call(h, "GET", `${path}/skills`, admin);
    expect(history.body.editable).toBe(false);
    const { icon: _icon, ...withoutIcon } = original;
    const edited = { ...withoutIcon, name: "Renamed", skills: history.body.skills };
    const result = await call(h, "PATCH", path, { ...admin, body: { plugin: edited } });
    expect(result.status).toBe(200);
    expect(result.body.name).toBe("Renamed");
    expect(result.body).not.toHaveProperty("icon");
    edited.skills[0].instructions = "Changed";
    expect((await call(h, "PATCH", path, { ...admin, body: { plugin: edited } })).body.error).toBe("not_editable");
  });

  it("resolves and inspects GitHub contents without saving and refuses proprietary paths", async () => {
    const h = await makeService();
    const text = "---\nname: hello\ndescription: Say hello\n---\nHello\n";
    const store = new Plugins(h.storage, h.svc.groups, new ConnectionCipher("test"), async (url, init) => {
      if (String(url).includes("/commits/")) { expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github.sha"); return decodeURIComponent(String(url).split("/commits/")[1]) === "main" ? new Response("a".repeat(40)) : new Response(null, { status: 404 }); }
      if (String(url).includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ path: "skills/hello/SKILL.md", mode: "100644", type: "blob", size: new TextEncoder().encode(text).length }] });
      return new Response(text);
    });
    const request = (github: string) => new Request("http://control", { method: "POST", body: JSON.stringify({ github }) });
    const result = await store.admin(request("https://github.com/example/plugin/tree/main/skills/hello"), "/admin/plugins/inspect", "admin");
    const draft = await result.json();
    expect(draft).toMatchObject({ plugin: { source: { type: "github", repo: "https://github.com/example/plugin", sha: "a".repeat(40), path: "skills/hello" }, skills: [{ name: "hello" }] } });
    expect(store.list()).toEqual([]);
    await expect(store.admin(request("https://github.com/anthropics/skills/tree/main/skills/pdf"), "/admin/plugins/inspect", "admin")).rejects.toMatchObject({ code: "proprietary_plugin" });
  });

  it("reviews without saving, validates fixes, exports without keys and accepts private admin addresses", async () => {
    const h = await makeService(); const a = await asAdmin(h); const admin = { creds: a.creds };
    const archive = zipSync({ ".claude-plugin/plugin.json": new TextEncoder().encode('{"name":"Reviewed"}'),
      ".mcp.json": new TextEncoder().encode(JSON.stringify({ mcpServers: { remote: { url: "https://{tenant}.example.com/mcp", headers: { Authorization: "Bearer DO-NOT-STORE" } } } })),
      "skills/hello/SKILL.md": new TextEncoder().encode("---\nname: hello\ndescription: Say hello\n---\nHello\n"),
    });
    const inspected = await call(h, "POST", `${API}/admin/plugins/inspect`, { ...admin, body: { archive: base64(archive) } });
    expect(inspected.status).toBe(200);
    expect(inspected.body.fixes).toEqual(expect.arrayContaining([{ server: "remote", need: "address", placeholders: ["{tenant}"] }, { server: "remote", need: "key", headers: ["Authorization"] }]));
    expect(JSON.stringify(inspected.body)).not.toContain("DO-NOT-STORE");
    expect(h.svc.plugins.list()).toEqual([]);
    const draft = inspected.body.plugin;
    expect((await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { plugin: draft, groups: ["everyone"] } })).body.error).toBe("address_placeholder");
    draft.servers[0].url = "http://127.0.0.1/mcp";
    const added = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { plugin: draft, groups: ["everyone"] } });
    expect(added.status).toBe(201);
    expect((await h.svc.plugins.settings(personalSpaceOf(h, a.userId))).skills[0].name).toBe("hello");
    expect((await call(h, "PUT", `${API}/admin/plugins/${added.body.id}/secret`, { ...admin, body: { server: "remote", headers: { Authorization: "Bearer encrypted-key" } } })).status).toBe(200);
    const unfinished = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [], plugin: { ...draft, servers: [{ ...draft.servers[0], keyHeaders: ["X-Api-Key", "X-Workspace"] }] } } });
    const unfinishedZip = await h.svc.plugins.admin(new Request("http://control"), `/admin/plugins/${unfinished.body.id}/export`, a.userId);
    const unfinishedDraft = await call(h, "POST", `${API}/admin/plugins/inspect`, { ...admin, body: { archive: base64(new Uint8Array(await unfinishedZip.arrayBuffer())) } });
    expect(unfinishedDraft.body.fixes).toContainEqual({ server: "remote", need: "key", headers: ["X-Api-Key", "X-Workspace"] });
    await call(h, "PUT", `${API}/admin/plugins/${unfinished.body.id}/secret`, { ...admin, body: { server: "remote", headers: { "X-Api-Key": "private-key", "X-Workspace": "private-workspace" } } });
    const renamed = await call(h, "PATCH", `${API}/admin/plugins/${unfinished.body.id}`, { ...admin, body: { plugin: { ...draft, servers: [{ ...draft.servers[0], keyHeaders: ["X-Changed"] }] } } });
    expect(renamed.body.servers[0].keyHeaders).toEqual(["X-Api-Key", "X-Workspace"]);
    expect(await h.svc.plugins.organizationHeaders(unfinished.body.id, "remote")).toEqual({ "X-Api-Key": "private-key", "X-Workspace": "private-workspace" });
    await call(h, "PUT", `${API}/admin/plugins/${unfinished.body.id}/secret`, { ...admin, body: { server: "remote", headers: { "X-Changed": "private-renamed" } } });
    expect(h.svc.plugins.get(unfinished.body.id)!.servers[0].keyHeaders).toEqual(["X-Changed"]);
    expect(await h.svc.plugins.organizationHeaders(unfinished.body.id, "remote")).toEqual({ "X-Changed": "private-renamed" });
    const renamedZip = await h.svc.plugins.admin(new Request("http://control"), `/admin/plugins/${unfinished.body.id}/export`, a.userId);
    const renamedDraft = await call(h, "POST", `${API}/admin/plugins/inspect`, { ...admin, body: { archive: base64(new Uint8Array(await renamedZip.arrayBuffer())) } });
    expect(renamedDraft.body.fixes).toContainEqual({ server: "remote", need: "key", headers: ["X-Changed"] });
    const preserve = await call(h, "PATCH", `${API}/admin/plugins/${added.body.id}`, { ...admin, body: { plugin: { ...draft, servers: [{ ...draft.servers[0], keyHeaders: ["X-Changed"] }] } } });
    expect(preserve.body.servers[0].keyHeaders).toEqual(["Authorization"]);
    expect(await h.svc.plugins.organizationHeaders(added.body.id, "remote")).toEqual({ Authorization: "Bearer encrypted-key" });
    const exported = await h.svc.plugins.admin(new Request("http://control"), `/admin/plugins/${added.body.id}/export`, a.userId);
    expect(exported.headers.get("Content-Type")).toBe("application/zip");
    const bytes = new Uint8Array(await exported.arrayBuffer());
    const again = await call(h, "POST", `${API}/admin/plugins/inspect`, { ...admin, body: { archive: base64(bytes) } });
    expect(again.body.plugin.skills).toEqual(draft.skills);
    expect(JSON.stringify(again.body)).not.toContain("encrypted-key");
    expect(again.body.fixes).toContainEqual({ server: "remote", need: "key", headers: ["Authorization"] });
    expect((await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [], source: { type: "url", url: "https://retired.test" } } })).status).toBe(400);
  });
});

describe("assignment and member status", () => {
  it("derives the five statuses in priority order", () => {
    expect(pluginStatus({ allowed: false })).toBe("unavailable");
    expect(pluginStatus({ allowed: true })).toBe("ready");
    for (const credential of ["none", "organization", "user-oauth"] as const) {
      expect(pluginStatus({ allowed: false, server: { credential, setupDone: false, account: "ready" } })).toBe("unavailable");
      expect(pluginStatus({ allowed: true, server: { credential, setupDone: false, account: "ready" } })).toBe("needs_setup");
    }
    for (const credential of ["user-oauth"] as const) {
      for (const account of ["connect", "reconnect", "ready"] as const) expect(pluginStatus({ allowed: true, server: { credential, setupDone: true, account } })).toBe(account);
      expect(pluginStatus({ allowed: true, server: { credential, setupDone: true } })).toBe("connect");
    }
    expect(worstStatus(["ready", "reconnect", "connect", "needs_setup", "unavailable"])).toBe("unavailable");
  });

  it("serves only the owner's assigned skills and the team's non-banned union; membership changes reload", async () => {
    const h = await makeService(); const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "skills@os.test", "Skills");
    const admin = { creds: a.creds };
    const team = (await call(h, "POST", `${API}/spaces`, { ...admin, body: { name: "Team", members: [{ userId: bob.id }] } })).body.space.id;
    const group = (await call(h, "POST", `${API}/admin/groups`, { ...admin, body: { name: "Skill users", members: [bob.id], permissions: { canCreateSpaces: false }, plugins: [] } })).body;
    const bytes = zipSync({ "hello/SKILL.md": new TextEncoder().encode("---\nname: hello\ndescription: Say hello\n---\nHello\n") });
    const draft = await call(h, "POST", `${API}/admin/plugins/inspect`, { creds: a.creds, body: { archive: base64(bytes) } });
    const installed = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [group.id], plugin: draft.body.plugin } });
    expect(installed.status).toBe(201);
    expect(installed.body.enabled).toBe(true);
    const id = installed.body.id;
    expect((await h.svc.plugins.statusFor(bob.id, h.svc.plugins.get(id)!)).status).toBe("ready");
    expect((await h.svc.plugins.settings(personalSpaceOf(h, a.userId))).skills).toEqual([]);
    expect((await h.svc.plugins.settings(personalSpaceOf(h, bob.id))).skills).toHaveLength(1);
    expect((await h.svc.plugins.settings(team)).skills).toHaveLength(1);
    h.calls.length = 0;
    expect((await call(h, "POST", `${API}/admin/users/${bob.id}/deactivate`, admin)).status).toBe(200);
    expect((await h.svc.plugins.settings(team)).skills).toEqual([]);
    expect(h.calls.some(c => c.spaceId === team && c.path === "/_baskule/reconfigure")).toBe(true);
    expect((await call(h, "POST", `${API}/admin/users/${bob.id}/activate`, admin)).status).toBe(200);
    expect((await h.svc.plugins.settings(team)).skills).toHaveLength(1);
    expect((await call(h, "DELETE", `${API}/spaces/${team}/members/${bob.id}`, admin)).status).toBe(200);
    expect((await h.svc.plugins.settings(team)).skills).toEqual([]);
    expect((await call(h, "POST", `${API}/spaces/${team}/members`, { ...admin, body: { userId: bob.id } })).status).toBe(201);
    expect((await h.svc.plugins.settings(team)).skills).toHaveLength(1);
    await call(h, "PATCH", `${API}/admin/plugins/${id}`, { ...admin, body: { enabled: false } });
    expect((await h.svc.plugins.statusFor(bob.id, h.svc.plugins.get(id)!)).status).toBe("unavailable");
    expect((await h.svc.plugins.settings(team)).skills).toEqual([]);
  });
});
