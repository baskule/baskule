import { ConnectionCipher } from "../../src/control/connection-crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { Group, Plugin } from "../../../app/packages/contracts/src/baskule-plugins";
import { asAdmin, call, createUser, makeService, personalSpaceOf, signIn } from "../support/harness";
import { INTERNAL_HEADER } from "../../src/shared/contract";
import { pluginStatus, worstStatus, canUse, type PluginPolicy, Plugins } from "../../src/control/plugins";
import { base64, sha256 } from "../../src/control/plugin-import";
import { resolveGroupPermissions } from "../../src/control/groups";

const API = "/api/baskule";
const plugin: Plugin = { id: "plugin", name: "Test", description: "", source: { type: "url", url: "https://example.test/mcp" }, skills: [], servers: [{ name: "remote", url: "https://example.test/mcp", credential: "none", personal: false }], ignored: [], enabled: true, createdAt: "2026-10-25T00:00:00Z" };
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
      (s: PluginPolicy) => { s.plugin!.servers[0].personal = true; },
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
    const personal = snapshot(); personal.plugin!.servers[0].personal = true;
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
    expect((await call(h, "POST", `${API}/admin/plugins`, { ...member, body: { groups: [], source: plugin.source } })).status).toBe(403);
    const installed = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [], source: plugin.source, name: "Docs" } });
    expect(installed.status).toBe(201); expect(installed.body.enabled).toBe(true);
    const id = installed.body.id;
    const path = `${API}/admin/plugins/${id}`;
    const spaceId = personalSpaceOf(h, bob.id);
    await call(h, "PATCH", `${API}/admin/groups/everyone`, { ...admin, body: { plugins: [id] } });
    expect(h.svc.plugins.canUse(bob.id, spaceId, id, "remote")).toEqual({ allowed: true });
    await call(h, "PATCH", path, { ...admin, body: { enabled: true, servers: [{ name: "remote", credential: "organization", personal: true }] } });
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
    await call(h, "PATCH", path, { ...admin, body: { servers: [{ name: "remote", credential: "none", personal: false }] } });
    expect((await requestCredential()).body).toMatchObject({ headers: {} });
    await call(h, "PATCH", path, { ...admin, body: { servers: [{ name: "remote", credential: "organization", personal: false }] } });
    await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "remote", headers: { Authorization: "Bearer private-organization-key" } } });
    h.storage.sql.exec("insert into plugin_oauth_client(plugin_id,server,data) values (?,?,?)", id, "remote", "sealed-static-client").toArray();
    await call(h, "PATCH", path, { ...admin, body: { servers: [{ name: "remote", url: "https://CHANGED.test/mcp", credential: "organization", personal: false }] } });
    expect(await h.svc.plugins.organizationHeaders(id, "remote")).toBeUndefined();
    expect(h.storage.sql.exec("select * from plugin_oauth_client where plugin_id=?", id).toArray()).toEqual([]);
    await call(h, "PUT", `${path}/secret`, { ...admin, body: { server: "remote", headers: { Authorization: "Bearer private-organization-key" } } });
    const mine = await call(h, "GET", `${API}/plugins`, member);
    expect(mine.body.plugins[0]).toMatchObject({ status: "ready", servers: [{ name: "remote", personal: false, status: "ready" }] });
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
    const installed = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [], source: plugin.source } });
    const id = installed.body.id;
    await call(h, "PATCH", `${API}/admin/groups/everyone`, { ...admin, body: { plugins: [id] } });
    await call(h, "PATCH", `${API}/admin/plugins/${id}`, { ...admin, body: { enabled: true, servers: [{ name: "remote", credential: "user-oauth", personal: true }] } });
    expect(h.svc.plugins.settings(team)).toEqual({ servers: [], skills: [] });
    expect(h.svc.plugins.settings(personalSpaceOf(h, bob.id)).servers).toHaveLength(1);
    expect((await call(h, "GET", `${API}/spaces/${team}/plugins`, member)).status).toBe(403);
    expect((await call(h, "PUT", `${API}/spaces/${team}/plugins`, { ...admin, body: { personalPluginsAllowed: true, disabled: [] } })).status).toBe(200);
    expect(h.svc.plugins.settings(team).servers).toHaveLength(1);
    await call(h, "PUT", `${API}/spaces/${team}/plugins`, { ...admin, body: { personalPluginsAllowed: true, disabled: [id] } });
    expect(h.svc.plugins.settings(team).servers).toEqual([]);
    expect((await call(h, "GET", `${API}/spaces/${personalSpaceOf(h, bob.id)}/plugins`, admin)).status).toBe(200);
    expect((await call(h, "GET", `${API}/spaces/${personalSpaceOf(h, bob.id)}/plugins`, member)).body).toEqual({ personalPluginsAllowed: false, disabled: [] });
  });

  it("imports a pinned HTTPS repository and a hash-verified uploaded archive, keeping skills in private settings", async () => {
    const h = await makeService(); const a = await asAdmin(h);
    const root = new URL("../fixtures/plugins/portable/", import.meta.url);
    const files = Object.fromEntries(readdirSync(root, { withFileTypes: true, recursive: true }).filter(f => f.isFile()).map(f => {
      const path = join(f.parentPath, f.name); return [path.slice(root.pathname.length), new Uint8Array(readFileSync(path))];
    }));
    const bytes = zipSync(files);
    const input = { groups: [], source: { type: "archive", sha256: await sha256(bytes) }, archive: base64(bytes) };
    const installed = await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: input });
    expect(installed.status).toBe(201); expect(installed.body.skills).toHaveLength(1);
    expect(JSON.stringify(installed.body)).not.toContain("Say hello");
    const space = personalSpaceOf(h, a.userId);
    expect(h.svc.plugins.settings(space).skills).toEqual([]);
    await call(h, "PATCH", `${API}/admin/groups/everyone`, { creds: a.creds, body: { plugins: [installed.body.id] } });
    expect(h.svc.plugins.settings(space).skills[0].files.find(f => f.path === "SKILL.md")!.content).toContain("LS0t");
    const bad = await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { ...input, source: { type: "archive", sha256: "0".repeat(64) } } });
    expect(bad.body.error).toBe("archive_hash_mismatch");
    const loopback = await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { groups: [],source: { type: "url", url: "http://127.0.0.1/mcp" } } });
    await call(h, "PATCH", `${API}/admin/groups/everyone`, { creds: a.creds, body: { plugins: [loopback.body.id] } });
    await call(h, "PATCH", `${API}/admin/plugins/${loopback.body.id}`, { creds: a.creds, body: { enabled: true } });
    expect(h.svc.plugins.settings(space).servers[0].privateNetwork).toBe(true);
    const urls: string[] = [];
    const store = new Plugins(h.storage, h.svc.groups, new ConnectionCipher("test"), async url => {
      urls.push(String(url));
      if (String(url).includes("/git/trees/")) return Response.json({ truncated: false, tree: Object.entries(files).map(([path, bytes]) => ({ path, mode: "100644", type: "blob", size: bytes.length })) });
      const path = String(url).split(`${"a".repeat(40)}/`)[1];
      return new Response(files[path]);
    });
    const git = await store.admin(new Request("http://control", { method: "POST", body: JSON.stringify({ groups: [], source: { type: "git", repo: "https://github.com/example/plugin.git", ref: "a".repeat(40) } }) }), "/admin/plugins");
    expect(git.status).toBe(201);
    expect(urls[0]).toBe(`https://api.github.com/repos/example/plugin/git/trees/${"a".repeat(40)}?recursive=1`);
    const unpinned = await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { groups: [], source: { type: "git", repo: "https://github.com/example/plugin", ref: "main" } } });
    expect(unpinned.status).toBe(400);
  });
});

