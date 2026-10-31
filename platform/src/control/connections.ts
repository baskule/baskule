import { serverNetwork } from "../shared/plugin-outbound";
import { z } from "zod";
import type { Plugin, PluginStatus, PluginServer } from "../../../app/packages/contracts/src/baskule-plugins";
import type { InstallationAuth } from "./auth-config";
import type { StorageLike } from "./service";
import type { Plugins } from "./plugins";
import { HttpError, pluginError, json, notFound } from "../shared/http";
import { type ConnectionCipher, digest, pkce, randomSecret } from "./connection-crypto";
import { discoverOAuth, exchangeToken, registerClient, type Discovery, type OAuthClient, type OAuthTokens } from "./connection-oauth";
import type { Fetcher } from "./registries/http";

const TTL = 10 * 60_000;
const CALLBACK = "/api/baskule/plugins/oauth/callback";
const context = (userId: string, pluginId: string, server: string) => JSON.stringify([userId, pluginId, server]);
const fingerprint = (server: PluginServer) => JSON.stringify(server);
const redirect = (location: string, headers?: HeadersInit) => new Response(null, { status: 302, headers: { ...Object.fromEntries(new Headers(headers)), location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
interface User { id: string; email: string }
interface Pending {
  userId: string; pluginId: string; server: string; sessionId: string; config: string; origin: string; returnTo: string;
  oauth: { discovery: Discovery; client: OAuthClient; verifier: string; redirectUri: string; scopes: string[] };
  stateHash?: string;
}
interface Connection {
  config: string;
  oauth: { discovery: Discovery; client: OAuthClient; tokens: OAuthTokens };
}
export type CredentialRequest = { spaceId: string; pluginId: string; server: string; userId: string };
export type PluginCredential = { headers: Record<string, string> } | { error: Exclude<PluginStatus, "ready"> };

export class Connections {
  onChange?: (userId: string | undefined) => void;
  private refreshes = new Map<string, Promise<PluginCredential>>();
  constructor(private storage: StorageLike, private plugins: Plugins, private installation: InstallationAuth, private cipher: ConnectionCipher, private fetcher: Fetcher = fetch) {}
  private rows(q: string, ...p: unknown[]) { return this.storage.sql.exec(q, ...p).toArray(); }
  private allowed(userId: string, pluginId: string): Plugin {
    const p = this.plugins.get(pluginId);
    if (!p || !this.plugins.assigned(userId, pluginId)) throw pluginError(404, "not_found");
    return p;
  }
  private server(plugin: Plugin, name: string | null): PluginServer {
    const candidates = plugin.servers.filter(s => s.credential === "user-oauth");
    const server = name ? candidates.find(s => s.name === name) : candidates.length === 1 ? candidates[0] : undefined;
    if (!server) throw pluginError(400, "plugin_server_required");
    return server;
  }
  private async save(userId: string, pluginId: string, server: string, value: Connection, pending: Pending) {
    const data = await this.cipher.seal(value, context(userId, pluginId, server));
    this.active(pending);
    this.rows("insert into plugin_connection(user_id,plugin_id,server,data) values (?,?,?,?) on conflict(user_id,plugin_id,server) do update set data=excluded.data", userId, pluginId, server, data);
    this.onChange?.(userId);
  }
  private row(userId: string, pluginId: string, server: string) {
    return this.rows("select data from plugin_connection where user_id=? and plugin_id=? and server=?", userId, pluginId, server)[0]?.data as string | undefined;
  }
  private async pending(pending: Pending): Promise<string> {
    const state = randomSecret();
    const hash = await digest(state);
    const data = await this.cipher.seal(pending, hash);
    this.storage.transactionSync(() => {
      this.rows("delete from plugin_oauth_state where expires_at<=? or (user_id=? and plugin_id=? and server=?)", Date.now(), pending.userId, pending.pluginId, pending.server);
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
    const p = this.allowed(pending.userId, pending.pluginId);
    const s = this.server(p, pending.server);
    if (!this.rows("select 1 from plugin_oauth_state where state_hash=? and consumed=1 and expires_at>?", pending.stateHash, Date.now()).length || !p.enabled || fingerprint(s) !== pending.config || !this.rows("select 1 from session se join user u on u.id=se.user_id where se.id=? and se.user_id=? and se.expires_at>? and coalesce(u.banned,0)=0", pending.sessionId, pending.userId, Date.now()).length)
      throw pluginError(403, "connection_not_allowed");
    return s;
  }
  async state(userId: string, pluginId: string, server: PluginServer): Promise<"connect" | "reconnect" | "ready"> {
    const row = this.row(userId, pluginId, server.name);
    if (!row) return "connect";
    try {
      const c = await this.cipher.open<Connection>(row, context(userId, pluginId, server.name));
      if (c.config !== fingerprint(server)) return "reconnect";
      return (c.oauth.tokens.expiresAt === null || c.oauth.tokens.expiresAt > Date.now()) || c.oauth.tokens.refreshToken ? "ready" : "reconnect";
    } catch { return "reconnect"; }
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
    const issuer = client ? (await discoverOAuth(servers[0].url, this.fetcher, serverNetwork(servers[0].url))).as.issuer : undefined;
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
    const u = new URL(req.url);
    if (path === "/plugins/oauth/callback" && req.method === "GET") return this.callback(req, user.id, sessionId);
    const match = /^\/plugins\/([^/]+)\/(connect|connection)$/.exec(path);
    if (!match) return notFound();
    if (match[2] === "connect" && req.method === "GET") {
      try { return await this.connect(req, match[1], user, sessionId); }
      catch (error) {
        const target = new URL("/settings/plugins", u.origin);
        target.searchParams.set("pluginConnection", "error");
        target.searchParams.set("connectionError", error instanceof HttpError ? error.code : "connection_failed");
        return redirect(target.href);
      }
    }
    const plugin = this.allowed(user.id, match[1]);
    if (match[2] === "connection" && req.method === "DELETE") {
      const name = u.searchParams.get("server");
      this.storage.transactionSync(() => {
        for (const s of plugin.servers.filter(s => name === null || s.name === name)) {
          this.rows("delete from plugin_connection where user_id=? and plugin_id=? and server=?", user.id, plugin.id, s.name);
          this.rows("delete from plugin_oauth_state where user_id=? and plugin_id=? and server=?", user.id, plugin.id, s.name);
        }
      });
      this.onChange?.(user.id);
      return json({ ok: true });
    }
    return notFound();
  }
  private async connect(req: Request, pluginId: string, user: User, sessionId: string): Promise<Response> {
    const u = new URL(req.url);
    const plugin = this.allowed(user.id, pluginId);
    if (this.installation.mode === "anonymous") throw pluginError(403, "connection_not_allowed");
    if (!plugin.enabled) throw pluginError(403, "connection_not_allowed");
    const server = this.server(plugin, u.searchParams.get("server"));
    const returnTo = new URL(u.searchParams.get("returnTo") ?? "/", u.origin);
    if (returnTo.origin !== u.origin || returnTo.username || returnTo.password) throw pluginError(400, "invalid_return_url");
    const row = this.rows("select data from vendor_setup where vendor=?", plugin.vendor)[0];
    const setup = row ? await this.cipher.open<OAuthClient & { issuer: string }>(row.data as string, JSON.stringify(["vendor", plugin.vendor])) : undefined;
    if (server.oauth?.staticClient && !setup) throw pluginError(409, "oauth_client_configuration_required");
    const discovery = await discoverOAuth(server.url, this.fetcher, serverNetwork(server.url), setup?.issuer);
    const callback = `${u.origin}${CALLBACK}`;
    const client = setup ?? await registerClient(discovery, callback, this.fetcher);
    if (this.rows("select data from vendor_setup where vendor=?", plugin.vendor)[0]?.data !== row?.data) throw pluginError(409, "connection_not_allowed");
    if (discovery.as.token_endpoint_auth_methods_supported && !discovery.as.token_endpoint_auth_methods_supported.includes(client.tokenEndpointAuthMethod)) throw pluginError(409, "oauth_client_configuration_required");
    const proof = await pkce();
    const scopes = [...new Set([...(server.oauth?.scopes ?? discovery.scopes), ...(discovery.as.scopes_supported?.includes("offline_access") ? ["offline_access"] : [])])];
    const pending: Pending = { userId: user.id, pluginId: plugin.id, server: server.name, sessionId, config: fingerprint(server), origin: u.origin, returnTo: returnTo.href,
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
    const u = new URL(req.url);
    let pending: Pending;
    try { pending = await this.consume(u.searchParams.get("state") ?? "", userId, sessionId, u.origin); }
    catch { return redirect(`${u.origin}/settings/plugins?pluginConnection=error&connectionError=invalid_oauth_state`); }
    const target = new URL(pending.returnTo);
    target.searchParams.set("pluginId", pending.pluginId);
    target.searchParams.set("server", pending.server);
    try {
      const server = this.active(pending);
        const { discovery, client, verifier, redirectUri, scopes } = pending.oauth;
        const issuer = u.searchParams.get("iss");
        if ((discovery.as.authorization_response_iss_parameter_supported && !issuer) || (issuer !== null && issuer !== discovery.as.issuer)) throw pluginError(400, "oauth_issuer_mismatch");
        if (u.searchParams.has("error")) throw pluginError(400, "consent_denied");
        const code = u.searchParams.get("code");
        if (!code || code.length > 8192) throw pluginError(400, "invalid_oauth_code");
        const tokens = await exchangeToken(discovery, client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, scopes, this.fetcher, server.oauth);
        this.active(pending);
        if (!(server.oauth?.scopes ?? discovery.scopes).every(s => tokens.scopes.includes(s))) throw pluginError(400, "oauth_scope_missing");
        await this.save(userId, pending.pluginId, pending.server, { config: pending.config, oauth: { discovery, client, tokens } }, pending);
      target.searchParams.set("pluginConnection", "connected");
    } catch (error) {
      target.searchParams.set("pluginConnection", "error");
      target.searchParams.set("connectionError", error instanceof HttpError ? error.code : "connection_failed");
    }
    this.rows("delete from plugin_oauth_state where state_hash=?", pending.stateHash);
    return redirect(target.href);
  }
  async credential(input: CredentialRequest): Promise<PluginCredential> {
    const policy = this.plugins.canUse(input.userId, input.spaceId, input.pluginId, input.server);
    if (!policy.allowed) return { error: policy.error };
    const key = context(input.userId, input.pluginId, input.server);
    const existing = this.refreshes.get(key);
    if (existing) {
      await existing;
      return this.credential(input);
    }
    const work = this.resolve(input);
    this.refreshes.set(key, work);
    try { return await work; } finally { this.refreshes.delete(key); }
  }
  private async resolve(input: CredentialRequest): Promise<PluginCredential> {
    const { userId, pluginId, server: name } = input;
    const server = this.plugins.get(pluginId)!.servers.find(s => s.name === name)!;
    if (!this.plugins.setupDone(this.plugins.get(pluginId)!, server)) return { error: "needs_setup" };
    const row = this.row(userId, pluginId, name);
    const needs = (): PluginCredential => ({ error: this.row(userId, pluginId, name) ? "reconnect" : "connect" });
    if (!row || server.credential !== "user-oauth") return needs();
    try {
      const c = await this.cipher.open<Connection>(row, context(userId, pluginId, name));
      if (c.config !== fingerprint(server)) return needs();
      let token: string;
      let liveData = row;
      {
        if (c.oauth.tokens.expiresAt !== null && c.oauth.tokens.expiresAt <= Date.now() + 30_000) {
          if (!c.oauth.tokens.refreshToken) return needs();
          const tokens = await exchangeToken(c.oauth.discovery, c.oauth.client, { grant_type: "refresh_token", refresh_token: c.oauth.tokens.refreshToken }, c.oauth.tokens.scopes, this.fetcher, server.oauth);
          if (!c.oauth.tokens.scopes.filter(s => s !== "offline_access").every(s => tokens.scopes.includes(s))) return needs();
          c.oauth.tokens = { ...tokens, refreshToken: tokens.refreshToken ?? c.oauth.tokens.refreshToken };
          const data = await this.cipher.seal(c, context(userId, pluginId, name));
          if (!this.rows("update plugin_connection set data=? where user_id=? and plugin_id=? and server=? and data=? returning data", data, userId, pluginId, name, row).length) return needs();
          liveData = data;
        }
        token = c.oauth.tokens.accessToken;
      }
      const policy = this.plugins.canUse(userId, input.spaceId, pluginId, name);
      if (!policy.allowed) return { error: policy.error };
      if (this.row(userId, pluginId, name) !== liveData || fingerprint(this.plugins.get(pluginId)!.servers.find(s => s.name === name)!) !== c.config) return needs();
      if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) return needs();
      return { headers: { Authorization: `Bearer ${token}` } };
    } catch (error) {
      if (error instanceof HttpError && error.code === "oauth_grant_expired") {
        const value = await this.cipher.open<Connection>(row, context(userId, pluginId, name));
          value.oauth.tokens.expiresAt = 0;
          delete value.oauth.tokens.refreshToken;
          const data = await this.cipher.seal(value, context(userId, pluginId, name));
          this.rows("update plugin_connection set data=? where user_id=? and plugin_id=? and server=? and data=?", data, userId, pluginId, name, row);
      }
      return needs();
    }
  }
}
