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
    CREATE TABLE session_v2(id TEXT,parent_id TEXT,time_created INTEGER);
    CREATE TABLE scheduled_tasks(task_id TEXT,author_json TEXT);`);
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
    expect(await resolveTurnAuthor("c", query)).toEqual(alice);
    // Reusing a delegated thread for a later task must select that task's spawning run.
    run("bob-parent", "bob-parent", bob, {}, "completed");
    db.exec("INSERT INTO orchestration_v2_projection_subagents(child_thread_id,run_id,subagent_id) VALUES('c','bob-parent','delegate-c')");
    db.exec("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.delegatedTaskId','delegate-c') WHERE run_id='c'");
    expect(await resolveTurnAuthor("c", query)).toEqual(bob);
    run("task", "task", undefined, { scheduledTaskId: "timer" });
    db.prepare("INSERT INTO scheduled_tasks VALUES(?,?)").run("timer", JSON.stringify(bob));
    expect(await resolveTurnAuthor("task", query)).toEqual(bob);
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

const server: SpacePlugins["servers"][number] = { pluginId: "test", pluginName: "Test", name: "remote", url: "https://vendor.test/mcp", credential: "user-oauth", catalogUserId: "alice", privateNetwork: false };
const rpc = async (proxy: PluginMcpProxy, method: string, user = "alice") => {
  const r = await proxy.handler(new Request("http://proxy/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "lookup", arguments: {}, _meta: { "ai.opencode/sessionID": user } } }) }));
  return r.json() as Promise<Record<string, any>>;
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("plugin proxy", () => {
  it("refuses the in-isolate MCP host even for admin private servers", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const proxy = new PluginMcpProxy({ ...server, url: "https://baskule-mcp.internal/mcp", privateNetwork: true }, async () => alice, async () => ({ headers: {}, expiresAt: Date.now() + 60_000 }));
    expect((await rpc(proxy, "tools/call")).result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await proxy.close();
  });
  it.each([false, true])("checks policy and calls the vendor with privateNetwork=%s", async privateNetwork => {
    const seen: { method: string; auth: string | null; params: any }[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ method: body.method, auth: new Headers(init.headers).get("authorization"), params: body.params });
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "found" }] } });
    });
    let allowed = true;
    const originalExpiry = Date.now() + 60_000;
    const credential = vi.fn(async (id: string): Promise<PluginCredential> => allowed ? { headers: { Authorization: `Bearer secret-${id}` }, expiresAt: Math.max(originalExpiry, Date.now() + 60_000) } : { error: "unavailable" });
    const proxy = new PluginMcpProxy({ ...server, privateNetwork, url: privateNetwork ? "http://127.0.0.1/mcp" : server.url }, async id => id === "alice" ? alice : bob, credential);
    await rpc(proxy, "tools/list");
    const a = await rpc(proxy, "tools/call"); const b = await rpc(proxy, "tools/call", "bob");
    expect(a.result._meta["baskule/account"]).toMatchObject({ userId: "alice" });
    expect(b.result.content[0].text).toContain("Bob");
    expect(seen.filter(s => s.method === "tools/call").map(s => s.auth)).toEqual(["Bearer secret-alice", "Bearer secret-bob"]);
    expect(seen.filter(s => s.method === "tools/call").every(s => s.params._meta === undefined)).toBe(true);
    expect(JSON.stringify([a, b])).not.toContain("secret-");
    expect(seen.filter(s => s.method === "initialize")).toHaveLength(2);
    vi.spyOn(Date, "now").mockReturnValue(originalExpiry + 60_000);
    await rpc(proxy, "tools/call");
    expect(seen.filter(s => s.method === "initialize")).toHaveLength(3);
    allowed = false;
    expect((await rpc(proxy, "tools/call")).result).toMatchObject({ isError: true });
    expect(credential).toHaveBeenCalledTimes(5);
    expect(seen.filter(s => s.method === "tools/call")).toHaveLength(3);
    await proxy.close();
  });
  it.each(["unavailable", "needs_setup", "connect", "reconnect"] as const)("returns a clear %s tool error without contacting the vendor", async error => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const proxy = new PluginMcpProxy(server, async () => alice, async () => ({ error }));
    const result = await rpc(proxy, "tools/call");
    expect(result.result.isError).toBe(true); expect(result.result.content[0].text).toMatch(/available|administrator|Connect|Reconnect/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("lets an in-flight call finish when another call renews an expired credential", async () => {
    let finish: (() => void) | undefined;
    let calls = 0;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
      if (++calls === 1) await new Promise<void>(resolve => { finish = resolve; });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "finished" }] } });
    });
    const proxy = new PluginMcpProxy(server, async () => alice, async () => ({ headers: { Authorization: "key" }, expiresAt: Date.now() + 1000 }));
    const first = rpc(proxy, "tools/call");
    await vi.waitFor(() => expect(finish).toBeDefined());
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);
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

const skill = { pluginId: "p", name: "hello", description: "Greeting", files: [{ path: "SKILL.md", encoding: "base64" as const, content: Buffer.from("---\nname: hello\n---\nHello").toString("base64") }] };
describe("skill sync planning", () => {
  it("namespaces duplicate names, preserves binary payloads and replaces the entire set", () => {
    expect(planSkills([skill, { ...skill, pluginId: "other" }]).map(f => f.path)).toEqual(["other/hello/SKILL.md", "p/hello/SKILL.md"]);
    expect(planSkills([])).toEqual([]);
    expect(skillCatalog([skill])[0]).toMatchObject({ id: "p/hello", content: "Hello", path: "/sandbox/space/plugins/p/hello/SKILL.md", files: ["/sandbox/space/plugins/p/hello/SKILL.md"] });
  });
  it.each(["../outside", "/absolute", "a/../../b", "a\\..\\b", "a//b"])("rejects unsafe paths: %s", path => {
    expect(() => planSkills([{ ...skill, files: [{ ...skill.files[0], path }] }])).toThrow("Invalid skill path");
  });
  it("rejects collisions", () => expect(() => planSkills([skill, skill])).toThrow("Duplicate skill path"));
});