describe("assignment and member status", () => {
  it("derives the five statuses in priority order", () => {
    expect(pluginStatus({ allowed: false })).toBe("unavailable");
    expect(pluginStatus({ allowed: true })).toBe("ready");
    for (const credential of ["none", "organization", "user-oauth", "login-identity"] as const) {
      expect(pluginStatus({ allowed: false, server: { credential, setupDone: false, account: "ready" } })).toBe("unavailable");
      expect(pluginStatus({ allowed: true, server: { credential, setupDone: false, account: "ready" } })).toBe("needs_setup");
    }
    for (const credential of ["user-oauth", "login-identity"] as const) {
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
    const installed = await call(h, "POST", `${API}/admin/plugins`, { ...admin, body: { groups: [group.id], source: { type: "archive", sha256: await sha256(bytes) }, archive: base64(bytes) } });
    expect(installed.status).toBe(201);
    expect(installed.body.enabled).toBe(true);
    const id = installed.body.id;
    expect((await h.svc.plugins.statusFor(bob.id, h.svc.plugins.get(id)!)).status).toBe("ready");
    expect(h.svc.plugins.settings(personalSpaceOf(h, a.userId)).skills).toEqual([]);
    expect(h.svc.plugins.settings(personalSpaceOf(h, bob.id)).skills).toHaveLength(1);
    expect(h.svc.plugins.settings(team).skills).toHaveLength(1);
    h.calls.length = 0;
    expect((await call(h, "POST", `${API}/admin/users/${bob.id}/deactivate`, admin)).status).toBe(200);
    expect(h.svc.plugins.settings(team).skills).toEqual([]);
    expect(h.calls.some(c => c.spaceId === team && c.path === "/_baskule/reconfigure")).toBe(true);
    expect((await call(h, "POST", `${API}/admin/users/${bob.id}/activate`, admin)).status).toBe(200);
    expect(h.svc.plugins.settings(team).skills).toHaveLength(1);
    expect((await call(h, "DELETE", `${API}/spaces/${team}/members/${bob.id}`, admin)).status).toBe(200);
    expect(h.svc.plugins.settings(team).skills).toEqual([]);
    expect((await call(h, "POST", `${API}/spaces/${team}/members`, { ...admin, body: { userId: bob.id } })).status).toBe(201);
    expect(h.svc.plugins.settings(team).skills).toHaveLength(1);
    await call(h, "PATCH", `${API}/admin/plugins/${id}`, { ...admin, body: { enabled: false } });
    expect((await h.svc.plugins.statusFor(bob.id, h.svc.plugins.get(id)!)).status).toBe("unavailable");
    expect(h.svc.plugins.settings(team).skills).toEqual([]);
  });
});
