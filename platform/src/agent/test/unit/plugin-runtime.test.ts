import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMcpProxy } from "../../plugin-mcp";
import { planSkills, skillCatalog } from "../../plugin-skills";
import { resolveTurnAuthor } from "../../turn-author";
import type { PluginCredential, SpacePlugins } from "../../../../../app/packages/contracts/src/baskule-plugins";

const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,status TEXT,ordinal INTEGER,started_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents(child_thread_id TEXT,run_id TEXT,subagent_id TEXT,provider_thread_id TEXT,thread_id TEXT,origin TEXT,status TEXT,started_at TEXT);
    CREATE TABLE session_v2(id TEXT,parent_id TEXT,time_created INTEGER);`);
  const query = async (sql: string, bindings: readonly unknown[]) => db.prepare(sql).all(...bindings as (string | number | null)[]);
  function run(id: string, session: string, author?: typeof alice, extra = {}, status = "running") {
    db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?)").run(id, id, JSON.stringify({ nativeThreadRef: { nativeId: session } }));
    db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES(?,?,?,?,?,?)").run(id, id, status, 1, "2026-10-25T00:00:00.000Z", JSON.stringify({ userMessageId: id, providerThreadId: id }));
    db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES(?,?)").run(id, JSON.stringify({ author, ...extra }));
  }
  return { db, query, run };
}

describe("turn author", () => {
  it("isolates simultaneous sessions and ignores newer queued messages", async () => {
    const { db, query, run } = fixture();
    run("a", "ses-a", alice); run("b", "ses-b", bob); run("queued", "ses-a", bob, {}, "queued");
    expect(await resolveTurnAuthor("ses-a", query)).toEqual(alice);
    expect(await resolveTurnAuthor("ses-b", query)).toEqual(bob);
    expect(await resolveTurnAuthor("unknown", query)).toBeUndefined(); db.close();
  });
  it("inherits native children from the parent's run at birth, not its next turn", async () => {
    const { db, query, run } = fixture();
    run("a", "parent", alice, {}, "completed");
    db.prepare("INSERT INTO session_v2 VALUES(?,?,?)").run("child", "parent", Date.parse("2026-10-25T00:00:01Z"));
    db.prepare("INSERT INTO session_v2 VALUES(?,?,?)").run("grandchild", "child", Date.parse("2026-10-25T00:00:02Z"));
    run("b", "parent", bob);
    db.exec("UPDATE orchestration_v2_projection_runs SET ordinal=2,started_at='2026-10-25T00:00:03.000Z' WHERE run_id='b'");
    expect(await resolveTurnAuthor("parent", query)).toEqual(bob);
    expect(await resolveTurnAuthor("child", query)).toEqual(alice);
    expect(await resolveTurnAuthor("grandchild", query)).toEqual(alice); db.close();
  });
  it("inherits app delegation recursively and attributes schedules/webhooks to their owner", async () => {
    const { db, query, run } = fixture();
    run("a", "a", alice, {}, "completed"); run("b", "b"); run("c", "c");
    db.exec("INSERT INTO orchestration_v2_projection_subagents(child_thread_id,run_id,subagent_id) VALUES('b','a','delegate-a'),('c','b','delegate-b')");
    db.exec("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.delegatedTaskId','delegate-a') WHERE run_id='b'");
    db.exec("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.delegatedTaskId','delegate-b') WHERE run_id='c'");
    expect(await resolveTurnAuthor("c", query)).toEqual(alice);
    // Reusing a delegated thread for a later task must select that task's spawning run.
    run("bob-parent", "bob-parent", bob, {}, "completed");
    db.exec("INSERT INTO orchestration_v2_projection_subagents(child_thread_id,run_id,subagent_id) VALUES('c','bob-parent','delegate-c')");
    db.exec("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.delegatedTaskId','delegate-c') WHERE run_id='c'");
    expect(await resolveTurnAuthor("c", query)).toEqual(bob);
    run("task", "task", bob, { scheduledTaskId: "timer" });
    expect(await resolveTurnAuthor("task", query)).toEqual(bob);
    run("unattributed", "unattributed", undefined, { scheduledTaskId: "timer" });
    expect(await resolveTurnAuthor("unattributed", query)).toBeUndefined();
    db.exec("UPDATE orchestration_v2_projection_runs SET payload_json=json_remove(payload_json,'$.delegatedTaskId') WHERE run_id='c'");
    expect(await resolveTurnAuthor("c", query)).toBeUndefined();
    db.exec("INSERT INTO session_v2 VALUES('cycle','cycle',1)");
    expect(await resolveTurnAuthor("cycle", query)).toBeUndefined(); db.close();
  });
  it("uses a runless native child's active call on reuse, including nested children and joins", async () => {
    const { db, query, run } = fixture();
    run("a", "a", alice, {}, "completed"); run("b", "b", bob);
    db.prepare("INSERT INTO session_v2 VALUES(?,?,?)").run("child", "a", Date.parse("2026-10-25T00:00:01Z"));
    for (const id of ["child", "nested"]) db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?)").run(id, id, JSON.stringify({ nativeThreadRef: { nativeId: id } }));
    const call = db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?,?,?)");
    call.run("child", "a", "old", "child", "a", "provider_native", "completed", "2026-10-25T00:00:00Z");
    call.run("child", "b", "new", "child", "b", "provider_native", "running", "2026-10-25T00:01:00Z");
    call.run("nested", null, "nested", "nested", "child", "provider_native", "running", "2026-10-25T00:01:01Z");
    expect(await resolveTurnAuthor("child", query)).toEqual(bob);
    expect(await resolveTurnAuthor("nested", query)).toEqual(bob);
    call.run("child", "a", "joined", "child", "a", "provider_native", "running", "2026-10-25T00:02:00Z");
    expect(await resolveTurnAuthor("child", query)).toEqual(bob);
    db.exec("UPDATE orchestration_v2_projection_subagents SET status='completed'");
    expect(await resolveTurnAuthor("child", query)).toBeUndefined(); db.close();
  });
});

const server: SpacePlugins["servers"][number] = { pluginId: "test", serverId: "remote", name: "remote", displayName: "Test", listAs: "carol" };
const rpc = async (proxy: PluginMcpProxy, method: string, user = "alice", args = {}) => {
  const r = await proxy.handler(new Request("http://proxy/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "lookup", arguments: args, _meta: { "ai.opencode/sessionID": user } } }) }));
  return r.json() as Promise<Record<string, any>>;
};
function fakeVendor(seen: { url: string; method: string; auth: string | null; params: any }[], onCall?: () => Promise<void>) {
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url: String(url), method: body.method, auth: new Headers(init.headers).get("authorization"), params: body.params });
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } });
    await onCall?.();
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "found" }] } });
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("plugin proxy", () => {
  it("lists as the listing member, calls as each author with their own URL and headers, and never exposes them", async () => {
    const seen: Parameters<typeof fakeVendor>[0] = [];
    fakeVendor(seen);
    let allowed = true;
    const credential = vi.fn(async (id: string): Promise<PluginCredential> => allowed
      ? { ok: true, network: "public", transport: "streamable-http", url: `https://vendor.test/${id}/mcp`, headers: { Authorization: `Bearer secret-${id}` } }
      : { ok: false, error: "sign_in_required", message: "Sign in to Test in Settings → Plugins, then try again." });
    const proxy = new PluginMcpProxy(server, async id => id === "alice" ? alice : bob, credential);
    try {
      expect((await rpc(proxy, "tools/list")).result.tools.map((t: { name: string }) => t.name)).toEqual(["lookup"]);
      const a = await rpc(proxy, "tools/call"); const b = await rpc(proxy, "tools/call", "bob");
      expect([a.result.content[0].text, b.result.content[0].text]).toEqual(["found", "found"]);
      expect(credential.mock.calls.map(([id]) => id)).toEqual(["carol", "alice", "bob"]);
      expect(seen.filter(s => s.method === "tools/call").map(s => [s.url, s.auth])).toEqual([
        ["https://vendor.test/alice/mcp", "Bearer secret-alice"], ["https://vendor.test/bob/mcp", "Bearer secret-bob"]]);
      expect(seen.filter(s => s.method === "tools/call").every(s => s.params._meta === undefined)).toBe(true);
      expect(JSON.stringify([a, b])).not.toContain("secret-");
      await rpc(proxy, "tools/call");
      expect(seen.filter(s => s.method === "initialize")).toHaveLength(3);
      allowed = false;
      const refused = await rpc(proxy, "tools/call");
      expect(refused.result).toMatchObject({ isError: true, content: [{ text: "Sign in to Test in Settings → Plugins, then try again." }] });
      expect(seen.filter(s => s.method === "tools/call")).toHaveLength(3);
    } finally { await proxy.close(); }
  });
  it("opens a new client when a refreshed token changes the headers, and bounds idle clients", async () => {
    const seen: Parameters<typeof fakeVendor>[0] = [];
    fakeVendor(seen);
    let token = 0;
    const proxy = new PluginMcpProxy(server, async () => alice, async () => ({ ok: true, network: "public", transport: "streamable-http", url: "https://vendor.test/mcp", headers: { Authorization: `Bearer ${token}` } }));
    try {
      await rpc(proxy, "tools/call"); await rpc(proxy, "tools/call");
      expect(seen.filter(s => s.method === "initialize")).toHaveLength(1);
      for (token = 1; token <= 10; token++) await rpc(proxy, "tools/call");
      expect(seen.filter(s => s.method === "initialize")).toHaveLength(11);
      token = 0;
      await rpc(proxy, "tools/call");
      expect(seen.filter(s => s.method === "initialize")).toHaveLength(12);
    } finally { await proxy.close(); }
  });
  it("lists no tools until a member's connection works", async () => {
    const credential = vi.fn();
    const proxy = new PluginMcpProxy({ ...server, listAs: null }, async () => alice, credential);
    expect((await rpc(proxy, "tools/list")).result.tools).toEqual([]);
    expect(credential).not.toHaveBeenCalled();
  });
  it("refuses the in-isolate MCP host", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const proxy = new PluginMcpProxy(server, async () => alice, async () => ({ ok: true, network: "public", transport: "streamable-http", url: "https://baskule-mcp.internal/mcp", headers: {} }));
    expect((await rpc(proxy, "tools/call")).result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await proxy.close();
  });
  it("lets an in-flight call finish when another call renews the credential", async () => {
    let finish: (() => void) | undefined;
    let calls = 0;
    fakeVendor([], async () => { if (++calls === 1) await new Promise<void>(resolve => { finish = resolve; }); });
    let token = "first";
    const proxy = new PluginMcpProxy(server, async () => alice, async () => ({ ok: true, network: "public", transport: "streamable-http", url: "https://vendor.test/mcp", headers: { Authorization: token } }));
    const first = rpc(proxy, "tools/call");
    await vi.waitFor(() => expect(finish).toBeDefined());
    token = "second";
    expect((await rpc(proxy, "tools/call")).result.isError).not.toBe(true);
    finish!();
    expect((await first).result.isError).not.toBe(true);
    await proxy.close();
  });
  it("fails closed when no author is known", async () => {
    const credential = vi.fn();
    const proxy = new PluginMcpProxy(server, async () => undefined, credential);
    expect((await rpc(proxy, "tools/call")).result.isError).toBe(true); expect(credential).not.toHaveBeenCalled();
  });
});

