// The agent's way back to its own space (WP-F): T3 (in the SpaceCell) offers its agent tools (delegation, other chats,
// scheduled work, secret requests, inline HTML, the shared browser) as an MCP server, and adds it to the space's OpenCode sessions with the URL
// `http://baskule-space.internal/<spaceId>/mcp` (fork: BASKULE_MCP_ENDPOINT). OpenCode's remote MCP client uses
// globalThis.fetch: this module routes that reserved host to the SpaceCell of the same space through its DO stub
// (no network hop, nothing listens). Only the MCP endpoints are forwarded; no identity header is set (T3 checks its own
// per-thread bearer token, and the Worker never forwards client requests here). T3 registers only the tools its policy
// allows (fork: BASKULE_ALLOWED_MCP_TOOLS).
export const SPACE_HOST = "baskule-space.internal";
/** Paths of the SpaceCell the agent may reach: T3's MCP server and the bundled MCP apps. */
const FORWARDED = /^\/(mcp|baskule-apps\/[a-z0-9-]+\/mcp)$/;

type Forward = (req: Request) => Promise<Response>;
const spaces = new Map<string, Forward>();
let patched = false;

function patchFetch() {
  if (patched) return;
  patched = true;
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== SPACE_HOST) return previous(input as RequestInfo, init);
    const [, spaceId = "", ...rest] = url.pathname.split("/");
    const path = `/${rest.join("/")}`;
    const forward = spaces.get(decodeURIComponent(spaceId));
    if (!forward || !FORWARDED.test(path)) return Promise.resolve(new Response("not found", { status: 404 }));
    const req = input instanceof Request ? new Request(input, init) : new Request(url, init);
    return forward(new Request(new URL(path + url.search, "http://space"), req));
  }) as typeof fetch;
}

export const spaceMcpUrl = (spaceId: string, path = "/mcp") => `http://${SPACE_HOST}/${encodeURIComponent(spaceId)}${path}`;

/** Registers this isolate's route from `spaceId`'s OpenCode to `spaceId`'s SpaceCell. */
export function registerSpaceBridge(spaceId: string, space: { fetch(req: Request): Promise<Response> }) {
  patchFetch();
  spaces.set(spaceId, (req) => {
    const headers = new Headers(req.headers);
    for (const h of [...headers.keys()]) if (h.startsWith("x-baskule-")) headers.delete(h);
    headers.set("x-baskule-base", `/s/${spaceId}`);
    return space.fetch(new Request(req.url, { method: req.method, headers, body: req.body, redirect: "manual" })).then(
      (res) => {
        if (res.status >= 500 || res.status === 401) console.warn(`[space-bridge ${spaceId}] ${req.method} ${new URL(req.url).pathname} → ${res.status}`);
        return res;
      },
      (e) => {
        console.warn(`[space-bridge ${spaceId}] ${req.method} ${new URL(req.url).pathname} failed: ${e}`);
        throw e;
      },
    );
  });
}

export function unregisterSpaceBridge(spaceId: string) {
  spaces.delete(spaceId);
}
