import { ISSUER_DEFAULT_PARAMS, type MemberPluginList, type PluginCallError, type PluginCredential, type PluginCredentialRequest, type ProviderId, type SpacePlugins } from "../../../../app/packages/contracts/src/baskule-plugins";
import { HttpError, pluginError } from "../../shared/http";
import { checkMcpUrl, serverNetwork, type Network } from "../../shared/plugin-outbound";
import { digest, pkce, randomSecret } from "../connection-crypto";
import { authorizationUrl, clientMethod, discover, exchangeToken, issuerKey, parseAuthorizationParams, registerClient, requestedScopes, TokenError, type OAuthClient, type Tokens } from "./oauth";
import { callDecision, callMessage, fill, memberConnection, type StoredServer } from "./state";
import { CALLBACK_PATH, PROVIDER_CALLBACK_PATH, type PluginRow, type PluginStore } from "./store";

const PENDING_TTL = 10 * 60_000;
const REFRESH_SKEW = 60_000;

type Client = OAuthClient & { admin?: true };
type Token = { token: string } | { error: PluginCallError };
type ConnectionData =
  | { kind: "oauth"; url: string; issuer: string; tokenEndpoint: string; resource: string | null; client: Client; tokens: Tokens }
  | { kind: "provider"; provider: ProviderId; app: string; account: string };
interface Pending {
  userId: string; sessionId: string; origin: string; pluginId: string; serverId: string; url: string; returnTo: string;
  oauth?: { issuer: string; tokenEndpoint: string; resource: string | null; client: Client; verifier: string; redirectUri: string; scopes: string[]; issParameter: boolean };
  provider?: { provider: ProviderId; app: string; ref: string | null };
}

export const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
const networkOf = (plugin: PluginRow, url: string): Network => plugin.def.origin.kind === "custom" ? serverNetwork(url) : "public";

export class PluginConnections {
  private refreshes = new Map<string, Promise<Token>>();
  constructor(private store: PluginStore, private changed: (userId: string | null) => Promise<void>, private anonymous = false) {}

  private accessible(userId: string, pluginId: string, serverId?: string): { plugin: PluginRow; server: StoredServer | undefined } {
    const plugin = this.store.get(pluginId);
    if (!plugin || !this.store.hasAccess(userId, plugin)) throw pluginError(404, "plugin_not_found");
    const server = serverId === undefined ? undefined : plugin.def.servers.find(s => s.id === serverId);
    if (serverId !== undefined && !server) throw pluginError(404, "server_not_found");
    return { plugin, server };
  }

  async list(userId: string): Promise<MemberPluginList> {
    const facts = await this.store.facts();
    return { plugins: this.store.list().filter(plugin => this.store.hasAccess(userId, plugin)).map(plugin => ({
      id: plugin.id, displayName: plugin.def.displayName, description: plugin.def.description, logo: plugin.def.logo, category: plugin.def.category,
      on: this.store.isOn(userId, plugin.id), enabled: plugin.enabled, skillCount: plugin.def.skills.length,
      servers: plugin.def.servers.map(server => ({ id: server.id, name: server.name,
        connection: memberConnection(server.auth, this.store.setup(plugin, server, facts), this.store.connection(userId, plugin.id, server.id)) })),
    })) };
  }

  async setOn(userId: string, pluginId: string, on: boolean) {
    this.accessible(userId, pluginId);
    this.store.rows("insert into member_plugin(user_id,plugin_id,\"on\") values (?,?,?) on conflict(user_id,plugin_id) do update set \"on\"=excluded.\"on\"", userId, pluginId, Number(on));
    await this.changed(userId);
  }

