import { catalogService, catalogVendor, type CatalogService, type CatalogVendor } from "../../../app/packages/contracts/src/baskule-catalog";
import type { ConnectionCipher } from "./connection-crypto";
import { checkMcpUrl, connectMcp, serverNetwork } from "../shared/plugin-outbound";
import { z } from "zod";
import type { Plugin, PluginInput, PluginUpdate, PluginServer, SpacePlugins, SpacePluginSettings, MemberPlugin, PluginStatus, CredentialMode, ServerInput, PluginTool } from "../../../app/packages/contracts/src/baskule-plugins";
import { HttpError, pluginError, json, notFound } from "../shared/http";
import type { StorageLike } from "./service";
import type { Connections } from "./connections";
import { Groups } from "./groups";
import { fromBase64, IMPORT_LIMITS, inspectPackage, exportPackage, skillFromInput, skillToInput, sha256, unpackArchive, type StoredSkill } from "./plugin-package";
import { addressPlaceholders, serverFingerprint } from "../../../app/packages/contracts/src/baskule-plugin-formats";
import { readBounded, type Fetcher } from "./plugin-source";
import { fetchGitFiles } from "./plugin-source";
import { SdkHttpError, SseError } from "@modelcontextprotocol/client";
import { discoverOAuth } from "./connection-oauth";
import { COMMIT_RE, resolveGithubLink } from "./plugin-source";

const id = z.string().min(1).max(200);
const credential = z.enum(["none", "organization", "user-oauth"]);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i).max(200);
const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("custom") }).strict(),
  z.object({ type: z.literal("github"), repo: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/), sha: z.string().regex(COMMIT_RE), path: z.string().max(512).optional() }).strict(),
  z.object({ type: z.literal("upload"), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const serverSchema = z.object({ name: id, url: z.string().max(2048), transport: z.enum(["streamable-http", "sse"]).optional(), credential,
  disabledTools: z.array(id).max(1000).optional(),
  keyHeaders: z.array(headerName).max(20).optional(),
  oauth: z.object({ scopes: z.array(z.string().min(1).max(2048)).max(100).optional(),
    params: z.record(z.string().regex(/^[a-z_]+$/).refine(key => !["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"].includes(key)), z.string().max(2048)).optional(), resource: z.literal(false).optional(), staticClient: z.literal(true).optional(),
  }).strict().optional(),
}).strict();
const skillSchema = z.object({ name: z.string().max(64), description: z.string().max(1024), instructions: z.string(), frontmatter: z.string().optional(), files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.literal("base64") }).strict()).max(IMPORT_LIMITS.files) }).strict();
const inputSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(4000),
  icon: z.url().max(2048).refine(v => new URL(v).protocol === "https:").optional(), source: sourceSchema,
  servers: z.array(serverSchema).max(100), skills: z.array(skillSchema).max(100),
  omitted: z.array(z.object({ code: z.enum(["claude_commands", "claude_agents", "hooks", "local_program", "invalid_server", "skill_without_instructions", "invalid_skill", "skill_license", "other_files"]), subject: z.string().max(512) }).strict()).max(IMPORT_LIMITS.files),
}).strict();
const patchSchema = z.union([z.object({ enabled: z.boolean() }).strict(), z.object({ plugin: inputSchema }).strict(), z.object({ disabledTools: z.record(id, z.array(id).max(1000)) }).strict()]);
const spaceSchema = z.object({ personalPluginsAllowed: z.boolean(), disabled: z.array(id).max(100) }).strict();
const DEFAULT_SPACE_SETTINGS: SpacePluginSettings = { personalPluginsAllowed: false, disabled: [] };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw pluginError(400, "invalid_plugin_input", p.error.message);
  return p.data;
}
async function body(req: Request, limit = 64 * 1024): Promise<unknown> {
  const bytes = await readBounded(req.body, limit);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw pluginError(400, "invalid_json"); }
}

type PluginUseDecision = { allowed: true } | { allowed: false; error: "unavailable" };

export interface PluginPolicy {
  user: { id: string; banned: boolean } | undefined;
  space: { id: string; kind: "team" | "personal"; members: string[]; settings: SpacePluginSettings } | undefined;
  plugin: Plugin | undefined;
  assigned: boolean;
}

