// In-isolate MCP servers for OpenCode: the bundled sample app (sample-app.ts) and the cached proxies of T3's own
// MCP server (t3-mcp.ts). OpenCode's remote MCP client uses globalThis.fetch, patched once per isolate to route the
// reserved host below to the registered handler, so these servers need no network hop and no live event.
const MCP_HOST = "baskule-mcp.internal";

type Handler = (req: Request) => Promise<Response>;
const handlers = new Map<string, Handler>();
let patched = false;

function patchFetch() {
  if (patched) return;
  patched = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === MCP_HOST) {
      const h = handlers.get(decodeURIComponent(url.pathname.split("/")[1] ?? ""));
      if (!h) return Promise.resolve(new Response("unknown MCP endpoint", { status: 404 }));
      return h(input instanceof Request ? new Request(input, init) : new Request(url, init));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

const mcpUrl = (key: string) => `http://${MCP_HOST}/${encodeURIComponent(key)}/mcp`;

export function registerLazyMcp(key: string, handler: Handler): string {
  patchFetch();
  handlers.set(key, handler);
  return mcpUrl(key);
}

export function unregisterLazyMcp(key: string) {
  handlers.delete(key);
}
