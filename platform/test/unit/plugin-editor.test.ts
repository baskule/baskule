import { describe, expect, it } from "vitest";
import { asAdmin, call, createUser, makeService, personalSpaceOf, signIn } from "../support/harness";
import { fakeMcp } from "../fixtures/mcp.mjs";
import { fakeOAuth } from "../fixtures/oauth.mjs";
import { INTERNAL_HEADER } from "../../src/shared/contract";
import { PluginMcpProxy } from "../../src/agent/plugin-mcp";
import type { PluginCredential, PluginInput, PluginServer } from "../../../app/packages/contracts/src/baskule-plugins";

interface RpcResult { result: { tools: { name: string }[]; isError?: boolean; content: { type: string; text: string }[] } }
const root = "/api/baskule/admin/plugins";
describe("admin MCP editor", () => {
  it("keeps current tool switches when an editor omits them for the same name and URL", async () => {
    const h = await makeService(); const a = await asAdmin(h);
    const input: PluginInput = { name: "Notes", description: "", source: { type: "custom" }, omitted: [], skills: [],
      servers: ["notes", "renamed", "moved"].map(name => ({ name, url: `https://example.test/${name}`, credential: "none" })) };
    const created = await call(h, "POST", root, { creds: a.creds, body: { groups: ["everyone"], plugin: input } });
    expect(created.status).toBe(201);
    expect(created.body.servers.map((server: PluginServer) => server.disabledTools)).toEqual([[], [], []]);
    const path = `${root}/${created.body.id}`;
    expect((await call(h, "PATCH", path, { creds: a.creds, body: { disabledTools: {
      notes: ["fixture_write"], renamed: ["fixture_write"], moved: ["fixture_write"],
    } } })).status).toBe(200);
    const edited: PluginInput = { ...input, description: "Edited in an earlier tab", servers: input.servers.map(server => ({ ...server,
      ...(server.name === "notes" ? { credential: "organization" } : {}),
      ...(server.name === "renamed" ? { name: "new-name" } : {}),
      ...(server.name === "moved" ? { url: "https://example.test/new-address" } : {}),
    })) };
    const saved = await call(h, "PATCH", path, { creds: a.creds, body: { plugin: edited } });
    expect(saved.status).toBe(200);
    expect(saved.body.servers.map((server: PluginServer) => server.disabledTools)).toEqual([["fixture_write"], [], []]);
    expect(h.svc.plugins.get(created.body.id)?.servers.map(server => server.disabledTools)).toEqual([["fixture_write"], [], []]);
    for (const disabledTools of [["fixture_read"], []]) {
      const explicit = { ...edited, servers: edited.servers.map(server => ({ ...server, disabledTools })) };
      const changed = await call(h, "PATCH", path, { creds: a.creds, body: { plugin: explicit } });
      expect(changed.status).toBe(200);
      expect(h.svc.plugins.get(created.body.id)?.servers[0].disabledTools).toEqual(disabledTools);
    }
  });
  it("tests unsaved servers with a key, saves nothing and enforces admin outbound policy", async () => {
    const f = await fakeMcp({ key: "Bearer test-key", paginate: true });
    try {
      const h = await makeService(); const a = await asAdmin(h);
      const bob = await createUser(h, a.creds, "mcp-test@os.test", "Bob");
      const b = await signIn(h, bob.email, "user-password-1");
      const body = { server: { name: "notes", url: f.resource, credential: "organization" }, headers: { Authorization: "Bearer test-key" } };
      expect((await call(h, "POST", `${root}/test`, { creds: b.creds, body })).status).toBe(403);
      expect((await call(h, "POST", `${root}/test`, { creds: a.creds, body })).body.tools).toEqual(f.tools.map(({ name, description }) => ({ name, description })));
      expect(h.svc.plugins.list()).toEqual([]);
      expect(h.storage.sql.exec("select * from plugin_secret").toArray()).toEqual([]);
      for (const transport of ["streamable-http", "sse"]) expect((await call(h, "POST", `${root}/test`, { creds: a.creds, body: { ...body, server: { ...body.server, transport }, headers: {} } })).body.error).toBe("key_required");
      expect((await call(h, "POST", `${root}/test`, { creds: a.creds, body: { ...body, server: { ...body.server, url: "http://baskule-mcp.internal/mcp" } } })).body.error).toBe("address_not_allowed");
      expect((await call(h, "POST", `${root}/test`, { creds: a.creds, body: { ...body, headers: { Host: "elsewhere" } } })).body.error).toBe("invalid_secret_headers");
    } finally { await f.close(); }
  });
  it.each(["streamable-http", "sse"] as const)("detects OAuth and static-client setup over %s without starting sign-in", async transport => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const a = await asAdmin(h);
      const test = () => call(h, "POST", `${root}/test`, { creds: a.creds, body: { server: { name: "notes", url: f.resource, credential: "none", transport } } });
      expect((await test()).body).toEqual({ signIn: "account", staticClient: false });
      f.state.dcr = false;
      expect((await test()).body).toEqual({ signIn: "account", staticClient: true });
      expect(f.state.registrations).toBe(0); expect(f.state.exchanges).toBe(0);
      expect(h.svc.plugins.list()).toEqual([]);
    } finally { await f.close(); }
  });
  it("keeps saved keys across tool switches and denies stale calls before contacting the vendor", async () => {
    const f = await fakeMcp({ key: "Bearer test-key" });
    try {
      const h = await makeService(); const a = await asAdmin(h);
      const created = await call(h, "POST", root, { creds: a.creds, body: { groups: ["everyone"], plugin: { name: "Notes", description: "", source: { type: "custom" }, omitted: [], skills: [], servers: [{ name: "notes", url: f.resource, credential: "organization" }] } } });
      expect(created.body.servers[0].disabledTools).toEqual([]);
      const id = created.body.id, path = `${root}/${id}`;
      await call(h, "PUT", `${path}/secret`, { creds: a.creds, body: { server: "notes", headers: { Authorization: "Bearer test-key" } } });
      const [settings] = (await h.svc.plugins.settings(personalSpaceOf(h, a.userId))).servers;
      const credential = async (_userId: string, input: { tool?: string }): Promise<PluginCredential> => (await call(h, "POST", "/_baskule/plugin-credential", { headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId: personalSpaceOf(h, a.userId), userId: a.userId, pluginId: id, server: "notes", ...input } })).body;
      const proxy = new PluginMcpProxy(settings, async () => ({ id: a.userId, name: "Admin" }), credential);
      const rpc = async (method: string) => (await proxy.handler(new Request("http://proxy/mcp", { method: "POST", body: JSON.stringify({ id: 1, method, params: { name: "fixture_write", arguments: {}, _meta: { "ai.opencode/sessionID": "session" } } }) }))).json() as Promise<RpcResult>;
      try {
        expect((await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name)).toContain("fixture_write");
        const switched = await call(h, "PATCH", path, { creds: a.creds, body: { disabledTools: { notes: ["fixture_write"] } } });
        expect(switched.status).toBe(200);
        expect(await h.svc.plugins.organizationHeaders(id, "notes")).toEqual({ Authorization: "Bearer test-key" });
        const denied = await rpc("tools/call");
        expect(denied.result).toEqual({ isError: true, content: [{ type: "text", text: "Your administrator turned this tool off." }] });
        expect(f.calls).toEqual([]);
        const current = (await h.svc.plugins.settings(personalSpaceOf(h, a.userId))).servers[0];
        const fresh = new PluginMcpProxy(current, async () => ({ id: a.userId, name: "Admin" }), credential);
        try {
          const listed = await (await fresh.handler(new Request("http://proxy/mcp", { method: "POST", body: JSON.stringify({ id: 1, method: "tools/list" }) }))).json() as RpcResult;
          expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(["fixture_read"]);
        } finally { await fresh.close(); }
        expect((await call(h, "GET", `${path}/tools?server=notes`, { creds: a.creds })).body.tools).toHaveLength(2);
        await call(h, "PATCH", path, { creds: a.creds, body: { disabledTools: { notes: [] } } });
        expect((await rpc("tools/call")).result.isError).not.toBe(true);
        expect(f.calls).toEqual(["fixture_write"]);
      } finally { await proxy.close(); }
    } finally { await f.close(); }
  });
});
