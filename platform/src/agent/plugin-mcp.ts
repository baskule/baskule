import type { Client } from "@modelcontextprotocol/client";
import type { PluginCredential, SpacePlugins } from "../../../app/packages/contracts/src/baskule-plugins";
import { connectMcp } from "../shared/plugin-outbound";
import type { TurnAuthor } from "./turn-author";

type Server = SpacePlugins["servers"][number];
type Connection = { key: string; client: Promise<Client>; uses: number; retired: boolean };
const MAX_IDLE_CLIENTS = 8;
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });

/** One remote MCP server for the agent. ControlCell decides every call and returns the author's own URL and headers. */
export class PluginMcpProxy {
  private clients = new Map<string, Connection>();
  private retired = new Set<Connection>();

  constructor(
    private server: Server,
    private author: (sessionId: string) => Promise<TurnAuthor | undefined>,
    private credential: (userId: string) => Promise<PluginCredential>,
  ) {}

  private retire(entry: Connection) {
    this.clients.delete(entry.key);
    entry.retired = true;
    this.retired.add(entry);
    this.release(entry, false);
  }
  /** Keyed by the exact URL and headers: a refreshed token or another member's account opens its own client. */
  private connection(userId: string, credential: Extract<PluginCredential, { ok: true }>): Connection {
    const key = JSON.stringify([userId, credential.url, credential.headers, credential.network, credential.transport]);
    let entry = this.clients.get(key);
    if (!entry) {
      const connecting = connectMcp(credential, credential.network, credential.headers, 15_000).catch(() => {
        if (this.clients.get(key) === entry) this.clients.delete(key);
        throw new Error("Plugin server connection failed. Try again or contact your administrator.");
      });
      entry = { key, client: connecting, uses: 0, retired: false };
      this.clients.set(key, entry);
    }
    entry.uses++;
    return entry;
  }
  private release(entry: Connection, used = true) {
    if (used) entry.uses--;
    if (entry.retired && entry.uses === 0) {
      this.retired.delete(entry);
      void entry.client.then(c => c.close()).catch(() => {});
    } else if (!entry.retired && entry.uses === 0 && this.clients.get(entry.key) === entry) {
      this.clients.delete(entry.key);
      this.clients.set(entry.key, entry);
      const idle = [...this.clients.values()].filter(client => client.uses === 0);
      for (const [index, client] of idle.entries()) if (index < idle.length - MAX_IDLE_CLIENTS) this.retire(client);
    }
  }
  async close() {
    await Promise.all([...this.clients.values(), ...this.retired].map(entry => entry.client.then(c => c.close()).catch(() => {})));
    this.clients.clear();
    this.retired.clear();
  }

  readonly handler = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response(null, { status: req.method === "DELETE" ? 200 : 405 });
    const body = await req.json().catch(() => null) as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } } | null;
    if (!body?.method) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    const { id, method, params } = body;
    if (id === undefined) return new Response(null, { status: 202 });
    if (method === "initialize") return json(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "baskule-plugin", version: "0.6.0" } });
    if (method === "ping") return json(id, {});
    if (["resources/list", "resources/templates/list", "prompts/list"].includes(method)) return json(id, method === "prompts/list" ? { prompts: [] } : method === "resources/list" ? { resources: [] } : { resourceTemplates: [] });
    if (method !== "tools/list" && method !== "tools/call") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported plugin operation" } });
    const fail = (text: string) => method === "tools/call" ? json(id, { isError: true, content: [{ type: "text", text }] }) : json(id, { tools: [] });
    let connection: Connection | undefined;
    try {
      // Discovery runs as a member whose connection works; calls always run as the turn's author.
      const nativeId = params?._meta?.["ai.opencode/sessionID"];
      const userId = method === "tools/call" ? typeof nativeId === "string" ? (await this.author(nativeId))?.id : undefined : this.server.listAs ?? undefined;
      if (!userId) return fail("This plugin is not available to you here.");
      const credential = await this.credential(userId);
      if (!credential.ok) return fail(credential.message);
      connection = this.connection(userId, credential);
      const client = await connection.client;
      if (method === "tools/list") return json(id, await client.listTools(undefined, { timeout: 15_000 }));
      if (!params?.name) return fail("Plugin error: missing tool name.");
      return json(id, await client.callTool({ name: params.name, arguments: params.arguments ?? {} }, { timeout: 120_000, signal: req.signal }));
    } catch {
      // Transport exceptions can contain vendor bodies, headers or URLs with secrets.
      return fail(`${this.server.displayName} is unavailable or refused the request. Try again or contact your administrator.`);
    } finally {
      if (connection) this.release(connection);
    }
  };
}
