import { z } from "zod";
import { PLUGIN_PROVIDERS, type AdminPlugin, type PluginFile, type PluginOrigin, type PluginPreview, type PluginRef, type PluginValues, type ProviderId, type RegistryId, type ProviderInput, type ServerAuth, type ServerPreview } from "../../../../app/packages/contracts/src/baskule-plugins";
import { pluginError } from "../../shared/http";
import { checkMcpUrl, serverNetwork, type Network } from "../../shared/plugin-outbound";
import { rawUrl, fetchPluginFiles, resolveCommit } from "./github";
import { issuerKey, parseAuthorizationParams, probeAuth } from "./oauth";
import { digestValue, hasVariable, parseGithubUrl, parsePluginDirectory, slug, validHeaders, VARIABLE, type ParsedServer, type ParsedSkill } from "./package";
import { COMPOSIO_API, PIPEDREAM_MCP } from "./providers";
import { pluginCategory } from "./ranking";
import { fill, type StoredPlugin, type StoredServer } from "./state";
import { originKey, type PluginStore } from "./store";
import type { CatalogCache, StoredEntry } from "./catalog";

const id = z.string().min(1).max(200);
const custom = z.object({ displayName: z.string().trim().min(1).max(100), description: z.string().max(4000).optional(), url: z.string().min(1).max(2048),
  auth: z.enum(["none", "oauth", "header"]), headerName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,99}$/).optional() }).strict();
const ref = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), entryId: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("github"), url: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal("custom"), server: custom }).strict(),
]);
const access = z.discriminatedUnion("kind", [z.object({ kind: z.literal("everyone") }).strict(), z.object({ kind: z.literal("groups"), groups: z.array(id).max(1000) }).strict()]);
const values = z.record(z.string().max(200), z.record(z.string().max(100), z.string().max(8192)));
export const schemas = {
  preview: z.object({ ref }).strict(),
  install: z.object({ ref, digest: z.string().min(1).max(200), access, values, servers: z.array(z.string().max(200)).max(100).optional() }).strict(),
  update: z.object({ enabled: z.boolean().optional(), access: access.optional(), values: values.optional() }).strict(),
  oauthClient: z.object({ issuer: z.string().min(1).max(2048), clientId: z.string().trim().min(1).max(4096), clientSecret: z.string().max(8192).optional(),
    scopes: z.string().max(4096).optional(), authorizationParams: z.string().max(4096).optional() }).strict(),
  provider: z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("composio"), apiKey: z.string().trim().min(1).max(1024) }).strict(),
    z.object({ provider: z.literal("pipedream"), clientId: z.string().trim().min(1).max(1024), clientSecret: z.string().trim().min(1).max(1024),
      projectId: z.string().trim().min(1).max(200), environment: z.enum(["production", "development"]) }).strict(),
  ]),
};

/** A previewed source: everything install stores, before auth probing. */
interface Prepared {
  origin: PluginOrigin;
  name: string;
  displayName: string;
  description: string;
  logo: string | null;
  homepage: string | null;
  category: StoredPlugin["category"];
  /** `auth` is fixed by the source; `oauth` marks a custom server whose administrator chose sign-in. */
  servers: (ParsedServer & { auth?: ServerAuth; oauth?: boolean })[];
  skills: ParsedSkill[];
  skipped: PluginPreview["skipped"];
  digest: string;
  network: Network;
}

const literalHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).filter(([, value]) => !hasVariable(value)));

export class PluginAdmin {
  constructor(private store: PluginStore, private catalog: CatalogCache) {}

  private async fromGithub(repo: string, ref: string, path: string | undefined, origin: (sha: string) => PluginOrigin, fallback?: StoredEntry): Promise<Prepared> {
    const commit = await resolveCommit(this.store.fetcher, repo, ref);
    const files = await fetchPluginFiles(this.store.fetcher, repo, commit.sha, commit.tree, path);
    const parsed = await parsePluginDirectory(files, path?.split("/").pop() ?? repo.split("/")[1]!);
    const base = path ? `${path}/` : "";
    return { origin: origin(commit.sha), name: parsed.name, displayName: parsed.displayName, description: parsed.description || fallback?.description || "",
      logo: parsed.logo ? rawUrl(repo, commit.sha, base + parsed.logo) : fallback?.logo ?? null, homepage: parsed.homepage ?? fallback?.homepage ?? null,
      category: fallback?.category ?? pluginCategory(parsed.name, parsed.category), servers: parsed.servers, skills: parsed.skills, skipped: parsed.skipped,
      digest: parsed.digest, network: "public" };
  }