/** Pure policy: callers pass a current snapshot; no cached grants, credentials or I/O. */
export function canUse(userId: string, spaceId: string, pluginId: string, server: string | undefined, policy: PluginPolicy): PluginUseDecision {
  const { user, space, plugin } = policy;
  if (!user || user.id !== userId || user.banned || !space || space.id !== spaceId || !space.members.includes(userId) ||
      !plugin || plugin.id !== pluginId || !policy.assigned)
    return { allowed: false, error: "unavailable" };
  const target = server === undefined ? undefined : plugin.servers.find(s => s.name === server);
  if (server !== undefined && (!target || (target.credential === "user-oauth" && space.kind !== "personal" && !space.settings.personalPluginsAllowed))) return { allowed: false, error: "unavailable" };
  if (!plugin.enabled || space.settings.disabled.includes(pluginId)) return { allowed: false, error: "unavailable" };
  return { allowed: true };
}

export function pluginStatus(facts: { allowed: boolean; server?: { credential: CredentialMode; setupDone: boolean; account?: "connect" | "reconnect" | "ready" } }): PluginStatus {
  if (!facts.allowed) return "unavailable";
  if (!facts.server) return "ready";
  if (!facts.server.setupDone) return "needs_setup";
  if (["user-oauth"].includes(facts.server.credential)) return facts.server.account ?? "connect";
  return "ready";
}
export function worstStatus(statuses: PluginStatus[]): PluginStatus {
  return (["unavailable", "needs_setup", "connect", "reconnect", "ready"] as const).find(status => statuses.includes(status)) ?? "ready";
}

export function pluginFromCatalog(service: CatalogService, vendor: CatalogVendor): Plugin {
  const signIn = vendor.signIn;
  return { id: service.id, vendor: vendor.id, name: service.name, description: service.description, icon: service.icon,
    source: { type: "catalog" }, skills: [], omitted: [], enabled: true, createdAt: new Date().toISOString(),
    servers: service.servers.map(server => ({ name: server.name, url: server.url, transport: server.transport ?? "streamable-http",
      disabledTools: [], credential: signIn.type === "account" ? "user-oauth" : signIn.type === "key" ? "organization" : "none",
      ...(signIn.type === "account" ? { oauth: {
        ...(server.scopes ? { scopes: server.scopes } : {}), ...(signIn.params ? { params: signIn.params } : {}),
        ...(server.resource ? { resourceUrl: server.resource } : {}),
        ...(signIn.client === "static" ? { staticClient: true, ...(signIn.resource === false ? { resource: false as const } : {}) } : {}),
      } } : {}),
    })),
  };
}

