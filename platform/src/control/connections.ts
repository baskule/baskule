import { serverFingerprint } from "../../../app/packages/contracts/src/baskule-plugin-formats";
import { catalogVendor } from "../../../app/packages/contracts/src/baskule-catalog";
import { serverNetwork } from "../shared/plugin-outbound";
import { z } from "zod";
import type { Account, Plugin, PluginServer, PluginCredential, PluginCredentialRequest } from "../../../app/packages/contracts/src/baskule-plugins";
import type { InstallationAuth } from "./auth-config";
import type { StorageLike } from "./service";
import type { Plugins } from "./plugins";
import { HttpError, pluginError, json, notFound, readJson } from "../shared/http";
import { type ConnectionCipher, digest, pkce, randomSecret } from "./connection-crypto";
import { discoverOAuth, exchangeToken, registerClient, type Discovery, type OAuthClient, type OAuthTokens } from "./connection-oauth";
import type { Fetcher } from "./plugin-source";

const TTL = 10 * 60_000;
const CALLBACK = "/api/baskule/plugins/oauth/callback";
const context = (id: string, userId: string, pluginId: string, server: string) => JSON.stringify(["connection", id, userId, pluginId, server]);
const labelSchema = z.string().trim().min(1).max(100).refine(label => !/[\x00-\x1f\x7f]/.test(label));
const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
interface User { id: string; email: string }
interface Pending {
  userId: string; pluginId: string; server: string; sessionId: string; config: string; origin: string; returnTo: string;
  target: { type: "new"; id: string; label: string } | { type: "reconnect"; id: string };
  setupData: string | null;
  oauth: { discovery: Discovery; client: OAuthClient; verifier: string; redirectUri: string; scopes: string[] };
  stateHash?: string;
}
interface Connection { config: string; oauth: { discovery: Discovery; client: OAuthClient; tokens: OAuthTokens } }
interface StoredAccount { id: string; server: string; label: string; isDefault: boolean; data: string }
type Refusal = Extract<PluginCredential, { error: unknown }>;
type Credential = Omit<Extract<PluginCredential, { headers: unknown }>, "expiresAt"> | Refusal;

