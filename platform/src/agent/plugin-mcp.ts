import type { Client } from "@modelcontextprotocol/client";
import type { PluginCallError, PluginCredential, SpacePlugins } from "../../../app/packages/contracts/src/baskule-plugins";
import { connectMcp, serverFingerprint } from "../shared/plugin-outbound";
import type { TurnAuthor } from "./turn-author";

type Server = SpacePlugins["servers"][number];
type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type Connection = { key: string; headers: string; expiresAt: number; client: Promise<Client>; uses: number; retired: boolean };
const MAX_IDLE_CLIENTS = 8;
export const ACCOUNT_ARG = "baskule_account";
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });

export function publishTools(server: Server, tools: Tool[]): Tool[] {
  if (server.credential !== "user-oauth") return tools;
  return tools.filter(tool => !Object.hasOwn(tool.inputSchema.properties ?? {}, ACCOUNT_ARG) && !tool.inputSchema.required?.includes(ACCOUNT_ARG)).map(tool => server.defaultAccountOnly ? tool : {
    ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, [ACCOUNT_ARG]: {
      type: "string", description: "Which of your connected accounts to use, by its name. Leave it out to use your default account.",
    } } },
  });
}
export function takeAccount(args: Record<string, unknown> | undefined): { account?: string; args: Record<string, unknown> } {
  const { [ACCOUNT_ARG]: account, ...rest } = args ?? {};
  if (account === undefined) return { args: rest };
  if (typeof account !== "string" || !account.trim() || account.trim().length > 100) throw new Error("Choose an account by its name.");
  return { account: account.trim(), args: rest };
}
export function labelled(result: ToolResult, account: { id: string; label: string } | undefined, server: Server): ToolResult {
  if (!account) return result;
  return { ...result, content: [{ type: "text", text: `Account used: ${account.label}.` }, ...result.content],
    _meta: { ...result._meta, "baskule/account": { connectionId: account.id, label: account.label, pluginId: server.pluginId, server: server.name } } };
}

export class PluginMcpProxy {
  private clients = new Map<string, Connection>();
  private retired = new Set<Connection>();

  constructor(
    private server: Server,
    private author: (sessionId: string) => Promise<TurnAuthor | undefined>,
    private credential: (userId: string, call: { account?: string; tool?: string }) => Promise<PluginCredential>,
  ) {}

  private retire(entry: Connection) {
    this.clients.delete(entry.key);
    entry.retired = true;
    this.retired.add(entry);
    this.release(entry, false);
  }
  private connection(userId: string, credential: Extract<PluginCredential, { headers: unknown }>): Connection {
    const key = JSON.stringify([userId, credential.account?.id ?? "", serverFingerprint(this.server)]);
    const headers = JSON.stringify(credential.headers);
    let entry = this.clients.get(key);
    if (entry && (entry.headers !== headers || entry.expiresAt <= Date.now())) {
      this.retire(entry);
      entry = undefined;
    }
    if (!entry) {
      const connecting = connectMcp(this.server, this.server.privateNetwork ? "private" : "public", credential.headers, 15_000).catch(() => {
        if (this.clients.get(key) === entry) this.clients.delete(key);
        throw new Error("Plugin server connection failed. Try again or contact your administrator.");
      });
      entry = { key, headers, expiresAt: credential.expiresAt, client: connecting, uses: 0, retired: false };
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
      for (const [index, client] of idle.entries()) {
        if (client.expiresAt <= Date.now() || index < idle.length - MAX_IDLE_CLIENTS) this.retire(client);
      }
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
    if (method === "initialize") return json(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "baskule-plugin", version: "0.4.0" } });
    if (method === "ping") return json(id, {});
    if (["resources/list", "resources/templates/list", "prompts/list"].includes(method)) return json(id, method === "prompts/list" ? { prompts: [] } : method === "resources/list" ? { resources: [] } : { resourceTemplates: [] });
    if (method !== "tools/list" && method !== "tools/call") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported plugin operation" } });
    const fail = (text: string) => method === "tools/call"
      ? json(id, { isError: true, content: [{ type: "text", text }] })
      : json(id, { tools: [] });
    let account: string | undefined;
    let args = params?.arguments ?? {};
    if (method === "tools/call" && this.server.credential === "user-oauth") {
      try { ({ account, args } = takeAccount(params?.arguments)); }
      catch { return fail("Choose an account by its name."); }
    }
    let connection: Connection | undefined;
    try {
      const nativeId = params?._meta?.["ai.opencode/sessionID"];
      const author = method === "tools/call" && typeof nativeId === "string" ? await this.author(nativeId) : undefined;
      if (method === "tools/call" && !author) return fail("This plugin is not available to you here.");
      const credential = await this.credential(author?.id ?? this.server.catalogUserId, { ...(account === undefined ? {} : { account }), ...(params?.name ? { tool: params.name } : {}) });
      if ("error" in credential) return fail(callErrorText(credential.error, this.server.pluginName, credential.accounts));
      connection = this.connection(author?.id ?? this.server.catalogUserId, credential);
      const client = await connection.client;
      if (method === "tools/list") {
        const listed = await client.listTools(undefined, { timeout: 15_000 });
        return json(id, { ...listed, tools: publishTools(this.server, listed.tools) });
      }
      if (!params?.name) return fail("Plugin error: missing tool name.");
      const result = await client.callTool({ name: params.name, arguments: args }, { timeout: 120_000, signal: req.signal });
      return json(id, labelled(result, credential.account, this.server));
    } catch {
      // Transport exceptions can contain vendor bodies, headers or URLs with secrets.
      return fail("Plugin error: the remote server is unavailable or refused the request. Try again or contact your administrator.");
    } finally {
      if (connection) this.release(connection);
    }
  };
}

export function callErrorText(error: PluginCallError, name: string, accounts?: string[]): string {
  switch (error) {
    case "unavailable": return "This plugin is not available to you here.";
    case "needs_setup": return `Your administrator needs to finish setting up ${name}.`;
    case "connect": return `Connect your ${name} account in Settings → Plugins, then try again.`;
    case "reconnect": return `Reconnect your ${name} account in Settings → Plugins, then try again.`;
    case "unknown_account": return `Choose one of your ${name} accounts: ${(accounts ?? []).join(", ")}.`;
    case "default_account_required": return "Team spaces use only your default account. Choose it in Settings → Plugins, then try again.";
  }
}