export class Plugins {
  constructor(private storage: StorageLike, private groups: Groups, private cipher: ConnectionCipher, private fetcher: Fetcher = fetch) {}
  connections?: Connections;
  private rows(q: string, ...p: unknown[]) { return this.storage.sql.exec(q, ...p).toArray(); }
  list(): Plugin[] { return this.rows("select definition from plugin order by id").map(r => JSON.parse(r.definition as string)); }
  get(id: string): Plugin | undefined {
    const row = this.rows("select definition from plugin where id=?", id)[0];
    return row ? JSON.parse(row.definition as string) : undefined;
  }
  spaceSettings(spaceId: string): SpacePluginSettings {
    const r = this.rows("select personal_plugins_allowed from space_plugin_settings where space_id=?", spaceId)[0];
    return { personalPluginsAllowed: r ? !!r.personal_plugins_allowed : DEFAULT_SPACE_SETTINGS.personalPluginsAllowed,
      disabled: this.rows("select plugin_id from space_disabled_plugin where space_id=? order by plugin_id", spaceId).map(p => p.plugin_id as string) };
  }
  policy(userId: string, spaceId: string, pluginId: string): PluginPolicy {
    const u = this.rows("select id, banned from user where id=?", userId)[0];
    const s = this.rows("select id,kind from space where id=?", spaceId)[0];
    return {
      user: u ? { id: u.id as string, banned: !!u.banned } : undefined,
      space: s ? { id: s.id as string, kind: s.kind as "team" | "personal", members: this.rows("select user_id from space_member where space_id=?", spaceId).map(r => r.user_id as string), settings: this.spaceSettings(spaceId) } : undefined,
      plugin: this.get(pluginId), assigned: this.assigned(userId, pluginId),
    };
  }
  assigned(userId: string, pluginId: string): boolean { return this.groups.permissions(userId).plugins.includes(pluginId); }
  canUse(userId: string, spaceId: string, pluginId: string, server?: string): PluginUseDecision {
    return canUse(userId, spaceId, pluginId, server, this.policy(userId, spaceId, pluginId));
  }
  async organizationHeaders(pluginId: string, server: string): Promise<Record<string, string> | undefined> {
    const r = this.rows("select data from plugin_secret where plugin_id=? and server=?", pluginId, server)[0];
    return r ? this.cipher.open<Record<string, string>>(r.data as string, JSON.stringify(["secret", pluginId, server])) : undefined;
  }
  setupDone(plugin: Plugin, server: PluginServer): boolean {
    if (server.credential === "organization") return !!this.rows("select 1 from plugin_secret where plugin_id=? and server=?", plugin.id, server.name).length;
    return !server.oauth?.staticClient || !!this.connections?.vendorConfigured(plugin.vendor);
  }
  async statusFor(userId: string, plugin: Plugin): Promise<MemberPlugin> {
    const user = this.rows("select banned from user where id=?", userId)[0];
    const allowed = !!user && !user.banned && plugin.enabled && this.assigned(userId, plugin.id);
    const servers = await Promise.all(plugin.servers.map(async server => {
      const accounts = server.credential === "user-oauth" ? await this.connections!.accounts(userId, plugin.id, server) : [];
      return { name: server.name, credential: server.credential, accounts, status: pluginStatus({ allowed, server: {
        credential: server.credential, setupDone: this.setupDone(plugin, server), account: accounts.find(a => a.default)?.status ?? "connect",
      } }) };
    }));
    return { id: plugin.id, name: plugin.name, description: plugin.description, ...(plugin.icon ? { icon: plugin.icon } : {}), skills: plugin.skills,
      status: servers.length ? worstStatus(servers.map(s => s.status)) : pluginStatus({ allowed }), servers };
  }
  async settings(spaceId: string): Promise<SpacePlugins> {
    const space = this.rows("select kind from space where id=?", spaceId)[0];
    if (!space) throw pluginError(404, "not_found");
    const members = this.rows("select user_id from space_member where space_id=? order by user_id", spaceId).map(r => r.user_id as string);
    const plugins = this.list().filter(p => members.some(userId => this.canUse(userId, spaceId, p.id).allowed));
    const servers: SpacePlugins["servers"] = [];
    for (const plugin of plugins) {
      const statuses = new Map<string, MemberPlugin>();
      for (const server of plugin.servers) {
        for (const userId of members) {
          if (!this.canUse(userId, spaceId, plugin.id, server.name).allowed) continue;
          let status = statuses.get(userId);
          if (!status) { status = await this.statusFor(userId, plugin); statuses.set(userId, status); }
          if (status.servers.find(s => s.name === server.name)?.status !== "ready" || !this.canUse(userId, spaceId, plugin.id, server.name).allowed) continue;
          servers.push({ ...server, pluginId: plugin.id, pluginName: plugin.name, catalogUserId: userId, privateNetwork: serverNetwork(server.url) === "private", defaultAccountOnly: space.kind === "team" });
          break;
        }
      }
    }
    return {
      servers,
      skills: plugins.filter(p => members.some(userId => this.canUse(userId, spaceId, p.id).allowed)).flatMap(p => {
        const row = this.rows("select skill_files from plugin where id=?", p.id)[0];
        return JSON.parse(row.skill_files as string).map((s: SpacePlugins["skills"][number]) => ({ ...s, pluginId: p.id }));
      }),
    };
  }

  private validate(input: PluginInput) {
    if (!input.servers.length && !input.skills.length) throw pluginError(400, "empty_plugin");
    if (new Set(input.servers.map(s => s.name)).size !== input.servers.length) throw pluginError(400, "invalid_plugin_input");
    const servers = input.servers.map(server => this.validateServer(server));
    const skills: StoredSkill[] = [];
    for (const skill of input.skills) skills.push(skillFromInput(skill, skills.map(s => s.name)));
    const storedBytes = skills.reduce((total, skill) => total + skill.files.reduce((n, file) => n + fromBase64(file.content).length, 0), 0);
    if (storedBytes > IMPORT_LIMITS.stored) throw pluginError(413, "plugin_too_large");
    if (skills.reduce((n, skill) => n + skill.files.length, 0) > IMPORT_LIMITS.files) throw pluginError(413, "too_many_plugin_files");
    return { servers, skills, storedBytes };
  }

  private validateServer(server: ServerInput): PluginServer {
    if (addressPlaceholders(server.url).length) throw pluginError(400, "address_placeholder");
    if (server.oauth && server.credential !== "user-oauth") throw pluginError(400, "invalid_plugin_input");
    const { keyHeaders, ...rest } = server;
    return { ...rest, disabledTools: [...new Set(server.disabledTools ?? [])], url: checkMcpUrl(server.url, "private").href,
      ...(server.credential === "organization" && keyHeaders ? { keyHeaders } : {}) };
  }