export class Connections {
  onChange?: (userId: string | undefined) => void;
  private refreshes = new Map<string, Promise<Credential>>();
  constructor(private storage: StorageLike, private plugins: Plugins, private installation: InstallationAuth, private cipher: ConnectionCipher, private fetcher: Fetcher = fetch) {}
  private rows(q: string, ...p: unknown[]) { return this.storage.sql.exec(q, ...p).toArray(); }
  private allowed(userId: string, pluginId: string): Plugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !this.plugins.assigned(userId, pluginId)) throw pluginError(404, "not_found");
    return plugin;
  }
  private server(plugin: Plugin, name: string | null): PluginServer {
    const candidates = plugin.servers.filter(s => s.credential === "user-oauth");
    const server = name ? candidates.find(s => s.name === name) : candidates.length === 1 ? candidates[0] : undefined;
    if (!server) throw pluginError(400, "plugin_server_required");
    return server;
  }
  private records(userId: string, pluginId: string, server?: string): StoredAccount[] {
    return this.rows(`select id,server,label,is_default,data from plugin_connection where user_id=? and plugin_id=?${server === undefined ? "" : " and server=?"} order by is_default desc,created_at,id`, userId, pluginId, ...(server === undefined ? [] : [server])).map(row => ({
      id: row.id as string, server: row.server as string, label: row.label as string, isDefault: !!row.is_default, data: row.data as string,
    }));
  }
  private async save(value: Connection, pending: Pending) {
    const { userId, pluginId, server, target } = pending;
    const data = await this.cipher.seal(value, context(target.id, userId, pluginId, server));
    this.storage.transactionSync(() => {
      this.active(pending);
      if (target.type === "reconnect") this.rows("update plugin_connection set data=? where id=? and user_id=? and plugin_id=? and server=?", data, target.id, userId, pluginId, server);
      else {
        if (this.records(userId, pluginId, server).some(a => a.label === target.label)) throw pluginError(409, "account_label_taken");
        this.rows("insert into plugin_connection(id,user_id,plugin_id,server,label,is_default,data,created_at) select ?,?,?,?,?,not exists(select 1 from plugin_connection where user_id=? and plugin_id=? and server=?),?,?",
          target.id, userId, pluginId, server, target.label, userId, pluginId, server, data, Date.now());
      }
    });
    this.onChange?.(userId);
  }
  private async pending(pending: Pending): Promise<string> {
    const state = randomSecret();
    const hash = await digest(state);
    const data = await this.cipher.seal(pending, hash);
    this.storage.transactionSync(() => {
      this.rows("delete from plugin_oauth_state where expires_at<=?", Date.now());
      this.rows("insert into plugin_oauth_state(state_hash,user_id,plugin_id,server,data,expires_at) values (?,?,?,?,?,?)", hash, pending.userId, pending.pluginId, pending.server, data, Date.now() + TTL);
    });
    return state;
  }
  private async consume(state: string, userId: string, sessionId: string, origin: string): Promise<Pending> {
    if (!/^[\w-]{43}$/.test(state)) throw pluginError(400, "invalid_oauth_state");
    const hash = await digest(state);
    const row = this.rows("select data,expires_at from plugin_oauth_state where state_hash=? and user_id=? and consumed=0", hash, userId)[0];
    if (!row || Number(row.expires_at) <= Date.now()) throw pluginError(400, "invalid_oauth_state");
    const pending = await this.cipher.open<Pending>(row.data as string, hash);
    if (pending.sessionId !== sessionId || pending.origin !== origin) throw pluginError(400, "invalid_oauth_state");
    // Recheck after decryption yields: exactly one callback may consume the state.
    const consumed = this.rows("update plugin_oauth_state set consumed=1 where state_hash=? and data=? and consumed=0 returning state_hash", hash, row.data);
    if (!consumed.length) throw pluginError(400, "invalid_oauth_state");
    pending.stateHash = hash;
    return pending;
  }
  private active(pending: Pending): PluginServer {
    const plugin = this.allowed(pending.userId, pending.pluginId);
    const server = this.server(plugin, pending.server);
    if (!plugin.enabled || serverFingerprint(server) !== pending.config ||
      (this.rows("select data from vendor_setup where vendor=?", plugin.vendor)[0]?.data ?? null) !== pending.setupData ||
      !this.rows("select 1 from plugin_oauth_state where state_hash=? and consumed=1 and expires_at>?", pending.stateHash, Date.now()).length ||
      !this.rows("select 1 from session se join user u on u.id=se.user_id where se.id=? and se.user_id=? and se.expires_at>? and coalesce(u.banned,0)=0", pending.sessionId, pending.userId, Date.now()).length ||
      pending.target.type === "reconnect" && !this.records(pending.userId, pending.pluginId, pending.server).some(a => a.id === pending.target.id))
      throw pluginError(403, "connection_not_allowed");
    return server;
  }
  async accounts(userId: string, pluginId: string, server: PluginServer): Promise<Account[]> {
    return Promise.all(this.records(userId, pluginId, server.name).map(async row => {
      let status: Account["status"] = "reconnect";
      try {
        const connection = await this.cipher.open<Connection>(row.data, context(row.id, userId, pluginId, server.name));
        if (connection.config === serverFingerprint(server) && (connection.oauth.tokens.expiresAt === null || connection.oauth.tokens.expiresAt > Date.now() || connection.oauth.tokens.refreshToken)) status = "ready";
      } catch {}
      return { id: row.id, label: row.label, default: row.isDefault, status };
    }));
  }
  vendorConfigured(vendor: string): boolean {
    return !!this.rows("select 1 from vendor_setup where vendor=?", vendor).length;
  }
  async vendor(req: Request, vendor: string): Promise<Response> {
    const plugins = this.plugins.list().filter(p => p.vendor === vendor);
    if (!plugins.length) throw pluginError(404, "vendor_unknown");
    if (req.method !== "PUT") return notFound();
    const parsed = z.object({ clientId: z.string().min(1).max(4096), clientSecret: z.string().min(1).max(8192).optional(), tokenEndpointAuthMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]) }).strict().nullable().safeParse(await req.json().catch(() => { throw pluginError(400, "invalid_json"); }));
    if (!parsed.success) throw pluginError(400, "invalid_oauth_client");
    const client = parsed.data;
    if (client && (client.tokenEndpointAuthMethod !== "none") !== !!client.clientSecret) throw pluginError(400, "invalid_oauth_client");
    const servers = plugins.flatMap(p => p.servers).filter(s => s.credential === "user-oauth");
    if (client && !servers.length) throw pluginError(400, "not_oauth_server");
    const snapshot = JSON.stringify(plugins);
    const recipe = catalogVendor(vendor)?.signIn;
    const pin = recipe?.type === "account" && recipe.client === "static" ? recipe.issuer : undefined;
    const issuer = client ? (await discoverOAuth(servers[0].url, this.fetcher, serverNetwork(servers[0].url), pin, servers[0].oauth?.resourceUrl)).as.issuer : undefined;
    const data = client ? await this.cipher.seal({ ...client, issuer }, JSON.stringify(["vendor", vendor])) : null;
    this.storage.transactionSync(() => {
      if (snapshot !== JSON.stringify(this.plugins.list().filter(p => p.vendor === vendor))) throw pluginError(409, "connection_not_allowed");
      this.rows("delete from vendor_setup where vendor=?", vendor);
      if (data) this.rows("insert into vendor_setup(vendor,data) values (?,?)", vendor, data);
      for (const p of plugins) {
        this.rows("delete from plugin_connection where plugin_id=?", p.id);
        this.rows("delete from plugin_oauth_state where plugin_id=?", p.id);
      }
    });
    this.onChange?.(undefined);
    return json({ ok: true, configured: !!client });
  }
  async user(req: Request, path: string, user: User, sessionId: string): Promise<Response> {
    const url = new URL(req.url);
    if (path === "/plugins/oauth/callback" && req.method === "GET") return this.callback(req, user.id, sessionId);
    const connect = /^\/plugins\/([^/]+)\/connect$/.exec(path);
    if (connect && req.method === "GET") {
      try { return await this.connect(req, connect[1], user, sessionId); }
      catch (error) {
        const target = new URL("/settings/plugins", url.origin);
        target.searchParams.set("pluginConnection", "error");
        target.searchParams.set("connectionError", error instanceof HttpError ? error.code : "connection_failed");
        return redirect(target.href);
      }
    }
    const match = /^\/plugins\/([^/]+)\/accounts\/([^/]+)$/.exec(path);
    if (!match || !["PATCH", "DELETE"].includes(req.method)) return notFound();
    const plugin = this.allowed(user.id, match[1]);
    const row = this.records(user.id, plugin.id).find(a => a.id === match[2]);
    if (!row) throw pluginError(404, "account_not_found");
    if (req.method === "PATCH") {
      const parsed = z.object({ label: labelSchema.optional(), default: z.literal(true).optional() }).strict().refine(p => p.label !== undefined || p.default !== undefined).safeParse(await readJson(req));
      if (!parsed.success) throw pluginError(400, "invalid_plugin_input");
      this.storage.transactionSync(() => {
        if (!this.records(user.id, plugin.id, row.server).some(a => a.id === row.id)) throw pluginError(404, "account_not_found");
        if (parsed.data.label !== undefined) {
          if (this.records(user.id, plugin.id, row.server).some(a => a.id !== row.id && a.label === parsed.data.label)) throw pluginError(409, "account_label_taken");
          this.rows("update plugin_connection set label=? where id=?", parsed.data.label, row.id);
        }
        if (parsed.data.default) {
          this.rows("update plugin_connection set is_default=0 where user_id=? and plugin_id=? and server=?", user.id, plugin.id, row.server);
          this.rows("update plugin_connection set is_default=1 where id=?", row.id);
        }
      });
      if (parsed.data.default) this.onChange?.(user.id);
    } else {
      this.storage.transactionSync(() => {
        const accounts = this.records(user.id, plugin.id, row.server);
        const owned = accounts.find(a => a.id === row.id);
        if (!owned) throw pluginError(404, "account_not_found");
        if (owned.isDefault && accounts.length > 1) {
          const replacement = accounts.find(a => a.id === url.searchParams.get("default") && a.id !== row.id);
          if (!replacement) throw pluginError(409, "default_account_required");
          this.rows("delete from plugin_connection where id=?", row.id);
          this.rows("update plugin_connection set is_default=1 where id=?", replacement.id);
        } else this.rows("delete from plugin_connection where id=?", row.id);
      });
      this.onChange?.(user.id);
    }
    return json({ ok: true });
  }
  private async connect(req: Request, pluginId: string, user: User, sessionId: string): Promise<Response> {
    const u = new URL(req.url);
    const plugin = this.allowed(user.id, pluginId);
    if (this.installation.mode === "anonymous") throw pluginError(403, "connection_not_allowed");
    if (!plugin.enabled) throw pluginError(403, "connection_not_allowed");
    const server = this.server(plugin, u.searchParams.get("server"));
    const returnTo = new URL(u.searchParams.get("returnTo") ?? "/", u.origin);
    if (returnTo.origin !== u.origin || returnTo.username || returnTo.password) throw pluginError(400, "invalid_return_url");
    const reconnectId = u.searchParams.get("account");
    if (reconnectId && u.searchParams.has("label")) throw pluginError(400, "invalid_plugin_input");
    const existing = reconnectId ? this.records(user.id, plugin.id, server.name).find(a => a.id === reconnectId) : undefined;
    if (reconnectId && !existing) throw pluginError(404, "account_not_found");
    const label = labelSchema.safeParse(u.searchParams.get("label") ?? plugin.name.slice(0, 100));
    if (!label.success) throw pluginError(400, "invalid_plugin_input");
    if (!reconnectId && this.records(user.id, plugin.id, server.name).some(a => a.label === label.data)) throw pluginError(409, "account_label_taken");
    const target: Pending["target"] = existing ? { type: "reconnect", id: existing.id } : { type: "new", id: crypto.randomUUID(), label: label.data };
    const row = this.rows("select data from vendor_setup where vendor=?", plugin.vendor)[0];
    const setup = row ? await this.cipher.open<OAuthClient & { issuer: string }>(row.data as string, JSON.stringify(["vendor", plugin.vendor])) : undefined;
    if (server.oauth?.staticClient && !setup) throw pluginError(409, "oauth_client_configuration_required");
    const discovery = await discoverOAuth(server.url, this.fetcher, serverNetwork(server.url), setup?.issuer, server.oauth?.resourceUrl);
    const callback = `${u.origin}${CALLBACK}`;
    const client = setup ?? await registerClient(discovery, callback, this.fetcher);
    if (this.rows("select data from vendor_setup where vendor=?", plugin.vendor)[0]?.data !== row?.data) throw pluginError(409, "connection_not_allowed");
    if (discovery.as.token_endpoint_auth_methods_supported && !discovery.as.token_endpoint_auth_methods_supported.includes(client.tokenEndpointAuthMethod)) throw pluginError(409, "oauth_client_configuration_required");
    const proof = await pkce();
    const scopes = [...new Set([...(server.oauth?.scopes ?? discovery.scopes), ...(discovery.as.scopes_supported?.includes("offline_access") ? ["offline_access"] : [])])];
    const pending: Pending = { userId: user.id, pluginId: plugin.id, server: server.name, sessionId, config: serverFingerprint(server), origin: u.origin, returnTo: returnTo.href, target, setupData: row?.data as string | undefined ?? null,
      oauth: { discovery, client, verifier: proof.verifier, redirectUri: callback, scopes } };
    const state = await this.pending(pending);
    const authorization = new URL(discovery.as.authorization_endpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: client.clientId, redirect_uri: callback, state, code_challenge: proof.challenge, code_challenge_method: "S256", ...(server.oauth?.resource === false ? {} : { resource: discovery.resource }) })) authorization.searchParams.set(key, value);
    for (const [key, value] of Object.entries(server.oauth?.params ?? {})) {
      authorization.searchParams.set(key, value);
    }
    if (scopes.length) authorization.searchParams.set("scope", scopes.join(" "));
    return redirect(authorization.href);
  }
  private async callback(req: Request, userId: string, sessionId: string): Promise<Response> {
    const url = new URL(req.url);
    let pending: Pending;
    try { pending = await this.consume(url.searchParams.get("state") ?? "", userId, sessionId, url.origin); }
    catch { return redirect(`${url.origin}/settings/plugins?pluginConnection=error&connectionError=invalid_oauth_state`); }
    const target = new URL(pending.returnTo);
    target.searchParams.set("pluginId", pending.pluginId);
    target.searchParams.set("server", pending.server);
    try {
      const server = this.active(pending);
      const { discovery, client, verifier, redirectUri, scopes } = pending.oauth;
      const issuer = url.searchParams.get("iss");
      if ((discovery.as.authorization_response_iss_parameter_supported && !issuer) || (issuer !== null && issuer !== discovery.as.issuer)) throw pluginError(400, "oauth_issuer_mismatch");
      if (url.searchParams.has("error")) throw pluginError(400, "consent_denied");
      const code = url.searchParams.get("code");
      if (!code || code.length > 8192) throw pluginError(400, "invalid_oauth_code");
      const tokens = await exchangeToken(discovery, client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, scopes, this.fetcher, server.oauth);
      this.active(pending);
      if (!(server.oauth?.scopes ?? discovery.scopes).every(s => tokens.scopes.includes(s))) throw pluginError(400, "oauth_scope_missing");
      await this.save({ config: pending.config, oauth: { discovery, client, tokens } }, pending);
      target.searchParams.set("pluginConnection", "connected");
    } catch (error) {
      target.searchParams.set("pluginConnection", "error");
      target.searchParams.set("connectionError", error instanceof HttpError ? error.code : "connection_failed");
    }
    this.rows("delete from plugin_oauth_state where state_hash=?", pending.stateHash);
    return redirect(target.href);
  }
  private selected(input: PluginCredentialRequest): StoredAccount | Refusal {
    const policy = this.plugins.canUse(input.userId, input.spaceId, input.pluginId, input.server);
    if (!policy.allowed) return { error: policy.error };
    const plugin = this.plugins.get(input.pluginId)!;
    const server = plugin.servers.find(s => s.name === input.server)!;
    if (!this.plugins.setupDone(plugin, server)) return { error: "needs_setup" };
    const accounts = this.records(input.userId, input.pluginId, input.server);
    const first = accounts[0];
    if (!first) return { error: "connect" };
    const exact = accounts.find(a => a.label === input.account);
    const insensitive = input.account === undefined ? [] : accounts.filter(a => a.label.toLowerCase() === input.account!.toLowerCase());
    const chosen = input.account === undefined ? first : exact ?? (insensitive.length === 1 ? insensitive[0] : undefined);
    const team = this.rows("select kind from space where id=?", input.spaceId)[0]?.kind === "team";
    if (team && chosen?.id !== first.id) return { error: "default_account_required" };
    return chosen ?? { error: "unknown_account", accounts: accounts.map(a => a.label + (a.isDefault ? " (default)" : "")) };
  }
  async credential(input: PluginCredentialRequest): Promise<Credential> {
    const selected = this.selected(input);
    if ("error" in selected) return selected;
    const existing = this.refreshes.get(selected.id);
    if (existing) { await existing; return this.credential(input); }
    const work = this.resolve(input, selected);
    this.refreshes.set(selected.id, work);
    try { return await work; } finally { this.refreshes.delete(selected.id); }
  }
  private async resolve(input: PluginCredentialRequest, row: StoredAccount): Promise<Credential> {
    const { userId, pluginId, server: name } = input;
    const key = context(row.id, userId, pluginId, name);
    let liveData = row.data;
    const current = (): StoredAccount | Refusal => {
      const latest = this.selected(input);
      if ("error" in latest) return latest;
      return latest.id === row.id && latest.data === liveData ? latest : { error: "unavailable" };
    };
    try {
      const connection = await this.cipher.open<Connection>(row.data, key);
      const initial = current();
      if ("error" in initial) return initial;
      const server = this.plugins.get(pluginId)!.servers.find(s => s.name === name)!;
      if (connection.config !== serverFingerprint(server)) return { error: "reconnect" };
      if (connection.oauth.tokens.expiresAt !== null && connection.oauth.tokens.expiresAt <= Date.now() + 30_000) {
        if (!connection.oauth.tokens.refreshToken) return { error: "reconnect" };
        const tokens = await exchangeToken(connection.oauth.discovery, connection.oauth.client, { grant_type: "refresh_token", refresh_token: connection.oauth.tokens.refreshToken }, connection.oauth.tokens.scopes, this.fetcher, server.oauth);
        const refreshed = current();
        if ("error" in refreshed) return refreshed;
        if (!connection.oauth.tokens.scopes.filter(s => s !== "offline_access").every(s => tokens.scopes.includes(s))) return { error: "reconnect" };
        connection.oauth.tokens = { ...tokens, refreshToken: tokens.refreshToken ?? connection.oauth.tokens.refreshToken };
        const data = await this.cipher.seal(connection, key);
        const ready = current();
        if ("error" in ready) return ready;
        if (!this.rows("update plugin_connection set data=? where id=? and data=? returning id", data, row.id, liveData).length) return { error: "reconnect" };
        liveData = data;
      }
      const latest = current();
      if ("error" in latest) return latest;
      return { headers: { Authorization: `Bearer ${connection.oauth.tokens.accessToken}` }, account: { id: row.id, label: latest.label } };
    } catch (error) {
      if (error instanceof HttpError && error.code === "oauth_grant_expired") {
        const value = await this.cipher.open<Connection>(row.data, key);
        value.oauth.tokens.expiresAt = 0;
        delete value.oauth.tokens.refreshToken;
        const data = await this.cipher.seal(value, key);
        if (this.rows("update plugin_connection set data=? where id=? and data=? returning id", data, row.id, row.data).length) liveData = data;
      }
      const latest = current();
      return "error" in latest ? latest : { error: "reconnect" };
    }
  }
}
