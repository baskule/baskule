import { describe, expect, it, vi } from "vitest";
import { PluginMcpProxy } from "../../src/agent/plugin-mcp";
import { checkMcpUrl, checkOutbound } from "../../src/shared/plugin-outbound";

describe("plugin outbound addresses", () => {
  it("lists tools over the SSE transport selected by the source", async () => {
    const encoder = new TextEncoder();
    let events: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      events = controller;
      controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
    } });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "https://vendor.test/sse" && init?.method !== "POST")
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      if (String(input) !== "https://vendor.test/messages") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body));
      if (body.id !== undefined) {
        const result = body.method === "initialize"
          ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "vendor", version: "1" } }
          : { tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
        events.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`));
      }
      return new Response(null, { status: 202 });
    });
    const proxy = new PluginMcpProxy({ pluginId: "p", serverId: "s", name: "s", displayName: "Plugin", listAs: "member" },
      async () => undefined, async () => ({ ok: true, url: "https://vendor.test/sse", headers: {}, network: "public", transport: "sse" }));
    try {
      const response = await proxy.handler(new Request("https://proxy.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
      expect(await response.json()).toMatchObject({ result: { tools: [{ name: "lookup" }] } });
    } finally {
      await proxy.close();
      fetcher.mockRestore();
    }
  });

  it("keeps a public plugin from connecting to a private destination at runtime", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const proxy = new PluginMcpProxy({ pluginId: "p", serverId: "s", name: "s", displayName: "Plugin", listAs: "member" },
      async () => undefined, async () => ({ ok: true, url: "https://127.0.0.1/mcp", headers: {}, network: "public", transport: "streamable-http" }));
    try {
      const response = await proxy.handler(new Request("https://proxy.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
      expect(await response.json()).toMatchObject({ result: { tools: [] } });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
      fetcher.mockRestore();
    }
  });

  it.each(["0.1.2.3", "10.2.3.4", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.0.1", "192.0.0.1", "192.168.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "2130706433", "0x7f000001", "0177.0.0.1", "[64:ff9b::7f00:1]", "[::]", "[::1]", "[::ffff:127.0.0.1]", "[fc00::1]", "[fe80::1]", "[ff02::1]", "localhost", "localhost.", "host", "service.internal", "app.localhost"])("restricts private address %s to admin private traffic", host => {
    expect(() => checkOutbound(`https://${host}/mcp`, "public")).toThrow();
    expect(checkOutbound(`http://${host}/mcp`, "private").protocol).toBe("http:");
  });
  it.each(["https://baskule-mcp.internal/mcp", "http://baskule-mcp.internal./mcp", "https://user:pass@vendor.test/mcp", "https://vendor.test/mcp#fragment", "file:///tmp/mcp", "https://{tenant}.example.com/mcp", "https://vendor.test/{tenant}/mcp"])("always refuses %s", url => {
    for (const network of ["public", "private"] as const) expect(() => checkOutbound(url, network)).toThrow();
  });
  it("keeps query credentials out of stored MCP URLs while allowing OAuth queries", () => {
    expect(() => checkMcpUrl("https://vendor.test/mcp?api_key=secret", "public")).toThrow();
    expect(checkOutbound("https://vendor.test/authorize?client=public", "public").search).toBe("?client=public");
  });
  it("allows public HTTPS, including global v6 and mapped v4, and refuses public HTTP", () => {
    for (const host of ["vendor.test", "8.8.8.8", "192.0.5.1", "192.2.0.1", "[2606:4700:4700::1111]", "[::ffff:8.8.8.8]"]) {
      expect(checkOutbound(`https://${host}/mcp`, "public").protocol).toBe("https:");
      expect(() => checkOutbound(`http://${host}/mcp`, "private")).toThrow();
    }
  });
});
