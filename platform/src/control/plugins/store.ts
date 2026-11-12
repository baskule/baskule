import type { AdminPlugin, AdminServer, OAuthClientSetup, PluginAccess, PluginFile, ProviderId, ProviderInput, ProviderSettings, ServerSetup } from "../../../../app/packages/contracts/src/baskule-plugins";
import type { ConnectionCipher } from "../connection-crypto";
import type { StorageLike } from "../service";
import { Composio, Pipedream, type Provider } from "./providers";
import { pluginStatus, serverSetup, type ConnectionRow, type SetupFacts, type StoredPlugin, type StoredServer } from "./state";
import type { Fetcher } from "./fetch";
import type { EntryRef } from "./catalog";

export interface PluginRow { id: string; def: StoredPlugin; enabled: boolean; everyone: boolean; installedAt: number; installedBy: string | null }
export interface OAuthClientRecord { clientId: string; clientSecret?: string; scopes?: string; authorizationParams?: string }
type Row = Record<string, unknown>;

export const CALLBACK_PATH = "/api/baskule/plugins/oauth/callback";
export const PROVIDER_CALLBACK_PATH = "/api/baskule/plugins/provider/callback";
const ctx = (...parts: string[]) => JSON.stringify(parts);

/** The identity an installed plugin has; a second install from the same place is refused. */
export function originKey(ref: EntryRef | StoredPlugin["origin"]): string {
  if ("kind" in ref) {
    if (ref.kind === "custom") return "";
    if (ref.kind === "provider") return `${ref.provider}:${ref.app}`;
    return `github:${ref.repo.replace(/^https:\/\/github\.com\//, "").toLowerCase()}#${ref.path ?? ""}`;
  }
  return "provider" in ref ? `${ref.provider}:${ref.app}` : `github:${ref.repo.toLowerCase()}#${ref.path ?? ""}`;
}

export class PluginStore {
  private clients = new Map<string, Provider>();
  constructor(readonly storage: StorageLike, readonly cipher: ConnectionCipher, readonly fetcher: Fetcher) {}
  rows(q: string, ...p: unknown[]): Row[] { return this.storage.sql.exec(q, ...p).toArray(); }

  private plugin(row: Row): PluginRow {
    return { id: row.id as string, def: JSON.parse(row.definition as string), enabled: !!row.enabled, everyone: !!row.access_everyone,
      installedAt: Number(row.installed_at), installedBy: (row.installed_by as string | null) ?? null };
  }
  list(): PluginRow[] { return this.rows("select id,definition,enabled,access_everyone,installed_at,installed_by from plugin order by id").map(r => this.plugin(r)); }
  get(id: string): PluginRow | undefined {
    const row = this.rows("select id,definition,enabled,access_everyone,installed_at,installed_by from plugin where id=?", id)[0];
    return row ? this.plugin(row) : undefined;
  }
  skillFiles(id: string): PluginFile[] { return JSON.parse((this.rows("select skill_files from plugin where id=?", id)[0]?.skill_files as string | undefined) ?? "[]"); }
  saveDefinition(id: string, def: StoredPlugin) { this.rows("update plugin set definition=? where id=?", JSON.stringify(def), id); }

  groups(id: string): string[] { return this.rows("select group_id from group_plugin where plugin_id=? order by group_id", id).map(r => r.group_id as string); }
  access(plugin: PluginRow): PluginAccess { return plugin.everyone ? { kind: "everyone" } : { kind: "groups", groups: this.groups(plugin.id) }; }
  hasAccess(userId: string, plugin: PluginRow): boolean {
    return plugin.everyone || !!this.rows(`select 1 from group_plugin gp join permission_group g on g.id=gp.group_id where gp.plugin_id=? and
      (g.builtin='everyone' or exists(select 1 from group_member m where m.group_id=g.id and m.user_id=?)) limit 1`, plugin.id, userId).length;
  }
  isOn(userId: string, pluginId: string): boolean {
    const row = this.rows("select \"on\" as value from member_plugin where user_id=? and plugin_id=?", userId, pluginId)[0];
    return row ? !!row.value : true;
  }

  async values(pluginId: string, serverId: string): Promise<Record<string, string>> {
    const row = this.rows("select data from plugin_value where plugin_id=? and server_id=?", pluginId, serverId)[0];
    return row ? this.cipher.open<Record<string, string>>(row.data as string, ctx("plugin-value", pluginId, serverId)) : {};
  }
  async sealValues(pluginId: string, serverId: string, values: Record<string, string>): Promise<string> {
    return this.cipher.seal(values, ctx("plugin-value", pluginId, serverId));
  }

  async oauthClient(issuer: string): Promise<OAuthClientRecord | undefined> {
    const row = this.rows("select data from oauth_client where issuer=?", issuer)[0];
    return row ? this.cipher.open<OAuthClientRecord>(row.data as string, ctx("oauth-client", issuer)) : undefined;
  }
  sealOAuthClient(issuer: string, client: OAuthClientRecord) { return this.cipher.seal(client, ctx("oauth-client", issuer)); }
  issuers(): string[] { return this.rows("select issuer from oauth_client order by issuer").map(r => r.issuer as string); }

  async providerInput(provider: ProviderId): Promise<ProviderInput | undefined> {
    const row = this.rows("select data from plugin_provider where provider=?", provider)[0];
    return row ? this.cipher.open<ProviderInput>(row.data as string, ctx("plugin-provider", provider)) : undefined;
  }
  sealProvider(input: ProviderInput) { return this.cipher.seal(input, ctx("plugin-provider", input.provider)); }
  configuredProviders(): Set<ProviderId> { return new Set(this.rows("select provider from plugin_provider").map(r => r.provider as ProviderId)); }

