import type { ConnectionCipher } from "./connection-crypto";
import { checkMcpUrl, serverNetwork } from "../shared/plugin-outbound";
import { z } from "zod";
import type { Plugin, PluginPatch, PluginServer, PluginSource, SpacePlugins, SpacePluginSettings, MemberPlugin, PluginStatus, CredentialMode } from "../../../app/packages/contracts/src/baskule-plugins";
import { pluginError, json, notFound } from "../shared/http";
import type { StorageLike } from "./service";
import type { Connections } from "./connections";
import { Groups } from "./groups";
import { fromBase64, IMPORT_LIMITS, inspectBundle, sha256, unpackArchive } from "./plugin-import";
import { registries, searchRegistries } from "./registries";
import { readBounded, type Fetcher } from "./registries/http";
import { fetchGitFiles } from "./registries/git";
import { COMMIT_RE, githubRepo } from "./registries/marketplace";

const id = z.string().min(1).max(200);
const credential = z.enum(["none", "organization", "user-oauth", "login-identity"]);
const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("registry"), registry: id, id, version: id.optional() }).strict(),
  z.object({ type: z.literal("url"), url: z.string().max(2048) }).strict(),
  z.object({ type: z.literal("git"), repo: z.string().max(2048), ref: z.string().regex(COMMIT_RE), path: z.string().max(512).optional() }).strict(),
  z.object({ type: z.literal("archive"), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), description: z.string().max(4000).optional(),
  icon: z.url().max(2048).refine(v => new URL(v).protocol === "https:").optional(), enabled: z.boolean().optional(),
  servers: z.array(z.object({ name: id, url: z.string().max(2048).optional(), transport: z.enum(["streamable-http", "sse"]).optional(), credential, personal: z.boolean(),
    oauth: z.object({ scopes: z.array(z.string().min(1).max(2048)).max(100) }).strict().optional(),
    loginIdentity: z.object({ provider: z.enum(["google", "microsoft"]), scopes: z.array(z.string().min(1).max(2048)).min(1).max(100), audience: z.string().min(1).max(2048) }).strict().optional(),
  }).strict()).max(100).optional(),
}).strict();
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
  if (server !== undefined && (!target || (target.personal && space.kind !== "personal" && !space.settings.personalPluginsAllowed))) return { allowed: false, error: "unavailable" };
  if (!plugin.enabled || space.settings.disabled.includes(pluginId)) return { allowed: false, error: "unavailable" };
  return { allowed: true };
}

