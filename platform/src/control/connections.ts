import { z } from "zod";
import type { Plugin, PluginConnectionState, PluginServer } from "../../../app/packages/contracts/src/baskule-plugins";
import type { Auth } from "./auth";
import type { InstallationAuth } from "./auth-config";
import type { StorageLike } from "./service";
import type { Plugins } from "./plugins";
import { HttpError, json, notFound, readJson } from "../shared/http";
import { ConnectionCipher, digest, pkce, randomSecret } from "./connection-crypto";
import { canonicalResource, discoverOAuth, exchangeToken, registerClient, type Discovery, type OAuthClient, type OAuthTokens } from "./connection-oauth";
import type { Fetcher } from "./registries/http";

const TTL = 10 * 60_000;
const CALLBACK = "/api/baskule/plugins/oauth/callback";
const context = (userId: string, pluginId: string, server: string) => JSON.stringify([userId, pluginId, server]);
const fingerprint = (server: PluginServer) => JSON.stringify(server);
const redirect = (location: string, headers?: HeadersInit) => new Response(null, { status: 302, headers: { ...Object.fromEntries(new Headers(headers)), location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
interface User { id: string; email: string }
interface Pending {
  userId: string; pluginId: string; server: string; sessionId: string; config: string; origin: string; returnTo: string;
  oauth?: { discovery: Discovery; client: OAuthClient; verifier: string; redirectUri: string; scopes: string[] };
  accountId?: string;
  stateHash?: string;
}
interface Connection {
  config: string;
  oauth?: { discovery: Discovery; client: OAuthClient; tokens: OAuthTokens };
  accountId?: string;
}
export type CredentialRequest = { spaceId: string; pluginId: string; server: string; userId: string };
export type PluginCredential = { headers: Record<string, string> } | { error: "not_allowed" | "not_enabled" | "needs_connection"; connectUrl?: string };

/** A provider token may only go to that provider's MCP resource, never to a third-party wrapper. */
export function loginIdentityAudience(server: PluginServer): boolean {
  const identity = server.loginIdentity;
  if (!identity) return false;
  let u: URL;
  try { u = new URL(server.url); } catch { return false; }
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.search || u.hash) return false;
  if (identity.provider === "google") return /^[a-z0-9-]+\.googleapis\.com$/.test(u.hostname) && u.pathname === "/mcp" && identity.audience === canonicalResource(server.url);
  return u.origin === "https://workiq.svc.cloud.microsoft" && u.pathname === "/mcp" &&
    ["api://workiq.svc.cloud.microsoft", "fdcc1f02-fc51-4226-8753-f668596af7f7"].includes(identity.audience) &&
    identity.scopes.length > 0 && identity.scopes.every(s => s.startsWith("api://workiq.svc.cloud.microsoft/") || s.startsWith("fdcc1f02-fc51-4226-8753-f668596af7f7/"));
}

/** Tokens here came directly from Better Auth's configured provider; this checks their destination, not their signature. */
export function microsoftAudience(token: string, audience: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.aud === audience && typeof payload.exp === "number" && payload.exp * 1000 > Date.now();
  } catch { return false; }
}

export class Connections {
  private cipher: ConnectionCipher;
  private refreshes = new Map<string, Promise<PluginCredential>>();
  constructor(private storage: StorageLike, private plugins: Plugins, private auth: Auth, private installation: InstallationAuth, secret: string, private fetcher: Fetcher = fetch) {
    this.cipher = new ConnectionCipher(secret);
  }
  private rows(q: string, ...p: unknown[]) { return this.storage.sql.exec(q, ...p).toArray(); }
  private allowed(userId: string, pluginId: string): Plugin {
    const p = this.plugins.get(pluginId);
    if (!p || !this.rows("select 1 from group_plugin gp join permission_group g on g.id=gp.group_id left join group_member m on m.group_id=g.id and m.user_id=? where gp.plugin_id=? and (g.builtin='everyone' or m.user_id=?)", userId, pluginId, userId).length) throw new HttpError(404, "not_found");
    return p;
  }
  private server(plugin: Plugin, name: string | null): PluginServer {
    const candidates = plugin.servers.filter(s => ["user-oauth", "login-identity"].includes(s.credential));
    const server = name ? candidates.find(s => s.name === name) : candidates.length === 1 ? candidates[0] : undefined;
    if (!server) throw new HttpError(400, "plugin_server_required");
    return server;
  }
  private account(userId: string, provider: string) {
    const accounts = this.rows("select id,account_id,scope,refresh_token from account where user_id=? and provider_id=?", userId, provider);
    if (accounts.length !== 1) throw new HttpError(409, "login_account_required");
    return accounts[0];
  }
  private identity(server: PluginServer) {
    if (!loginIdentityAudience(server)) throw new HttpError(400, "login_identity_audience_refused");
    const identity = server.loginIdentity!;
    const provider = this.installation.providers.find(p => p.type === "social" && p.id === identity.provider);
    if (!provider) throw new HttpError(409, "login_provider_required");
    if (identity.provider === "microsoft" && (provider.options.disableDefaultScope !== true ||
      (Array.isArray(provider.options.scope) && provider.options.scope.some(s => typeof s !== "string" || !["openid", "email", "profile", "offline_access"].includes(s)))))
      throw new HttpError(409, "microsoft_identity_configuration_required");
    return identity;
  }
  private async save(userId: string, pluginId: string, server: string, value: Connection, pending: Pending) {
    const data = await this.cipher.seal(value, context(userId, pluginId, server));
    this.active(pending);
    this.rows("insert into plugin_connection(user_id,plugin_id,server,data) values (?,?,?,?) on conflict(user_id,plugin_id,server) do update set data=excluded.data", userId, pluginId, server, data);
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
    if (!/^[\w-]{43}$/.test(state)) throw new HttpError(400, "invalid_oauth_state");
    const hash = await digest(state);
    const row = this.rows("select data,expires_at from plugin_oauth_state where state_hash=? and user_id=? and consumed=0", hash, userId)[0];
    if (!row || Number(row.expires_at) <= Date.now()) throw new HttpError(400, "invalid_oauth_state");
    const pending = await this.cipher.open<Pending>(row.data as string, hash);
    if (pending.sessionId !== sessionId || pending.origin !== origin) throw new HttpError(400, "invalid_oauth_state");
    // Recheck after decryption yields: exactly one callback may consume the state.
    const consumed = this.rows("update plugin_oauth_state set consumed=1 where state_hash=? and data=? and consumed=0 returning state_hash", hash, row.data);
    if (!consumed.length) throw new HttpError(400, "invalid_oauth_state");
    pending.stateHash = hash;
    return pending;
  }
  private active(pending: Pending): PluginServer {
    const p = this.allowed(pending.userId, pending.pluginId);
    const s = this.server(p, pending.server);
    if (!this.rows("select 1 from plugin_oauth_state where state_hash=? and consumed=1 and expires_at>?", pending.stateHash, Date.now()).length || !p.enabled || fingerprint(s) !== pending.config || !this.rows("select 1 from session se join user u on u.id=se.user_id where se.id=? and se.user_id=? and se.expires_at>? and coalesce(u.banned,0)=0", pending.sessionId, pending.userId, Date.now()).length)
      throw new HttpError(403, "connection_not_allowed");
    return s;
  }
  async state(userId: string, pluginId: string, server: PluginServer): Promise<PluginConnectionState> {
    if (!["user-oauth", "login-identity"].includes(server.credential)) return "needs_connection";
    const row = this.row(userId, pluginId, server.name);
    if (!row) return "needs_connection";
    try {
      const c = await this.cipher.open<Connection>(row, context(userId, pluginId, server.name));
      if (c.config !== fingerprint(server)) return "needs_connection";
      if (c.oauth) return (c.oauth.tokens.expiresAt === null || c.oauth.tokens.expiresAt > Date.now()) || c.oauth.tokens.refreshToken ? "connected" : "needs_connection";
      const i = this.identity(server);
      const a = this.account(userId, i.provider);
      return a.id === c.accountId && a.refresh_token && i.scopes.every(s => String(a.scope ?? "").split(/[,\s]+/).includes(s)) ? "connected" : "needs_connection";
    } catch { return "needs_connection"; }
  }
  async admin(req: Request, pluginId: string): Promise<Response> {
    if (!this.plugins.get(pluginId)) return notFound();
    if (req.method !== "PUT") return notFound();
    const parsed = z.object({ server: z.string().max(200), client: z.object({ clientId: z.string().min(1).max(4096), clientSecret: z.string().min(1).max(8192).optional(), tokenEndpointAuthMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]).default("none") }).strict().nullable() }).strict().safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, "invalid_oauth_client");
    const { server, client } = parsed.data;
    if (!this.plugins.get(pluginId)!.servers.some(s => s.name === server && s.credential === "user-oauth")) throw new HttpError(400, "not_oauth_server");
    if (client && (client.tokenEndpointAuthMethod !== "none") !== !!client.clientSecret) throw new HttpError(400, "invalid_oauth_client");
    const data = client ? await this.cipher.seal(client, context("client", pluginId, server)) : null;
    this.storage.transactionSync(() => {
      this.rows("delete from plugin_oauth_client where plugin_id=? and server=?", pluginId, server);
      if (data) this.rows("insert into plugin_oauth_client(plugin_id,server,data) values (?,?,?)", pluginId, server, data);
      this.rows("delete from plugin_connection where plugin_id=? and server=?", pluginId, server);
      this.rows("delete from plugin_oauth_state where plugin_id=? and server=?", pluginId, server);
    });
    return json({ ok: true, configured: !!client });
  }
  async user(req: Request, path: string, user: User, sessionId: string): Promise<Response> {
    const u = new URL(req.url);
    if (path === "/plugins/oauth/callback" && req.method === "GET") return this.callback(req, user.id, sessionId);
    const match = /^\/plugins\/([^/]+)\/(connect|connection)$/.exec(path);
    if (!match) return notFound();
    const plugin = this.allowed(user.id, match[1]);
    if (match[2] === "connection" && req.method === "DELETE") {
      const name = u.searchParams.get("server");
      this.storage.transactionSync(() => {
        for (const s of plugin.servers.filter(s => name === null || s.name === name)) {
          this.rows("delete from plugin_connection where user_id=? and plugin_id=? and server=?", user.id, plugin.id, s.name);
          this.rows("delete from plugin_oauth_state where user_id=? and plugin_id=? and server=?", user.id, plugin.id, s.name);
        }
      });
      return json({ ok: true });
    }
    if (match[2] !== "connect" || req.method !== "GET") return notFound();
    if (this.installation.mode === "anonymous") throw new HttpError(403, "connection_not_allowed");
    if (!plugin.enabled) throw new HttpError(403, "not_enabled");
    const server = this.server(plugin, u.searchParams.get("server"));
    const returnTo = new URL(u.searchParams.get("returnTo") ?? "/", u.origin);
    if (returnTo.origin !== u.origin || returnTo.username || returnTo.password) throw new HttpError(400, "invalid_return_url");
    const pending: Pending = { userId: user.id, pluginId: plugin.id, server: server.name, sessionId, config: fingerprint(server), origin: u.origin, returnTo: returnTo.href };
    if (server.credential === "login-identity") {
      const identity = this.identity(server);
      const account = this.account(user.id, identity.provider);
      pending.accountId = account.id as string;
      const state = await this.pending(pending);
      const callback = `${u.origin}${CALLBACK}?state=${state}`;
      const response = await this.auth.api.linkSocialAccount({ headers: req.headers, body: {
        provider: identity.provider, callbackURL: callback, errorCallbackURL: callback + "&error=consent_denied", disableRedirect: true,
        scopes: [...new Set([...identity.scopes, ...(identity.provider === "microsoft" ? ["offline_access"] : [])])], loginHint: user.email,
        additionalParams: identity.provider === "google" ? { access_type: "offline", prompt: "consent", include_granted_scopes: "true" } : { prompt: "consent" },
      }, asResponse: true });
      const body = await response.json() as { url?: string };
      if (!response.ok || !body.url) throw new HttpError(502, "identity_consent_failed");
      // Preserve Better Auth's signed state cookies on the browser redirect.
      const result = redirect(body.url);
      for (const cookie of response.headers.getSetCookie()) result.headers.append("set-cookie", cookie);
      return result;
    }
    const discovery = await discoverOAuth(server.url, this.fetcher);
    const callback = `${u.origin}${CALLBACK}`;
    const row = this.rows("select data from plugin_oauth_client where plugin_id=? and server=?", plugin.id, server.name)[0];
    const client = row ? await this.cipher.open<OAuthClient>(row.data as string, context("client", plugin.id, server.name)) : await registerClient(discovery, callback, this.fetcher);
    if (discovery.as.token_endpoint_auth_methods_supported && !discovery.as.token_endpoint_auth_methods_supported.includes(client.tokenEndpointAuthMethod)) throw new HttpError(409, "oauth_client_configuration_required");
    const proof = await pkce();
    const scopes = [...new Set([...(server.oauth?.scopes ?? discovery.scopes), ...(discovery.as.scopes_supported?.includes("offline_access") ? ["offline_access"] : [])])];
    pending.oauth = { discovery, client, verifier: proof.verifier, redirectUri: callback, scopes };
    const state = await this.pending(pending);
    const authorization = new URL(discovery.as.authorization_endpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: client.clientId, redirect_uri: callback, state, code_challenge: proof.challenge, code_challenge_method: "S256", resource: discovery.resource })) authorization.searchParams.set(key, value);
    if (scopes.length) authorization.searchParams.set("scope", scopes.join(" "));
    return redirect(authorization.href);
  }
  private async callback(req: Request, userId: string, sessionId: string): Promise<Response> {
    const u = new URL(req.url);
    const pending = await this.consume(u.searchParams.get("state") ?? "", userId, sessionId, u.origin);
    const target = new URL(pending.returnTo);
    target.searchParams.set("pluginId", pending.pluginId);
    target.searchParams.set("server", pending.server);
    try {
      const server = this.active(pending);
      if (pending.oauth) {
        const { discovery, client, verifier, redirectUri, scopes } = pending.oauth;
        const issuer = u.searchParams.get("iss");
        if ((discovery.as.authorization_response_iss_parameter_supported && !issuer) || (issuer !== null && issuer !== discovery.as.issuer)) throw new HttpError(400, "oauth_issuer_mismatch");
        if (u.searchParams.has("error")) throw new HttpError(400, "consent_denied");
        const code = u.searchParams.get("code");
        if (!code || code.length > 8192) throw new HttpError(400, "invalid_oauth_code");
        const tokens = await exchangeToken(discovery, client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, scopes, this.fetcher);
        this.active(pending);
        if (!(server.oauth?.scopes ?? discovery.scopes).every(s => tokens.scopes.includes(s))) throw new HttpError(400, "oauth_scope_missing");
        await this.save(userId, pending.pluginId, pending.server, { config: pending.config, oauth: { discovery, client, tokens } }, pending);
      } else {
        if (u.searchParams.has("error")) throw new HttpError(400, "consent_denied");
        const identity = this.identity(server);
        const account = this.account(userId, identity.provider);
        if (account.id !== pending.accountId || !account.refresh_token || !identity.scopes.every(s => String(account.scope ?? "").split(/[,\s]+/).includes(s))) throw new HttpError(400, "identity_scope_missing");
        await this.save(userId, pending.pluginId, pending.server, { config: pending.config, accountId: pending.accountId }, pending);
      }
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
    const needs: PluginCredential = { error: "needs_connection", connectUrl: `/api/baskule/plugins/${encodeURIComponent(pluginId)}/connect?server=${encodeURIComponent(name)}` };
    const row = this.row(userId, pluginId, name);
    if (!row || !["user-oauth", "login-identity"].includes(server.credential)) return needs;
    if (server.credential === "login-identity" && !loginIdentityAudience(server)) return { error: "not_allowed" };
    try {
      const c = await this.cipher.open<Connection>(row, context(userId, pluginId, name));
      if (c.config !== fingerprint(server)) return needs;
      let token: string;
      let liveData = row;
      if (c.oauth && server.credential === "user-oauth") {
        if (c.oauth.tokens.expiresAt !== null && c.oauth.tokens.expiresAt <= Date.now() + 30_000) {
          if (!c.oauth.tokens.refreshToken) return needs;
          const tokens = await exchangeToken(c.oauth.discovery, c.oauth.client, { grant_type: "refresh_token", refresh_token: c.oauth.tokens.refreshToken }, c.oauth.tokens.scopes, this.fetcher);
          if (!c.oauth.tokens.scopes.filter(s => s !== "offline_access").every(s => tokens.scopes.includes(s))) return needs;
          c.oauth.tokens = { ...tokens, refreshToken: tokens.refreshToken ?? c.oauth.tokens.refreshToken };
          const data = await this.cipher.seal(c, context(userId, pluginId, name));
          if (!this.rows("update plugin_connection set data=? where user_id=? and plugin_id=? and server=? and data=? returning data", data, userId, pluginId, name, row).length) return needs;
          liveData = data;
        }
        token = c.oauth.tokens.accessToken;
      } else if (server.credential === "login-identity" && c.accountId) {
        const identity = this.identity(server);
        const account = this.account(userId, identity.provider);
        if (account.id !== c.accountId || !account.refresh_token) return needs;
        const tokens = await this.auth.api.getAccessToken({ body: { userId, accountId: c.accountId } });
        if (!tokens.accessToken || !identity.scopes.every(s => tokens.scopes.includes(s)) || (tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt.getTime() <= Date.now())) return needs;
        if (identity.provider === "microsoft" && !microsoftAudience(tokens.accessToken, identity.audience)) return { error: "not_allowed" };
        token = tokens.accessToken;
      } else return needs;
      const policy = this.plugins.canUse(userId, input.spaceId, pluginId, name);
      if (!policy.allowed) return { error: policy.error };
      if (this.row(userId, pluginId, name) !== liveData || fingerprint(this.plugins.get(pluginId)!.servers.find(s => s.name === name)!) !== c.config) return needs;
      if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) return needs;
      return { headers: { Authorization: `Bearer ${token}` } };
    } catch (error) {
      if (error instanceof HttpError && error.code === "oauth_grant_expired") this.rows("delete from plugin_connection where user_id=? and plugin_id=? and server=? and data=?", userId, pluginId, name, row);
      return needs;
    }
  }
}

/** P2's user-oauth/login-identity switch cases call this; it always rechecks P1 policy. */
export const resolveAccountCredential = (connections: Connections, input: CredentialRequest) => connections.credential(input);
