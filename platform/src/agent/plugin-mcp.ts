import type { Client } from "@modelcontextprotocol/client";
import type { PluginCredential, SpacePlugins } from "../../../app/packages/contracts/src/baskule-plugins";
import { connectMcp } from "../shared/plugin-outbound";
import type { TurnAuthor } from "./turn-author";

type Server = SpacePlugins["servers"][number];
type Connection = { headers: string; expiresAt: number; client: Promise<Client>; uses: number; retired: boolean };
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });

/** One in-isolate server, with separate upstream sessions for each account. Secrets stay in these closures. */
export class PluginMcpProxy {
  private clients = new Map<string, Connection>();
  private retired = new Set<Connection>();

  constructor(
    private server: Server,
    private author: (sessionId: string) => Promise<TurnAuthor | undefined>,
    private credential: (userId: string) => Promise<PluginCredential>,
  ) {}

  private connection(userId: string, credential: Extract<PluginCredential, { headers: unknown }>): Connection {
    const headers = JSON.stringify(credential.headers);
    let entry = this.clients.get(userId);
    if (entry && (entry.headers !== headers || entry.expiresAt <= Date.now())) {
      this.clients.delete(userId);
      entry.retired = true;
      this.retired.add(entry);
      this.release(entry, false);
      entry = undefined;
    }
    if (!entry) {
      const connecting = connectMcp(this.server, this.server.privateNetwork ? "private" : "public", credential.headers, 15_000).catch(() => {
        if (this.clients.get(userId) === entry) this.clients.delete(userId);
        throw new Error("Plugin server connection failed. Try again or contact your administrator.");
      });
      entry = { headers, expiresAt: credential.expiresAt, client: connecting, uses: 0, retired: false };
      this.clients.set(userId, entry);
    }
    entry.uses++;
    return entry;
  }

  private release(entry: Connection, used = true) {
    if (used) entry.uses--;
    if (entry.retired && entry.uses === 0) {
      this.retired.delete(entry);
      void entry.client.then(c => c.close()).catch(() => {});
    }
  }

  async close() {
    await Promise.all([...this.clients.values(), ...this.retired].map(e => e.client.then(c => c.close()).catch(() => {})));
    this.clients.clear();
    this.retired.clear();
  }

  readonly handler = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response(null, { status: req.method === "DELETE" ? 200 : 405 });
    const body = await req.json().catch(() => null) as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } } | null;
    if (!body?.method) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    const { id, method, params } = body;
    if (id === undefined) return new Response(null, { status: 202 });
    if (method === "initialize") return json(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "baskule-plugin", version: "0.4.0" } });
    if (method === "ping") return json(id, {});
    if (["resources/list", "resources/templates/list", "prompts/list"].includes(method)) return json(id, method === "prompts/list" ? { prompts: [] } : method === "resources/list" ? { resources: [] } : { resourceTemplates: [] });
    if (method !== "tools/list" && method !== "tools/call") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported plugin operation" } });
    const fail = (text: string) => method === "tools/call"
      ? json(id, { isError: true, content: [{ type: "text", text }] })
      : json(id, { tools: [] });
    let connection: Connection | undefined;
    try {
      const nativeId = params?._meta?.["ai.opencode/sessionID"];
      const author = method === "tools/call" && typeof nativeId === "string" ? await this.author(nativeId) : undefined;
      if (method === "tools/call" && !author) return fail("Plugin error: not_allowed. The turn author could not be resolved.");
      // Catalogs are the union visible to this space. Calls ALWAYS recheck the actual author's policy in ControlCell.
      const credential = await this.credential(author?.id ?? this.server.catalogUserId);
      if ("error" in credential) return fail(`Plugin error: ${credential.error}.${credential.connectUrl ? ` Connect or configure this plugin: ${credential.connectUrl}` : credential.error === "needs_connection" ? " Ask your administrator to configure this plugin." : " Check your plugin permissions and enabled state."}`);
      connection = this.connection(author?.id ?? this.server.catalogUserId, credential);
      const client = await connection.client;
      if (method === "tools/list") return json(id, await client.listTools(undefined, { timeout: 15_000 }));
      if (!params?.name) return fail("Plugin error: missing tool name.");
      const result = await client.callTool({ name: params.name, arguments: params.arguments ?? {} }, { timeout: 120_000, signal: req.signal });
      if (!this.server.personal) return json(id, result);
      return json(id, { ...result, content: [{ type: "text", text: `Account used: ${author!.name} (${author!.id}).` }, ...result.content],
        _meta: { ...result._meta, "baskule/account": { userId: author!.id, name: author!.name, pluginId: this.server.pluginId, server: this.server.name } } });
    } catch {
      // Transport exceptions may contain vendor response bodies, request headers or URLs with secrets.
      return fail("Plugin error: the remote server is unavailable or refused the request. Try again or contact your administrator.");
    } finally {
      if (connection) this.release(connection);
    }
  };
}