  private async tools(server: PluginServer, headers: Record<string, string>): Promise<PluginTool[]> {
    const client = await connectMcp(server, serverNetwork(server.url), headers, 15_000);
    try { return (await client.listTools(undefined, { timeout: 15_000 })).tools.map(tool => ({ name: tool.name, description: tool.description ?? "" })); }
    finally { await client.close(); }
  }

  private async test(req: Request): Promise<Response> {
    const input = parse(z.object({ server: serverSchema, headers: z.record(headerName, z.string().max(8192).refine(v => !/[\r\n\0]/.test(v))).optional() }).strict(), await body(req));
    const server = this.validateServer(input.server);
    const headers = input.headers ?? {};
    this.validateHeaders(headers, false);
    try { return json({ tools: await this.tools(server, headers) }); }
    catch (error) {
      if (error instanceof SdkHttpError && error.status === 401 || error instanceof SseError && error.code === 401) {
        try {
          const discovery = await discoverOAuth(server.url, this.fetcher, serverNetwork(server.url));
          return json({ signIn: "account", staticClient: !discovery.as.registration_endpoint });
        } catch { throw pluginError(409, "key_required"); }
      }
      if (error instanceof HttpError) throw error;
      throw pluginError(502, "server_unreachable");
    }
  }

  private validateHeaders(headers: Record<string, string>, required: boolean) {
    const names = Object.keys(headers);
    if (required && !names.length || names.length > 20 || names.some(k => ["host", "cookie", "content-length", "connection", "transfer-encoding"].includes(k.toLowerCase()))) throw pluginError(400, "invalid_secret_headers");
  }

  private async inspect(req: Request): Promise<Response> {
    const data = parse(z.union([z.object({ archive: z.string() }).strict(), z.object({ github: z.string().max(2048) }).strict()]), await body(req, Math.ceil(IMPORT_LIMITS.archive / 3) * 4 + 8192));
    if ("github" in data) {
      const source = await resolveGithubLink(this.fetcher, data.github);
      if (source.repo.toLowerCase() === "https://github.com/anthropics/skills" && /(?:^|\/)(docx|pdf|pptx|xlsx)(?:\/|$)/.test(source.path ?? "")) throw pluginError(400, "proprietary_plugin");
      return json(inspectPackage(await fetchGitFiles(this.fetcher, source), { path: source.path, source }));
    }
    const bytes = fromBase64(data.archive);
    return json(inspectPackage(unpackArchive(bytes), { stripRoot: true, source: { type: "upload", sha256: await sha256(bytes) } }));
  }

  private async install(req: Request): Promise<Response> {
    const data = parse(z.union([
      z.object({ catalog: id, groups: z.array(id).max(1000) }).strict(),
      z.object({ plugin: inputSchema, groups: z.array(id).max(1000) }).strict(),
    ]), await body(req, IMPORT_LIMITS.stored * 2));
    let plugin: Plugin;
    let skills: StoredSkill[] = [];
    let storedBytes = 0;
    if ("catalog" in data) {
      const service = catalogService(data.catalog);
      if (!service) throw pluginError(404, "catalog_unknown");
      if (service.notYet) throw pluginError(409, "catalog_not_available");
      plugin = pluginFromCatalog(service, catalogVendor(service.vendor)!);
    } else {
      const validated = this.validate(data.plugin);
      skills = validated.skills; storedBytes = validated.storedBytes;
      const pluginId = crypto.randomUUID();
      plugin = { ...data.plugin, id: pluginId, vendor: pluginId, skills: skills.map(s => ({ name: s.name, description: s.description })), servers: validated.servers, enabled: true, createdAt: new Date().toISOString() };
    }
    this.storage.transactionSync(() => {
      if (this.get(plugin.id)) throw pluginError(409, "already_installed");
      const groups = new Set(this.groups.list().map(group => group.id));
      if (data.groups.some(id => !groups.has(id))) throw pluginError(400, "invalid_group");
      const total = this.rows("select count(*) as n, coalesce(sum(stored_bytes),0) as bytes from plugin")[0];
      if (Number(total.n) >= IMPORT_LIMITS.plugins || Number(total.bytes) + storedBytes > IMPORT_LIMITS.totalStored) throw pluginError(413, "plugin_storage_limit");
      this.rows("insert into plugin(id,definition,skill_files,stored_bytes) values (?,?,?,?)", plugin.id, JSON.stringify(plugin), JSON.stringify(skills), storedBytes);
      for (const group of new Set(data.groups)) this.rows("insert into group_plugin(group_id,plugin_id) values (?,?)", group, plugin.id);
    });
    return json(plugin, 201);
  }