  /** One client per stored configuration, so a cached access token never outlives its credentials. */
  async provider(provider: ProviderId): Promise<Provider | undefined> {
    const row = this.rows("select data from plugin_provider where provider=?", provider)[0];
    if (!row) return undefined;
    const key = `${provider}:${row.data}`;
    let client = this.clients.get(key);
    if (!client) {
      const input = await this.cipher.open<ProviderInput>(row.data as string, ctx("plugin-provider", provider));
      client = this.client(input);
      for (const existing of this.clients.keys()) if (existing.startsWith(`${provider}:`)) this.clients.delete(existing);
      this.clients.set(key, client);
    }
    return client;
  }
  client(input: ProviderInput): Provider {
    const identity = (user: string) => this.cipher.identity(`${input.provider}:${user}`);
    return input.provider === "composio" ? new Composio(input, identity, this.fetcher) : new Pipedream(input, identity, this.fetcher);
  }

  async providerSettings(): Promise<ProviderSettings> {
    const pipedream = await this.providerInput("pipedream");
    return { composio: { configured: this.configuredProviders().has("composio") },
      pipedream: pipedream?.provider === "pipedream" ? { configured: true, projectId: pipedream.projectId, environment: pipedream.environment } : { configured: false, projectId: null, environment: null } };
  }

  async facts(): Promise<SetupFacts & { valuesBy: Map<string, Set<string>> }> {
    const valuesBy = new Map<string, Set<string>>();
    for (const row of this.rows("select plugin_id,server_id,data from plugin_value")) {
      const values = await this.cipher.open<Record<string, string>>(row.data as string, ctx("plugin-value", row.plugin_id as string, row.server_id as string));
      valuesBy.set(`${row.plugin_id}/${row.server_id}`, new Set(Object.keys(values).filter(k => values[k] !== "")));
    }
    return { valuesBy, values: new Set(), clients: new Set(this.issuers()), providers: this.configuredProviders() };
  }
  setup(plugin: PluginRow, server: StoredServer, facts: Awaited<ReturnType<PluginStore["facts"]>>): ServerSetup {
    return serverSetup(server, { ...facts, values: facts.valuesBy.get(`${plugin.id}/${server.id}`) ?? new Set() });
  }
  ready(plugin: PluginRow, facts: Awaited<ReturnType<PluginStore["facts"]>>): boolean {
    return plugin.def.servers.every(server => this.setup(plugin, server, facts).state === "ready");
  }

  connection(userId: string, pluginId: string, serverId: string): (ConnectionRow & { data: string }) | undefined {
    const row = this.rows("select data,account,connected_at,state from plugin_connection where user_id=? and plugin_id=? and server_id=?", userId, pluginId, serverId)[0];
    return row ? { data: row.data as string, account: (row.account as string | null) ?? null, connectedAt: Number(row.connected_at), state: row.state as ConnectionRow["state"] } : undefined;
  }
  connectionContext = (userId: string, pluginId: string, serverId: string) => ctx("plugin-connection", userId, pluginId, serverId);

  adminPlugin(plugin: PluginRow, facts: Awaited<ReturnType<PluginStore["facts"]>>): AdminPlugin {
    const counts = new Map(this.rows("select server_id,count(*) as n from plugin_connection where plugin_id=? and state='connected' group by server_id", plugin.id)
      .map(r => [r.server_id as string, Number(r.n)]));
    const servers: AdminServer[] = plugin.def.servers.map(server => {
      const set = facts.valuesBy.get(`${plugin.id}/${server.id}`) ?? new Set();
      return { id: server.id, name: server.name, url: server.url, auth: server.auth, variables: server.variables.map(v => ({ ...v, set: set.has(v.name) })),
        setup: this.setup(plugin, server, facts), connectedMembers: counts.get(server.id) ?? 0 };
    });
    const { def } = plugin;
    return { id: plugin.id, name: def.name, displayName: def.displayName, description: def.description, logo: def.logo, homepage: def.homepage, category: def.category,
      origin: def.origin, enabled: plugin.enabled, access: this.access(plugin), servers, skills: def.skills,
      installedAt: new Date(plugin.installedAt).toISOString(), installedBy: plugin.installedBy, status: pluginStatus(plugin.enabled, servers.map(s => s.setup)) };
  }

  async oauthClients(origin: string): Promise<OAuthClientSetup[]> {
    const plugins = this.list();
    const issuers = new Set(this.issuers());
    for (const plugin of plugins) for (const server of plugin.def.servers)
      if (server.auth.kind === "oauth" && server.auth.issuer && server.auth.registration === "client") issuers.add(server.auth.issuer);
    return Promise.all([...issuers].sort().map(async issuer => {
      const client = await this.oauthClient(issuer);
      const users = plugins.filter(p => p.def.servers.some(s => s.auth.kind === "oauth" && s.auth.issuer === issuer));
      const hosts = [...new Set(users.flatMap(p => p.def.servers.filter(s => s.auth.kind === "oauth" && s.auth.issuer === issuer).flatMap(s => {
        try { return [new URL(s.url).hostname]; } catch { return []; }
      })))].sort();
      return { issuer, configured: !!client, clientId: client?.clientId ?? null, hasSecret: !!client?.clientSecret, scopes: client?.scopes ?? null,
        authorizationParams: client?.authorizationParams ?? null, callbackUrl: `${origin}${CALLBACK_PATH}`, hosts,
        usedBy: users.map(p => ({ pluginId: p.id, displayName: p.def.displayName })) };
    }));
  }
}