  async prepare(input: PluginRef): Promise<Prepared> {
    if (input.kind === "github") {
      const source = parseGithubUrl(input.url);
      return this.fromGithub(source.repo, source.ref ?? "HEAD", source.path, sha => ({ kind: "github", repo: `https://github.com/${source.repo}`, ...(source.path ? { path: source.path } : {}), sha }));
    }
    if (input.kind === "custom") {
      const server = input.server;
      if ((server.auth === "header") !== !!server.headerName || server.url.includes("${")) throw pluginError(400, "invalid_server");
      const network = serverNetwork(checkMcpUrl(server.url, "private").href);
      const url = checkMcpUrl(server.url, network).href;
      const header = server.auth === "header" ? server.headerName! : undefined;
      const auth: ServerAuth | undefined = header ? { kind: "headers", headers: [header] } : server.auth === "none" ? { kind: "none" } : undefined;
      return { origin: { kind: "custom" }, name: slug(server.displayName), displayName: server.displayName, description: server.description ?? "", logo: null, homepage: null,
        category: null, skills: [], skipped: [], network, digest: await digestValue({ ...server, url }),
        servers: [{ name: server.displayName, url, transport: "streamable-http", headers: header ? { [header]: `\${${header}}` } : {},
          variables: header ? [{ name: header, secret: true, where: "header" }] : [], ...(auth ? { auth } : { oauth: true }) }] };
    }
    const entry = await this.catalog.entry(input.entryId);
    if (!entry) throw pluginError(404, "plugin_not_found");
    if ("provider" in entry.ref) {
      const { provider, app } = entry.ref;
      if (!this.store.configuredProviders().has(provider)) throw pluginError(409, "provider_not_configured");
      return { origin: { kind: "provider", provider, app }, name: slug(app), displayName: entry.displayName, description: entry.description, logo: entry.logo,
        homepage: entry.homepage, category: entry.category, skills: [], skipped: [], network: "public", digest: await digestValue({ provider, app }),
        servers: [{ name: entry.displayName, url: provider === "pipedream" ? PIPEDREAM_MCP : `${COMPOSIO_API}/tool_router`, transport: "streamable-http", headers: {}, variables: [],
          auth: { kind: "provider", provider, app } }] };
    }
    const { repo, path, sha } = entry.ref;
    const registry = entry.source as RegistryId;
    return this.fromGithub(repo, sha, path, pinned => ({ kind: "registry", registry, repo: `https://github.com/${repo}`, ...(path ? { path } : {}), sha: pinned }), entry);
  }

  /** Placeholder headers mean the administrator supplies them; an unfilled address is probed once its values are saved. */
  private async probe(server: Prepared["servers"][number], network: Network, url = server.url): Promise<ServerAuth> {
    if (!hasVariable(url)) checkMcpUrl(url, network);
    if (server.auth) return server.auth;
    const templated = Object.entries(server.headers).filter(([, value]) => hasVariable(value)).map(([key]) => key);
    if (templated.length) return { kind: "headers", headers: templated };
    if (hasVariable(url)) return { kind: "none" };
    const probed = await probeAuth(this.store.fetcher, url, server.transport, network, literalHeaders(server.headers));
    return server.oauth && probed.kind !== "oauth" ? { kind: "oauth", issuer: null, registration: "dynamic" } : probed;
  }

  async preview(input: PluginRef): Promise<PluginPreview> {
    const prepared = await this.prepare(input);
    const servers: ServerPreview[] = await Promise.all(prepared.servers.map(async server => ({
      name: server.name, url: server.url, transport: server.transport, auth: await this.probe(server, prepared.network), variables: server.variables })));
    return { name: prepared.name, displayName: prepared.displayName, description: prepared.description, logo: prepared.logo, homepage: prepared.homepage,
      category: prepared.category, origin: prepared.origin, digest: prepared.digest, servers,
      skills: prepared.skills.map(s => ({ name: s.name, description: s.description, files: s.files.length })), skipped: prepared.skipped };
  }