  async admin(req: Request, path: string, userId: string): Promise<Response> {
    if (path === "/admin/plugins" && req.method === "GET") return json({ plugins: this.list().map(plugin => ({ ...plugin, setup: plugin.servers.map(server => ({ server: server.name, done: this.setupDone(plugin, server) })), vendorConfigured: !!this.connections?.vendorConfigured(plugin.vendor) })) });
    if (path === "/admin/plugins" && req.method === "POST") return this.install(req);
    if (path === "/admin/plugins/inspect" && req.method === "POST") return this.inspect(req);
    if (path === "/admin/plugins/test" && req.method === "POST") return this.test(req);
    const match = /^\/admin\/plugins\/([^/]+)(\/(?:secret|skills|export|tools))?$/.exec(path);
    if (!match) return notFound();
    const plugin = this.get(match[1]);
    if (!plugin) return notFound();
    if (match[2] === "/tools" && req.method === "GET") {
      const server = plugin.servers.find(s => s.name === new URL(req.url).searchParams.get("server"));
      if (!server) throw pluginError(400, "plugin_server_required");
      const headers = server.credential === "organization" ? await this.organizationHeaders(plugin.id, server.name)
        : server.credential === "user-oauth" ? await this.connections!.adminHeaders(userId, plugin.id, server.name) : {};
      if (!headers) throw pluginError(409, server.credential === "organization" ? "key_required" : "connection_not_allowed");
      try { return json({ tools: await this.tools(server, headers) }); }
      catch { throw pluginError(502, "server_unreachable"); }
    }
    if (match[2] === "/skills" && req.method === "GET") return json({ skills: this.skills(plugin.id).map(skillToInput), editable: plugin.source.type === "custom" || plugin.source.type === "upload" });
    if (match[2] === "/export" && req.method === "GET") {
      if (plugin.source.type === "catalog") throw pluginError(409, "not_editable");
      return new Response(exportPackage(plugin, this.skills(plugin.id)) as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="plugin.zip"' } });
    }
    if (match[2] === "/secret" && req.method === "PUT") {
      const data = parse(z.object({ server: id, headers: z.record(headerName, z.string().max(8192).refine(v => !/[\r\n\0]/.test(v))).nullable() }).strict(), await body(req));
      if (!plugin.servers.some(s => s.name === data.server && s.credential === "organization")) throw pluginError(400, "not_organization_server");
      if (data.headers === null) this.rows("delete from plugin_secret where plugin_id=? and server=?", plugin.id, data.server);
      else {
        this.validateHeaders(data.headers, true);
        const sealed = await this.cipher.seal(data.headers, JSON.stringify(["secret", plugin.id, data.server]));
        if (JSON.stringify(this.get(plugin.id)?.servers.find(s => s.name === data.server)) !== JSON.stringify(plugin.servers.find(s => s.name === data.server))) throw pluginError(409, "connection_not_allowed");
        this.storage.transactionSync(() => {
          this.rows("insert into plugin_secret(plugin_id,server,data) values (?,?,?) on conflict(plugin_id,server) do update set data=excluded.data", plugin.id, data.server, sealed);
          const current = this.get(plugin.id)!;
          current.servers = current.servers.map(s => s.name === data.server ? { ...s, keyHeaders: Object.keys(data.headers!) } : s);
          this.rows("update plugin set definition=? where id=?", JSON.stringify(current), current.id);
        });
      }
      return json({ ok: true });
    }
    if (match[2]) return notFound();
    if (req.method === "DELETE") { if (plugin.vendor === plugin.id && plugin.source.type !== "catalog") this.rows("delete from vendor_setup where vendor=?", plugin.vendor); this.rows("delete from plugin where id=?", plugin.id); return json({ ok: true }); }
    if (req.method === "PATCH") {
      const patch: PluginUpdate = parse(patchSchema, await body(req, IMPORT_LIMITS.stored * 2));
      const current = this.get(plugin.id);
      if (!current) return notFound();
      if ("enabled" in patch) {
        current.enabled = patch.enabled;
        this.rows("update plugin set definition=? where id=?", JSON.stringify(current), current.id);
        return json(current);
      }
      if ("disabledTools" in patch) {
        if (Object.keys(patch.disabledTools).some(name => !current.servers.some(server => server.name === name))) throw pluginError(400, "plugin_server_required");
        current.servers = current.servers.map(server => Object.hasOwn(patch.disabledTools, server.name) ? { ...server, disabledTools: [...new Set(patch.disabledTools[server.name])] } : server);
        this.rows("update plugin set definition=? where id=?", JSON.stringify(current), current.id);
        return json(current);
      }
      if (current.source.type === "catalog" || JSON.stringify(current.source) !== JSON.stringify(patch.plugin.source)) throw pluginError(409, "not_editable");
      const next = this.validate(patch.plugin);
      for (const [index, server] of next.servers.entries()) {
        const previous = current.servers.find(s => s.name === server.name);
        if (previous && previous.url === server.url && patch.plugin.servers[index].disabledTools === undefined) server.disabledTools = previous.disabledTools;
        if (previous && server.credential === "organization" && serverFingerprint(previous) === serverFingerprint(server) && this.setupDone(current, previous)) server.keyHeaders = previous.keyHeaders;
      }
      if (current.source.type === "github" && JSON.stringify(next.skills) !== JSON.stringify(this.skills(current.id))) throw pluginError(409, "not_editable");
      const updated: Plugin = { ...patch.plugin, id: current.id, vendor: current.vendor, enabled: current.enabled, createdAt: current.createdAt,
        skills: next.skills.map(s => ({ name: s.name, description: s.description })), servers: next.servers };
      this.storage.transactionSync(() => {
        const total = Number(this.rows("select coalesce(sum(stored_bytes),0) as bytes from plugin where id<>?", current.id)[0].bytes);
        if (total + next.storedBytes > IMPORT_LIMITS.totalStored) throw pluginError(413, "plugin_storage_limit");
        for (const old of current.servers) {
          const replacement = next.servers.find(s => s.name === old.name);
          if (replacement && serverFingerprint(old) === serverFingerprint(replacement)) continue;
          if (old.credential === "user-oauth" && this.connections?.vendorConfigured(current.vendor)) {
            this.rows("delete from vendor_setup where vendor=?", current.vendor);
            this.rows("delete from plugin_connection where plugin_id=?", current.id);
            this.rows("delete from plugin_oauth_state where plugin_id=?", current.id);
          }
          for (const table of ["plugin_secret", "plugin_connection", "plugin_oauth_state"]) this.rows(`delete from ${table} where plugin_id=? and server=?`, current.id, old.name);
        }
        this.rows("update plugin set definition=?,skill_files=?,stored_bytes=? where id=?", JSON.stringify(updated), JSON.stringify(next.skills), next.storedBytes, current.id);
      });
      return json(updated);
    }
    return notFound();
  }

  private skills(id: string): StoredSkill[] { return JSON.parse(this.rows("select skill_files from plugin where id=?", id)[0].skill_files as string); }

  async user(req: Request, path: string, userId: string): Promise<Response> {
    if (path === "/plugins" && req.method === "GET") return json({ plugins: await Promise.all(this.list().filter(p => this.assigned(userId, p.id)).map(p => this.statusFor(userId, p))) });
    return notFound();
  }

  async space(req: Request, spaceId: string, user: { id: string; role?: string | null }): Promise<Response> {
    const s = this.rows("select kind,personal_user_id from space where id=?", spaceId)[0];
    const member = this.rows("select role from space_member where space_id=? and user_id=?", spaceId, user.id)[0];
    if (!s || (!member && user.role !== "admin")) return notFound();
    if (member?.role !== "owner" && user.role !== "admin") throw pluginError(403, "forbidden");
    if (req.method === "GET") return json(this.spaceSettings(spaceId));
    if (req.method === "PUT") {
      const data = parse(spaceSchema, await body(req));
      for (const pid of data.disabled) if (!this.get(pid)) throw pluginError(400, "plugin_not_found");
      this.storage.transactionSync(() => {
        this.rows("insert into space_plugin_settings(space_id,personal_plugins_allowed) values (?,?) on conflict(space_id) do update set personal_plugins_allowed=excluded.personal_plugins_allowed", spaceId, Number(data.personalPluginsAllowed));
        this.rows("delete from space_disabled_plugin where space_id=?", spaceId);
        for (const pid of new Set(data.disabled)) this.rows("insert into space_disabled_plugin(space_id,plugin_id) values (?,?)", spaceId, pid);
      });
      return json(this.spaceSettings(spaceId));
    }
    return notFound();
  }
}
