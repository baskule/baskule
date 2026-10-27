// T3's per-chat MCP server (its agent tools and the shared browser's preview_* tools), proxied in-process with a static
// tool list (0.2.1, latency).
//
// T3 adds its server to a chat's OpenCode location before each turn (`PUT /api/experimental/mcp/t3-code-…`, see
// index.ts mcpRoute). Connecting OpenCode straight to it costs an MCP handshake over the space bridge (initialize,
// tools/list, … to the SpaceCell) on every new chat, and the first model step must wait for it. The tool list is the
// same for every chat of a space (T3 registers the tools its policy allows, rpcPolicy.ts), so this proxy answers
// initialize and the list methods from a cache (memory, then DO storage), and opens the upstream MCP session lazily,
// on the first call that needs T3 (a tool call, a resource read). That first upstream handshake also refreshes the
// cache, so a T3 upgrade reaches the next chats. Without a cache (the space's first chat ever) it goes upstream.
type Handler = (req: Request) => Promise<Response>;
type Json = Record<string, any>;

/** The list results cached per space, by method (params-less calls only). */
const CACHED = new Set(["initialize", "tools/list", "resources/list", "resources/templates/list", "prompts/list"]);

export interface T3McpCache {
  get(): Json | undefined;
  set(value: Json): void;
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

/** Reads a JSON-RPC answer from a Streamable-HTTP response (JSON body or SSE events). */
async function readAnswer(res: Response, id: unknown): Promise<Json | null> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text) return null;
  if (!type.includes("text/event-stream")) return JSON.parse(text);
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const m = JSON.parse(data);
    if (m.id === id) return m;
  }
  return null;
}

export class T3McpProxy {
  private upstream: { url: string; headers: Record<string, string> };
  private session: Promise<string | null> | null = null;
  private nextId = 1;

  constructor(
    config: { url: string; headers?: Record<string, string> },
    private readonly cache: T3McpCache,
    private readonly log: (l: string) => void = () => {},
  ) {
    this.upstream = { url: config.url, headers: config.headers ?? {} };
  }

  /** T3 re-adds its server with a fresh credential: keep OpenCode's connection, renew the upstream session. */
  update(config: { url: string; headers?: Record<string, string> }) {
    const next = { url: config.url, headers: config.headers ?? {} };
    if (JSON.stringify(next) === JSON.stringify(this.upstream)) return;
    this.upstream = next;
    this.session = null;
  }

  private post(body: Json, sessionId: string | null) {
    return fetch(this.upstream.url, {
      method: "POST",
      headers: {
        ...this.upstream.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** The upstream MCP session, opened on first use; its handshake refreshes the cached lists. */
  private open(): Promise<string | null> {
    this.session ??= (async () => {
      const t0 = Date.now();
      const id = `os-${this.nextId++}`;
      const res = await this.post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "baskule-agent", version: "0.2.1" } } }, null);
      const init = await readAnswer(res, id);
      if (!res.ok || !init?.result) throw new Error(`T3 MCP initialize answered ${res.status}`);
      const sessionId = res.headers.get("mcp-session-id");
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).then((r) => r.body?.cancel());
      const fresh: Json = { initialize: init.result };
      const tools = await this.forward({ jsonrpc: "2.0", id: `os-${this.nextId++}`, method: "tools/list" }, sessionId);
      if (tools?.result) fresh["tools/list"] = tools.result;
      this.cache.set({ ...this.cache.get(), ...fresh });
      this.log(`T3 MCP session opened in ${Date.now() - t0} ms`);
      return sessionId;
    })();
    this.session.catch(() => (this.session = null));
    return this.session;
  }

  private async forward(body: Json, sessionId: string | null): Promise<Json | null> {
    return readAnswer(await this.post(body, sessionId), body.id);
  }

  /** Upstream call, reopening the session once if T3 forgot it (cell restart: 404). */
  private async call(body: Json): Promise<Json | null> {
    let sessionId = await this.open();
    let res = await this.post(body, sessionId);
    if (res.status === 404 || res.status === 400) {
      await res.body?.cancel();
      this.session = null;
      sessionId = await this.open();
      res = await this.post(body, sessionId);
    }
    if (!res.ok) throw new Error(`T3 MCP answered ${res.status}`);
    return readAnswer(res, body.id);
  }

  readonly handler: Handler = async (req) => {
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    let body: Json;
    try {
      body = (await req.json()) as Json;
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const { id, method } = body;
    if (id === undefined || id === null) return new Response(null, { status: 202 }); // notifications stay local
    if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
    const cached = CACHED.has(method) && !body.params?.cursor ? this.cache.get()?.[method] : undefined;
    if (cached) {
      const result = method === "initialize" ? { ...cached, protocolVersion: body.params?.protocolVersion ?? cached.protocolVersion } : cached;
      return json({ jsonrpc: "2.0", id, result }, method === "initialize" ? { "mcp-session-id": crypto.randomUUID() } : {});
    }
    try {
      if (method === "initialize" || method === "tools/list") {
        await this.open(); // no cache yet: the handshake fills it
        const filled = this.cache.get()?.[method];
        if (filled) return json({ jsonrpc: "2.0", id, result: method === "initialize" ? { ...filled, protocolVersion: body.params?.protocolVersion ?? filled.protocolVersion } : filled }, method === "initialize" ? { "mcp-session-id": crypto.randomUUID() } : {});
      }
      const answer = await this.call(body);
      if (!answer) return json({ jsonrpc: "2.0", id, error: { code: -32603, message: "no answer from T3" } });
      if (CACHED.has(method) && answer.result && !body.params?.cursor) this.cache.set({ ...this.cache.get(), [method]: answer.result });
      return json(answer);
    } catch (e) {
      this.log(`T3 MCP ${method} failed: ${(e as Error)?.message ?? e}`);
      if (method === "tools/call") return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Tool error: ${(e as Error)?.message ?? e}` }], isError: true } });
      return json({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error)?.message ?? e) } });
    }
  };
}