  private async values(plugin: PluginRow, server: StoredServer) {
    const values = await this.store.values(plugin.id, server.id);
    return { url: fill(server.url, values), headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, fill(value, values)])) };
  }

  /** Starts a member's sign-in; every failure returns to the page that asked, with a code. */
  async connect(url: URL, user: { id: string }, sessionId: string, pluginId: string, serverId: string): Promise<Response> {
    const back = new URL(url.searchParams.get("returnTo") || "/settings/plugins", url.origin);
    if (back.origin !== url.origin || back.username || back.password) return redirect(this.result(new URL("/settings/plugins", url.origin), pluginId, "invalid_request"));
    try {
      // Without sign-in everyone reaching the installation is the same person; their accounts would be shared.
      if (this.anonymous) return redirect(this.result(back, pluginId, "not_allowed"));
      const { plugin, server } = this.accessible(user.id, pluginId, serverId);
      if (!plugin.enabled) return redirect(this.result(back, pluginId, "plugin_off"));
      const setup = this.store.setup(plugin, server!, await this.store.facts());
      if (setup.state !== "ready") return redirect(this.result(back, pluginId, "setup_incomplete"));
      const { url: target } = await this.values(plugin, server!);
      const base = { userId: user.id, sessionId, origin: url.origin, pluginId, serverId, url: target, returnTo: back.href };
      if (server!.auth.kind === "provider") {
        const client = await this.store.provider(server!.auth.provider);
        if (!client) throw pluginError(409, "provider_not_configured");
        const state = randomSecret();
        const start = await client.connect(user.id, server!.auth.app, `${url.origin}${PROVIDER_CALLBACK_PATH}?state=${state}`);
        await this.pending(state, { ...base, provider: { provider: server!.auth.provider, app: server!.auth.app, ref: start.ref } });
        return redirect(start.url);
      }
      if (server!.auth.kind !== "oauth") throw pluginError(400, "invalid_request");
      const network = networkOf(plugin, target);
      const discovery = await discover(this.store.fetcher, target, server!.transport, network, server!.auth.issuer);
      const issuer = discovery.server.issuer;
      const admin = await this.store.oauthClient(issuer);
      const registration = discovery.server.registration_endpoint ? "dynamic" as const : "client" as const;
      if (server!.auth.issuer !== issuer || server!.auth.registration !== registration) await this.learned(plugin.id, server!.id, issuer, registration);
      if (!admin && registration === "client") throw pluginError(409, "oauth_client_required");
      const redirectUri = `${url.origin}${CALLBACK_PATH}`;
      const client: Client = admin ? { clientId: admin.clientId, method: clientMethod(discovery.server, !!admin.clientSecret), admin: true }
        : await registerClient(this.store.fetcher, discovery, redirectUri, network);
      const params = parseAuthorizationParams(admin?.authorizationParams ?? ISSUER_DEFAULT_PARAMS[issuer] ?? "") ?? new URLSearchParams();
      const scopes = requestedScopes(discovery, admin?.scopes ?? null);
      const proof = await pkce();
      const state = randomSecret();
      await this.pending(state, { ...base, oauth: { issuer, tokenEndpoint: discovery.server.token_endpoint, resource: discovery.resource, client, verifier: proof.verifier,
        redirectUri, scopes, issParameter: !!discovery.server.authorization_response_iss_parameter_supported } });
      return redirect(authorizationUrl({ discovery, clientId: client.clientId, redirectUri, state, challenge: proof.challenge, scopes, params }));
    } catch (error) {
      return redirect(this.result(back, pluginId, error instanceof HttpError ? error.code : "oauth_failed"));
    }
  }

  /** Sign-in taught us the issuer or that it refuses registration: record it so setup shows what is missing. */
  private async learned(pluginId: string, serverId: string, issuer: string, registration: "dynamic" | "client") {
    const plugin = this.store.get(pluginId)!;
    const def = structuredClone(plugin.def);
    const server = def.servers.find(s => s.id === serverId)!;
    server.auth = { kind: "oauth", issuer, registration };
    this.store.saveDefinition(pluginId, def);
    if (registration === "client" && !await this.store.oauthClient(issuer)) await this.changed(null);
  }

  private result(target: URL, pluginId: string, code: string | null) {
    if (pluginId) target.searchParams.set("plugin", pluginId);
    target.searchParams.set("connection", code ? "error" : "connected");
    if (code) target.searchParams.set("code", code);
    return target.href;
  }

  private async pending(state: string, pending: Pending) {
    const hash = await digest(state);
    const data = await this.store.cipher.seal(pending, hash);
    this.store.storage.transactionSync(() => {
      this.store.rows("delete from plugin_oauth_state where expires_at<=?", Date.now());
      this.store.rows("insert into plugin_oauth_state(state_hash,user_id,plugin_id,server_id,data,expires_at) values (?,?,?,?,?,?)",
        hash, pending.userId, pending.pluginId, pending.serverId, data, Date.now() + PENDING_TTL);
    });
  }

  /** Exactly one callback consumes a state, and only in the session and origin that started it. */
  private async consume(state: string | null, userId: string, sessionId: string, origin: string): Promise<Pending | null> {
    if (!state || !/^[\w-]{43}$/.test(state)) return null;
    const hash = await digest(state);
    const row = this.store.rows("select data from plugin_oauth_state where state_hash=? and user_id=? and consumed=0 and expires_at>?", hash, userId, Date.now())[0];
    if (!row) return null;
    const pending = await this.store.cipher.open<Pending>(row.data as string, hash);
    if (pending.sessionId !== sessionId || pending.origin !== origin) return null;
    if (!this.store.rows("update plugin_oauth_state set consumed=1 where state_hash=? and consumed=0 returning state_hash", hash).length) return null;
    this.store.rows("delete from plugin_oauth_state where state_hash=?", hash);
    return pending;
  }

  /** The member may still use this server at the address the sign-in started with. */
  private async stillAllowed(pending: Pending) {
    const { plugin, server } = this.accessible(pending.userId, pending.pluginId, pending.serverId);
    if (!plugin.enabled || (await this.values(plugin, server!)).url !== pending.url) throw pluginError(409, "plugin_changed");
    if (!this.store.rows("select 1 from session se join user u on u.id=se.user_id where se.id=? and se.user_id=? and se.expires_at>? and coalesce(u.banned,0)=0",
      pending.sessionId, pending.userId, Date.now()).length) throw pluginError(403, "invalid_request");
    return { plugin, server: server! };
  }

  private async save(pending: Pending, data: ConnectionData, account: string | null) {
    const sealed = await this.store.cipher.seal(data, this.store.connectionContext(pending.userId, pending.pluginId, pending.serverId));
    await this.stillAllowed(pending);
    this.store.rows(`insert into plugin_connection(user_id,plugin_id,server_id,data,account,connected_at,state) values (?,?,?,?,?,?,'connected')
      on conflict(user_id,plugin_id,server_id) do update set data=excluded.data,account=excluded.account,connected_at=excluded.connected_at,state='connected'`,
      pending.userId, pending.pluginId, pending.serverId, sealed, account, Date.now());
    await this.changed(pending.userId);
  }

  async oauthCallback(url: URL, userId: string, sessionId: string): Promise<Response> {
    const pending = await this.consume(url.searchParams.get("state"), userId, sessionId, url.origin);
    if (!pending?.oauth) return redirect(this.result(new URL("/settings/plugins", url.origin), "", "invalid_request"));
    const back = new URL(pending.returnTo);
    try {
      const { oauth } = pending;
      const iss = url.searchParams.get("iss");
      if ((oauth.issParameter && !iss) || (iss !== null && issuerKey(iss) !== issuerKey(oauth.issuer))) throw pluginError(400, "oauth_failed");
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || code.length > 8192) throw pluginError(400, "oauth_failed");
      const { plugin } = await this.stillAllowed(pending);
      const client = await this.client(oauth.issuer, oauth.client);
      if (!client) throw pluginError(409, "oauth_client_required");
      let tokens: Tokens;
      try { tokens = await exchangeToken(this.store.fetcher, oauth.tokenEndpoint, oauth.resource, client, { grant_type: "authorization_code", code, code_verifier: oauth.verifier, redirect_uri: oauth.redirectUri },
        oauth.scopes, networkOf(plugin, pending.url)); }
      catch { throw pluginError(502, "oauth_failed"); }
      await this.save(pending, { kind: "oauth", url: pending.url, issuer: oauth.issuer, tokenEndpoint: oauth.tokenEndpoint, resource: oauth.resource, client: oauth.client, tokens }, tokens.account);
      return redirect(this.result(back, pending.pluginId, null));
    } catch (error) {
      return redirect(this.result(back, pending.pluginId, error instanceof HttpError ? error.code : "oauth_failed"));
    }
  }

  async providerCallback(url: URL, userId: string, sessionId: string): Promise<Response> {
    const pending = await this.consume(url.searchParams.get("state"), userId, sessionId, url.origin);
    if (!pending?.provider) return redirect(this.result(new URL("/settings/plugins", url.origin), "", "invalid_request"));
    const back = new URL(pending.returnTo);
    try {
      if (url.searchParams.has("failed")) throw pluginError(400, "provider_rejected");
      const { provider, app, ref } = pending.provider;
      await this.stillAllowed(pending);
      const client = await this.store.provider(provider);
      if (!client) throw pluginError(409, "provider_not_configured");
      const account = await client.complete(userId, app, ref);
      const previous = this.store.connection(userId, pending.pluginId, pending.serverId);
      await this.save(pending, { kind: "provider", provider, app, account: account.id }, account.label);
      // One account per member and server: the account it replaced is disconnected at the platform.
      if (previous) {
        const old = await this.open(previous.data, userId, pending.pluginId, pending.serverId);
        if (old?.kind === "provider" && old.account !== account.id) await client.revoke(old.account).catch(() => {});
      }
      return redirect(this.result(back, pending.pluginId, null));
    } catch (error) {
      return redirect(this.result(back, pending.pluginId, error instanceof HttpError ? error.code : "provider_unavailable"));
    }
  }

  async disconnect(userId: string, pluginId: string, serverId: string) {
    const row = this.store.connection(userId, pluginId, serverId);
    if (!row) throw pluginError(404, "server_not_found");
    this.store.rows("delete from plugin_connection where user_id=? and plugin_id=? and server_id=?", userId, pluginId, serverId);
    this.store.rows("delete from plugin_oauth_state where user_id=? and plugin_id=? and server_id=?", userId, pluginId, serverId);
    const data = await this.open(row.data, userId, pluginId, serverId);
    if (data?.kind === "provider") await (await this.store.provider(data.provider))?.revoke(data.account).catch(() => {});
    await this.changed(userId);
  }

  private open(data: string, userId: string, pluginId: string, serverId: string): Promise<ConnectionData | null> {
    return this.store.cipher.open<ConnectionData>(data, this.store.connectionContext(userId, pluginId, serverId)).catch(() => null);
  }

  /** The issuer's current administrator client, or the registered one the connection carries. */
  private async client(issuer: string, client: Client): Promise<OAuthClient | null> {
    if (!client.admin) return client;
    const current = await this.store.oauthClient(issuer);
    if (!current || current.clientId !== client.clientId || (client.method !== "none" && !current.clientSecret)) return null;
    return { clientId: current.clientId, ...(current.clientSecret ? { clientSecret: current.clientSecret } : {}), method: client.method };
  }

  /** Servers members of the space may use, listed as a member whose connection works; skills of those plugins. */
  async spacePlugins(spaceId: string): Promise<SpacePlugins> {
    const members = this.store.rows("select m.user_id from space_member m join user u on u.id=m.user_id where m.space_id=? and coalesce(u.banned,0)=0 order by m.created_at,m.user_id", spaceId)
      .map(r => r.user_id as string);
    const facts = await this.store.facts();
    const result: SpacePlugins = { servers: [], skills: [] };
    for (const plugin of this.store.list()) {
      if (!plugin.enabled || !this.store.ready(plugin, facts)) continue;
      const eligible = members.filter(userId => this.store.hasAccess(userId, plugin) && this.store.isOn(userId, plugin.id));
      if (!eligible.length) continue;
      for (const server of plugin.def.servers) {
        const signedIn = server.auth.kind === "oauth" || server.auth.kind === "provider";
        let listAs: string | null = signedIn ? null : eligible[0]!;
        if (signedIn) for (const userId of eligible) {
          const row = this.store.connection(userId, plugin.id, server.id);
          if (row?.state !== "connected") continue;
          const data = await this.open(row.data, userId, plugin.id, server.id);
          if (!data) continue;
          if (data.kind === "oauth") {
            if (server.auth.kind !== "oauth" || data.url !== (await this.values(plugin, server)).url || !await this.client(data.issuer, data.client)) continue;
            // Settings are needed during boot; refreshing here could reload a space waiting for these settings.
            if (data.tokens.expiresAt !== null && data.tokens.expiresAt <= Date.now() + REFRESH_SKEW && !data.tokens.refreshToken) continue;
          } else if (server.auth.kind !== "provider" || data.provider !== server.auth.provider || data.app !== server.auth.app) continue;
          listAs = userId;
          break;
        }
        result.servers.push({ pluginId: plugin.id, serverId: server.id, name: server.name, displayName: plugin.def.displayName, listAs });
      }
      result.skills.push(...this.store.skillFiles(plugin.id).map(file => ({ path: `${plugin.id}/${file.path}`, base64: file.base64 })));
    }
    return result;
  }

  async credential(input: PluginCredentialRequest): Promise<PluginCredential> {
    const plugin = this.store.get(input.pluginId);
    const server = plugin?.def.servers.find(s => s.id === input.serverId);
    const user = this.store.rows("select banned from user where id=?", input.userId)[0];
    const facts = await this.store.facts();
    const connection = plugin && server ? this.store.connection(input.userId, plugin.id, server.id) : undefined;
    const fail = (error: PluginCallError): PluginCredential => ({ ok: false, error, message: callMessage(error, plugin?.def.displayName ?? "This plugin") });
    const decision = callDecision({
      user: user ? { banned: !!user.banned } : null,
      member: !!this.store.rows("select 1 from space_member where space_id=? and user_id=?", input.spaceId, input.userId).length,
      access: !!plugin && this.store.hasAccess(input.userId, plugin),
      plugin: plugin ? { enabled: plugin.enabled, ready: this.store.ready(plugin, facts) } : null,
      server: server ? { auth: server.auth } : null,
      on: !!plugin && this.store.isOn(input.userId, plugin.id),
      connection: connection ?? null,
    });
    if (decision) return fail(decision);
    const { url, headers } = await this.values(plugin!, server!);
    const resolved = (url: string, headers: Record<string, string>): PluginCredential => {
      try {
        const network = networkOf(plugin!, url);
        checkMcpUrl(url, network);
        return { ok: true, url, headers, network, transport: server!.transport };
      } catch { return fail("unavailable"); }
    };
    const checked = resolved(url, headers);
    if (!checked.ok || server!.auth.kind === "none" || server!.auth.kind === "headers") return checked;
    const data = await this.open(connection!.data, input.userId, plugin!.id, server!.id);
    if (!data) return fail(await this.expire(input, connection!.data));
    if (data.kind === "provider") {
      const client = await this.store.provider(data.provider);
      if (!client) return fail("setup_incomplete");
      try { const target = await client.credential(input.userId, data.app, data.account); return resolved(target.url, target.headers); }
      catch { return fail("unavailable"); }
    }
    if (data.url !== url) return fail(await this.expire(input, connection!.data));
    const token = await this.accessToken(input, plugin!, connection!.data, data);
    return "token" in token ? resolved(url, { ...headers, Authorization: `Bearer ${token.token}` }) : fail(token.error);
  }

  private async expire(input: PluginCredentialRequest, data: string): Promise<PluginCallError> {
    const changed = this.store.rows("update plugin_connection set state='expired' where user_id=? and plugin_id=? and server_id=? and data=? and state='connected' returning user_id", input.userId, input.pluginId, input.serverId, data);
    if (changed.length) await this.changed(input.userId);
    return "sign_in_expired";
  }

  /** Refreshes shortly before expiry; concurrent calls for one connection share a single refresh. */
  private accessToken(input: PluginCredentialRequest, plugin: PluginRow, sealed: string, data: Extract<ConnectionData, { kind: "oauth" }>): Promise<Token> {
    const { tokens } = data;
    if (tokens.expiresAt === null || tokens.expiresAt > Date.now() + REFRESH_SKEW) return Promise.resolve({ token: tokens.accessToken });
    if (!tokens.refreshToken) return this.expire(input, sealed).then(error => ({ error }));
    const key = JSON.stringify([input.userId, input.pluginId, input.serverId]);
    const running = this.refreshes.get(key);
    if (running) return running;
    const work = (async (): Promise<Token> => {
      const client = await this.client(data.issuer, data.client);
      if (!client) return { error: await this.expire(input, sealed) };
      let next: Tokens;
      try { next = await exchangeToken(this.store.fetcher, data.tokenEndpoint, data.resource, client, { grant_type: "refresh_token", refresh_token: tokens.refreshToken! },
        tokens.scopes, networkOf(plugin, data.url)); }
      catch (error) { return { error: error instanceof TokenError && error.kind === "expired" ? await this.expire(input, sealed) : "unavailable" }; }
      const updated = await this.store.cipher.seal({ ...data, tokens: { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken, account: next.account ?? tokens.account } },
        this.store.connectionContext(input.userId, input.pluginId, input.serverId));
      // A disconnect or new sign-in during the refresh wins.
      if (!this.store.rows("update plugin_connection set data=? where user_id=? and plugin_id=? and server_id=? and data=? returning data", updated, input.userId, input.pluginId, input.serverId, sealed).length)
        return { error: "unavailable" };
      return { token: next.accessToken };
    })().finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, work);
    return work;
  }
}
