import { afterEach, describe, expect, it, vi } from "vitest";
import { T3McpProxy } from "../../t3-mcp";

const UPSTREAM = "http://baskule-space.internal/s1/mcp";
const TOOLS = { tools: [{ name: "preview_open", inputSchema: { type: "object" } }] };

/** A fake T3 MCP endpoint: records methods, answers initialize/tools/list/tools/call (tools/call as SSE). */
function fakeT3() {
  const seen: { method: string; session: string | null; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    const body = JSON.parse(String(init.body));
    seen.push({ method: body.method, session: h.get("mcp-session-id"), auth: h.get("authorization") });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t3" } } }, { headers: { "mcp-session-id": "up-1" } });
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: TOOLS });
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  return seen;
}
const rpc = (proxy: T3McpProxy, method: string, params?: unknown, id: number | null = 1): Promise<any> =>
  proxy.handler(new Request("http://baskule-mcp.internal/k/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).then((r) => (r.status === 202 ? null : r.json()));
const memoryCache = (v?: Record<string, any>) => ({ v, get() { return this.v; }, set(n: Record<string, any>) { this.v = n; } });

afterEach(() => vi.unstubAllGlobals());

describe("T3 MCP proxy (static tool list, lazy upstream)", () => {
  it("answers initialize and tools/list from the cache without contacting T3", async () => {
    const seen = fakeT3();
    const proxy = new T3McpProxy({ url: UPSTREAM, headers: { Authorization: "Bearer a" } }, memoryCache({ initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }, "tools/list": TOOLS }));
    expect((await rpc(proxy, "initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion).toBe("2025-03-26");
    expect(await rpc(proxy, "notifications/initialized", undefined, null)).toBeNull();
    expect((await rpc(proxy, "tools/list")).result).toEqual(TOOLS);
    expect(seen).toEqual([]);
  });

  it("opens the upstream session on the first tool call, with the credential, and refreshes the cache", async () => {
    const seen = fakeT3();
    const cache = memoryCache({ "tools/list": { tools: [] }, initialize: { capabilities: {} } });
    const proxy = new T3McpProxy({ url: UPSTREAM, headers: { Authorization: "Bearer a" } }, cache);
    const r = await rpc(proxy, "tools/call", { name: "preview_open", arguments: {} }, 7);
    expect(r).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ok" }] } });
    expect(seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(seen.at(-1)).toMatchObject({ session: "up-1", auth: "Bearer a" });
    expect(cache.v!["tools/list"]).toEqual(TOOLS);
    await rpc(proxy, "tools/call", { name: "preview_open" }, 8);
    expect(seen.filter((s) => s.method === "initialize")).toHaveLength(1);
  });

  it("goes upstream when nothing is cached yet, and renews the session when T3 re-adds with a new credential", async () => {
    const seen = fakeT3();
    const cache = memoryCache();
    const proxy = new T3McpProxy({ url: UPSTREAM, headers: { Authorization: "Bearer a" } }, cache);
    expect((await rpc(proxy, "tools/list")).result).toEqual(TOOLS);
    proxy.update({ url: UPSTREAM, headers: { Authorization: "Bearer b" } });
    await rpc(proxy, "tools/call", { name: "preview_open" });
    expect(seen.filter((s) => s.method === "initialize").map((s) => s.auth)).toEqual(["Bearer a", "Bearer b"]);
  });
});