const md = (text: string) => Buffer.from(text).toString("base64");
const skill = { path: "p/hello/SKILL.md", base64: md('---\nname: "hello"\ndescription: "Greeting: \\"hi\\""\nlicense: MIT\n---\nHello') };
describe("skill sync planning", () => {
  it("namespaces skills by plugin, keeps binary payloads and replaces the entire set", () => {
    const asset = { path: "p/hello/assets/data.bin", base64: Buffer.from([0, 1, 255]).toString("base64") };
    expect(planSkills([skill, { ...skill, path: "other/hello/SKILL.md" }, asset]).map(f => f.path)).toEqual(["other/hello/SKILL.md", "p/hello/assets/data.bin", "p/hello/SKILL.md"]);
    expect(planSkills([asset])[0]!.content).toBe(asset.base64);
    expect(planSkills([])).toEqual([]);
    expect(skillCatalog([skill, asset])).toEqual([{ id: "p/hello", name: "hello", description: 'Greeting: "hi"', content: "Hello", path: "/sandbox/space/plugins/p/hello/SKILL.md",
      files: ["/sandbox/space/plugins/p/hello/SKILL.md", "/sandbox/space/plugins/p/hello/assets/data.bin"] }]);
  });
  it.each(["../outside/x/SKILL.md", "/absolute/x/SKILL.md", "a/../../b", "a\\..\\b/c", "a//b/c", "plugin/SKILL.md"])("rejects unsafe paths: %s", path => {
    expect(() => planSkills([{ ...skill, path }])).toThrow("Invalid skill path");
  });
  it("rejects collisions", () => expect(() => planSkills([skill, skill])).toThrow("Duplicate skill path"));
});