  private validAccess(input: z.infer<typeof access>) {
    if (input.kind === "groups") for (const group of input.groups)
      if (!this.store.rows("select 1 from permission_group where id=?", group).length) throw pluginError(400, "group_not_found");
  }

  /** Values by server name; an empty string clears a value. Filled addresses must be valid MCP URLs for the plugin's network. */
  private resolveValues(servers: StoredServer[], input: PluginValues, current: Map<string, Record<string, string>>, network: Network) {
    for (const name of Object.keys(input)) if (!servers.some(s => s.name === name)) throw pluginError(400, "invalid_request", `Unknown server ${name}`);
    const next = new Map<string, Record<string, string>>();
    for (const server of servers) {
      const values = { ...current.get(server.id) };
      for (const [key, value] of Object.entries(input[server.name] ?? {})) {
        const variable = server.variables.find(v => v.name === key);
        if (!variable) throw pluginError(400, "invalid_request", `Unknown value ${key}`);
        if (/[\r\n\0]/.test(value)) throw pluginError(400, "invalid_request");
        if (value === "") delete values[key]; else values[key] = value;
      }
      next.set(server.id, values);
      const url = this.filledUrl(server, values);
      if (url !== null) checkMcpUrl(url, network);
      const headers = Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, fill(v, values)]));
      if (!validHeaders(headers)) throw pluginError(400, "invalid_server");
    }
    return next;
  }

  private filledUrl(server: StoredServer, values: Record<string, string> | undefined): string | null {
    return [...server.url.matchAll(VARIABLE)].some(([, name]) => !values?.[name!]) ? null : fill(server.url, values ?? {});
  }

  async install(input: z.infer<typeof schemas.install>, userId: string): Promise<{ id: string }> {
    const prepared = await this.prepare(input.ref);
    if (prepared.digest !== input.digest) throw pluginError(409, "plugin_changed");
    this.validAccess(input.access);
    const key = originKey(prepared.origin);
    if (key && this.store.list().some(p => originKey(p.def.origin) === key)) throw pluginError(409, "plugin_exists");
    const kept = input.servers ? new Set(input.servers) : null;
    if (kept && [...kept].some(name => !prepared.servers.some(s => s.name === name))) throw pluginError(400, "invalid_request", "Unknown server");
    const chosen = kept ? prepared.servers.filter(s => kept.has(s.name)) : prepared.servers;
    if (!chosen.length && !prepared.skills.length) throw pluginError(400, "plugin_empty");
    const ids = new Set<string>();
    const servers: StoredServer[] = chosen.map(server => {
      let sid = slug(server.name);
      for (let n = 2; ids.has(sid); n++) sid = `${slug(server.name).slice(0, 60)}-${n}`;
      ids.add(sid);
      return { id: sid, name: server.name, url: server.url, transport: server.transport, headers: server.headers, auth: server.auth ?? { kind: "none" }, variables: server.variables };
    });
    const values = this.resolveValues(servers, input.values, new Map(), prepared.network);
    await Promise.all(servers.map(async (server, index) => {
      const url = this.filledUrl(server, values.get(server.id));
      server.auth = await this.probe(chosen[index]!, prepared.network, url ?? server.url);
    }));
    const def: StoredPlugin = { name: prepared.name, displayName: prepared.displayName, description: prepared.description, logo: prepared.logo, homepage: prepared.homepage,
      category: prepared.category, origin: prepared.origin, digest: prepared.digest, servers, skills: prepared.skills.map(s => ({ name: s.name, description: s.description })),
      skipped: prepared.skipped };
    const files: PluginFile[] = prepared.skills.flatMap(s => s.files);
    let pluginId = prepared.name;
    for (let n = 2; this.store.get(pluginId); n++) pluginId = `${prepared.name.slice(0, 60)}-${n}`;
    const sealed = await Promise.all(servers.filter(s => Object.keys(values.get(s.id) ?? {}).length).map(async s => [s.id, await this.store.sealValues(pluginId, s.id, values.get(s.id)!)] as const));
    this.store.storage.transactionSync(() => {
      if (this.store.get(pluginId) || (key && this.store.list().some(p => originKey(p.def.origin) === key))) throw pluginError(409, "plugin_exists");
      this.store.rows("insert into plugin(id,definition,skill_files,enabled,access_everyone,installed_at,installed_by) values (?,?,?,1,?,?,?)",
        pluginId, JSON.stringify(def), JSON.stringify(files), Number(input.access.kind === "everyone"), Date.now(), userId);
      if (input.access.kind === "groups") for (const group of new Set(input.access.groups)) this.store.rows("insert into group_plugin(group_id,plugin_id) values (?,?)", group, pluginId);
      for (const [serverId, data] of sealed) this.store.rows("insert into plugin_value(plugin_id,server_id,data) values (?,?,?)", pluginId, serverId, data);
    });
    return { id: pluginId };
  }

  async update(pluginId: string, input: z.infer<typeof schemas.update>): Promise<void> {
    const plugin = this.store.get(pluginId);
    if (!plugin) throw pluginError(404, "plugin_not_found");
    if (input.access) this.validAccess(input.access);
    const def = structuredClone(plugin.def);
    const changed: string[] = [];
    const network: Network = def.origin.kind === "custom" ? "private" : "public";
    const sealed: (readonly [string, string | null])[] = [];
    if (input.values) {
      const current = new Map(await Promise.all(def.servers.map(async s => [s.id, await this.store.values(plugin.id, s.id)] as const)));
      const next = this.resolveValues(def.servers, input.values, current, network);
      for (const server of def.servers) {
        const before = current.get(server.id) ?? {}, after = next.get(server.id) ?? {};
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const url = this.filledUrl(server, after);
        if (url !== this.filledUrl(server, before)) {
          changed.push(server.id);
          if (url && server.auth.kind !== "headers") server.auth = await probeAuth(this.store.fetcher, url, server.transport, network, literalHeaders(server.headers));
        }
        sealed.push([server.id, Object.keys(after).length ? await this.store.sealValues(plugin.id, server.id, after) : null]);
      }
    }
    this.store.storage.transactionSync(() => {
      if (JSON.stringify(this.store.get(pluginId)?.def) !== JSON.stringify(plugin.def)) throw pluginError(409, "plugin_changed");
      if (input.enabled !== undefined) this.store.rows("update plugin set enabled=? where id=?", Number(input.enabled), pluginId);
      if (input.access) {
        this.store.rows("update plugin set access_everyone=? where id=?", Number(input.access.kind === "everyone"), pluginId);
        this.store.rows("delete from group_plugin where plugin_id=?", pluginId);
        if (input.access.kind === "groups") for (const group of new Set(input.access.groups)) this.store.rows("insert into group_plugin(group_id,plugin_id) values (?,?)", group, pluginId);
      }
      for (const [serverId, data] of sealed) {
        if (data === null) this.store.rows("delete from plugin_value where plugin_id=? and server_id=?", pluginId, serverId);
        else this.store.rows("insert into plugin_value(plugin_id,server_id,data) values (?,?,?) on conflict(plugin_id,server_id) do update set data=excluded.data", pluginId, serverId, data);
      }
      // A new address is a different resource: earlier sign-ins do not carry over.
      for (const serverId of changed) for (const table of ["plugin_connection", "plugin_oauth_state"])
        this.store.rows(`delete from ${table} where plugin_id=? and server_id=?`, pluginId, serverId);
      this.store.saveDefinition(pluginId, def);
    });
  }

  async remove(pluginId: string): Promise<void> {
    const plugin = this.store.get(pluginId);
    if (!plugin) throw pluginError(404, "plugin_not_found");
    const accounts = plugin.def.origin.kind === "provider" ? this.store.rows("select user_id,server_id,data from plugin_connection where plugin_id=?", pluginId) : [];
    this.store.rows("delete from plugin where id=?", pluginId);
    if (plugin.def.origin.kind !== "provider") return;
    const client = await this.store.provider(plugin.def.origin.provider);
    // Best effort: the plugin is gone whether or not the platform answers.
    await Promise.all(accounts.map(async row => {
      try {
        const data = await this.store.cipher.open<{ account: string }>(row.data as string, this.store.connectionContext(row.user_id as string, pluginId, row.server_id as string));
        await client?.revoke(data.account);
      } catch {}
    }));
  }

  async list(origin: string) {
    const facts = await this.store.facts();
    return { plugins: this.store.list().map(p => this.store.adminPlugin(p, facts)), oauthClients: await this.store.oauthClients(origin), providers: await this.store.providerSettings() };
  }
  async one(pluginId: string): Promise<AdminPlugin> {
    const plugin = this.store.get(pluginId);
    if (!plugin) throw pluginError(404, "plugin_not_found");
    return this.store.adminPlugin(plugin, await this.store.facts());
  }

  /** A changed or removed client invalidates the sign-ins made with it; a secret rotation keeps them. */
  private expireIssuer(issuer: string) {
    for (const plugin of this.store.list()) for (const server of plugin.def.servers) {
      if (server.auth.kind !== "oauth" || server.auth.issuer !== issuer) continue;
      this.store.rows("update plugin_connection set state='expired' where plugin_id=? and server_id=?", plugin.id, server.id);
      this.store.rows("delete from plugin_oauth_state where plugin_id=? and server_id=?", plugin.id, server.id);
    }
  }

  async saveOAuthClient(input: z.infer<typeof schemas.oauthClient>): Promise<void> {
    // The sign-in reaches the issuer under the same rule as a server: HTTPS, or HTTP on a private network.
    try { checkMcpUrl(input.issuer, serverNetwork(input.issuer)); } catch { throw pluginError(400, "invalid_oauth_client"); }
    const key = issuerKey(input.issuer);
    const params = input.authorizationParams?.trim() ?? "";
    if (params && !parseAuthorizationParams(params)) throw pluginError(400, "invalid_oauth_client", "Authorization parameters cannot set the flow's own parameters");
    const current = await this.store.oauthClient(key);
    const secret = input.clientSecret === undefined ? current?.clientId === input.clientId ? current.clientSecret : undefined : input.clientSecret.trim() || undefined;
    const record = { clientId: input.clientId, ...(secret ? { clientSecret: secret } : {}), ...(input.scopes?.trim() ? { scopes: input.scopes.trim().split(/\s+/).join(" ") } : {}),
      ...(params ? { authorizationParams: params.replace(/^\?/, "") } : {}) };
    const data = await this.store.sealOAuthClient(key, record);
    this.store.storage.transactionSync(() => {
      this.store.rows("insert into oauth_client(issuer,data) values (?,?) on conflict(issuer) do update set data=excluded.data", key, data);
      if (current && current.clientId !== input.clientId) this.expireIssuer(key);
    });
  }

  removeOAuthClient(issuer: string) {
    const key = issuerKey(issuer);
    this.store.storage.transactionSync(() => {
      if (!this.store.rows("delete from oauth_client where issuer=? returning issuer", key).length) throw pluginError(404, "invalid_oauth_client");
      this.expireIssuer(key);
    });
  }

  async saveProvider(provider: ProviderId, input: ProviderInput): Promise<void> {
    if (input.provider !== provider) throw pluginError(400, "invalid_request");
    await this.store.client(input).verify();
    const previous = await this.store.providerInput(provider);
    const data = await this.store.sealProvider(input);
    // Pipedream accounts belong to one project and environment.
    const moved = previous?.provider === "pipedream" && input.provider === "pipedream" && (previous.projectId !== input.projectId || previous.environment !== input.environment);
    this.store.storage.transactionSync(() => {
      this.store.rows("insert into plugin_provider(provider,data) values (?,?) on conflict(provider) do update set data=excluded.data", provider, data);
      if (moved) for (const plugin of this.store.list()) if (plugin.def.origin.kind === "provider" && plugin.def.origin.provider === provider)
        this.store.rows("update plugin_connection set state='expired' where plugin_id=?", plugin.id);
    });
    this.catalog.forget(provider);
  }

  removeProvider(provider: ProviderId) {
    if (!PLUGIN_PROVIDERS.includes(provider)) throw pluginError(404, "provider_not_configured");
    this.store.rows("delete from plugin_provider where provider=?", provider);
    this.catalog.forget(provider);
  }
}