export function pluginStatus(facts: { allowed: boolean; server?: { credential: CredentialMode; setupDone: boolean; account?: "connect" | "reconnect" | "ready" } }): PluginStatus {
  if (!facts.allowed) return "unavailable";
  if (!facts.server) return "ready";
  if (!facts.server.setupDone) return "needs_setup";
  if (["user-oauth", "login-identity"].includes(facts.server.credential)) return facts.server.account ?? "connect";
  return "ready";
}
export function worstStatus(statuses: PluginStatus[]): PluginStatus {
  return (["unavailable", "needs_setup", "connect", "reconnect", "ready"] as const).find(status => statuses.includes(status)) ?? "ready";
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
  /** Only P2's private credential handler should read these values. */
  async organizationHeaders(pluginId: string, server: string): Promise<Record<string, string> | undefined> {
    const r = this.rows("select data from plugin_secret where plugin_id=? and server=?", pluginId, server)[0];
    return r ? this.cipher.open<Record<string, string>>(r.data as string, JSON.stringify(["secret", pluginId, server])) : undefined;
  }
  setupDone(plugin: Plugin, server: PluginServer): boolean {
    return server.credential !== "organization" || !!this.rows("select 1 from plugin_secret where plugin_id=? and server=?", plugin.id, server.name).length;
  }
  async statusFor(userId: string, plugin: Plugin): Promise<MemberPlugin> {
    const user = this.rows("select banned from user where id=?", userId)[0];
    const allowed = !!user && !user.banned && plugin.enabled && this.assigned(userId, plugin.id);
    const servers = await Promise.all(plugin.servers.map(async server => ({ name: server.name, personal: ["user-oauth", "login-identity"].includes(server.credential), status: pluginStatus({ allowed, server: {
      credential: server.credential, setupDone: this.setupDone(plugin, server),
      account: ["user-oauth", "login-identity"].includes(server.credential) ? await this.connections!.state(userId, plugin.id, server) : undefined,
    } }) })));
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
          servers.push({ ...server, pluginId: plugin.id, pluginName: plugin.name, catalogUserId: userId, privateNetwork: serverNetwork(server.url) === "private" });
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

  private async install(req: Request): Promise<Response> {
    const data = parse(z.object({ source: sourceSchema, groups: z.array(id).max(1000), name: z.string().trim().min(1).max(100).optional(), archive: z.string().max(Math.ceil(IMPORT_LIMITS.archive / 3) * 4).optional() }).strict(), await body(req, Math.ceil(IMPORT_LIMITS.archive / 3) * 4 + 8192));
    let source: PluginSource = data.source;
    let resolvedSource: Plugin["resolvedSource"];
    let selectedSkills: string[] | undefined;
    let name = data.name;
    let description = "";
    let remoteServers: PluginServer[] | undefined;
    if (source.type === "registry") {
      const registryId = source.registry;
      const registry = registries(this.fetcher).find(r => r.id === registryId);
      if (!registry) throw pluginError(400, "unknown_registry");
      const resolved = await registry.resolve(source.id, source.version);
      resolvedSource = resolved.source;
      source = resolved.source;
      selectedSkills = resolved.skillPaths;
      name ??= resolved.name;
      description = resolved.description;
      remoteServers = resolved.servers;
    }
    let inspected;
    if (source.type === "url") {
      const url = checkMcpUrl(source.url, data.source.type === "registry" ? "public" : "private").href;
      inspected = { name: name ?? new URL(url).hostname, description, servers: remoteServers ?? [{ name: "remote", url, credential: "none" as const, personal: false, transport: "streamable-http" as const }], skills: [], ignored: [], storedBytes: 0 };
    } else {
      let bytes: Uint8Array;
      if (source.type === "git") {
        const repo = githubRepo(source.repo);
        if (repo.toLowerCase() === "anthropics/skills" && /(?:^|\/)(docx|pdf|pptx|xlsx)(?:\/|$)/.test(source.path ?? "")) throw pluginError(400, "proprietary_plugin");
        const files = await fetchGitFiles(this.fetcher, source, selectedSkills);
        inspected = inspectBundle(files, { path: source.path, skillPaths: selectedSkills });
      } else {
        if (!data.archive) throw pluginError(400, "archive_required");
        bytes = fromBase64(data.archive);
        if (await sha256(bytes) !== source.sha256) throw pluginError(400, "archive_hash_mismatch");
        inspected = inspectBundle(unpackArchive(bytes), { stripRoot: true });
      }
    }
    for (const server of inspected.servers) checkMcpUrl(server.url, data.source.type === "registry" ? "public" : "private");
    const plugin: Plugin = { id: crypto.randomUUID(), name: name ?? inspected.name, description: inspected.description || description,
      source: data.source, ...(resolvedSource ? { resolvedSource } : {}), skills: inspected.skills.map(s => ({ name: s.name, description: s.description })), servers: inspected.servers,
      ignored: inspected.ignored, enabled: true, createdAt: new Date().toISOString() };
    this.storage.transactionSync(() => {
      const groups = new Set(this.groups.list().map(group => group.id));
      if (data.groups.some(id => !groups.has(id))) throw pluginError(400, "invalid_group");
      const total = this.rows("select count(*) as n, coalesce(sum(stored_bytes),0) as bytes from plugin")[0];
      if (Number(total.n) >= IMPORT_LIMITS.plugins || Number(total.bytes) + inspected.storedBytes > IMPORT_LIMITS.totalStored) throw pluginError(413, "plugin_storage_limit");
      this.rows("insert into plugin(id,definition,skill_files,stored_bytes) values (?,?,?,?)", plugin.id, JSON.stringify(plugin), JSON.stringify(inspected.skills), inspected.storedBytes);
      for (const group of new Set(data.groups)) this.rows("insert into group_plugin(group_id,plugin_id) values (?,?)", group, plugin.id);
    });
    return json(plugin, 201);
  }

  async admin(req: Request, path: string): Promise<Response> {
    if (path === "/admin/plugins/search" && req.method === "GET") {
      const query = new URL(req.url).searchParams;
      const q = parse(z.string().max(200), query.get("q") ?? "");
      const kind = parse(z.enum(["mcp", "skill", "bundle"]).optional(), query.get("kind") ?? undefined);
      return json(await searchRegistries(registries(this.fetcher), q, kind));
    }
    if (path === "/admin/plugins" && req.method === "GET") return json({ plugins: this.list() });
    if (path === "/admin/plugins" && req.method === "POST") return this.install(req);
    const match = /^\/admin\/plugins\/([^/]+)(\/secret)?$/.exec(path);
    if (!match) return notFound();
    const plugin = this.get(match[1]);
    if (!plugin) return notFound();
    if (match[2] && req.method === "PUT") {
      const data = parse(z.object({ server: id, headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i), z.string().max(8192).refine(v => !/[\r\n\0]/.test(v))).nullable() }).strict(), await body(req));
      if (!plugin.servers.some(s => s.name === data.server && s.credential === "organization")) throw pluginError(400, "not_organization_server");
      if (data.headers === null) this.rows("delete from plugin_secret where plugin_id=? and server=?", plugin.id, data.server);
      else {
        if (!Object.keys(data.headers).length || Object.keys(data.headers).length > 20 || Object.keys(data.headers).some(k => ["host", "cookie", "content-length", "connection", "transfer-encoding"].includes(k.toLowerCase()))) throw pluginError(400, "invalid_secret_headers");
        const sealed = await this.cipher.seal(data.headers, JSON.stringify(["secret", plugin.id, data.server]));
        if (JSON.stringify(this.get(plugin.id)?.servers.find(s => s.name === data.server)) !== JSON.stringify(plugin.servers.find(s => s.name === data.server))) throw pluginError(409, "connection_not_allowed");
        this.rows("insert into plugin_secret(plugin_id,server,data) values (?,?,?) on conflict(plugin_id,server) do update set data=excluded.data", plugin.id, data.server, sealed);
      }
      return json({ ok: true });
    }
    if (match[2]) return notFound();
    if (req.method === "DELETE") { this.rows("delete from plugin where id=?", plugin.id); return json({ ok: true }); }
    if (req.method === "PATCH") {
      const patch: PluginPatch = parse(patchSchema, await body(req));
      const servers = patch.servers ? plugin.servers.map(server => ({ ...server, ...patch.servers!.find(p => p.name === server.name) })) : plugin.servers;
      if (patch.servers) {
        if (patch.servers.some(s => ["user-oauth", "login-identity"].includes(s.credential) && !s.personal)) throw pluginError(400, "personal_credential_required");
        if (new Set(patch.servers.map(s => s.name)).size !== patch.servers.length || patch.servers.some(s => !plugin.servers.some(p => p.name === s.name))) throw pluginError(400, "unknown_plugin_server");
        for (const server of servers) server.url = checkMcpUrl(server.url, plugin.source.type === "registry" ? "public" : "private").href;
      }
      const { servers: _servers, ...fields } = patch;
      this.storage.transactionSync(() => {
        for (const old of plugin.servers) if (JSON.stringify(old) !== JSON.stringify(servers.find(s => s.name === old.name))) {
          for (const table of ["plugin_secret", "plugin_oauth_client", "plugin_connection", "plugin_oauth_state"]) this.rows(`delete from ${table} where plugin_id=? and server=?`, plugin.id, old.name);
        }
        Object.assign(plugin, fields, { servers });
        this.rows("update plugin set definition=? where id=?", JSON.stringify(plugin), plugin.id);
      });
      return json(plugin);
    }
    return notFound();
  }

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
