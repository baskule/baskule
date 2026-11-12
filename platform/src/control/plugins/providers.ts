// Hosted app platforms, following Rakazo's adapters (Apache-2.0): Pipedream Connect over REST and remote MCP,
// Composio tool-router sessions over REST, whose session MCP endpoint serves the same proxy.
import type { ProviderInput } from "../../../../app/packages/contracts/src/baskule-plugins";
import { pluginError } from "../../shared/http";
import { OutboundError, json, send, type Fetcher } from "./fetch";
import { pluginCategory } from "./ranking";

export const PIPEDREAM_API = "https://api.pipedream.com";
export const PIPEDREAM_MCP = "https://remote.mcp.pipedream.net/v3";
export const COMPOSIO_API = "https://backend.composio.dev";
const MAX_APPS = 5000;

export interface ProviderApp { slug: string; name: string; description: string; logo: string | null; category: string | null }
export interface ConnectStart { url: string; ref: string | null }
export interface ProviderAccount { id: string; label: string | null }
export interface Provider {
  verify(): Promise<void>;
  apps(): Promise<ProviderApp[]>;
  connect(user: string, app: string, callback: string): Promise<ConnectStart>;
  complete(user: string, app: string, ref: string | null): Promise<ProviderAccount>;
  credential(user: string, app: string, account: string): Promise<{ url: string; headers: Record<string, string> }>;
  revoke(account: string): Promise<void>;
}

type Call = (path: string, init?: RequestInit) => Promise<unknown>;

/** Turns provider answers into the plugin error contract: refusals are the credentials' fault, the rest is an outage. */
async function call(fetcher: Fetcher, url: string, init: RequestInit, onUnauthorized?: () => void): Promise<unknown> {
  let answer;
  try { answer = await send(fetcher, url, { ...init, limit: 8 * 1024 * 1024, timeoutMs: 30_000 }); }
  catch (error) { if (error instanceof OutboundError) throw pluginError(502, "provider_unavailable"); throw error; }
  if (answer.status === 401) onUnauthorized?.();
  if ([400, 401, 403, 404, 422].includes(answer.status)) throw pluginError(answer.status === 404 ? 404 : 400, "provider_rejected", answer.text.slice(0, 300));
  if (answer.status < 200 || answer.status >= 300) throw pluginError(502, "provider_unavailable");
  return answer.text ? json(answer.text) : {};
}

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const https = (value: unknown) => typeof value === "string" && /^https:\/\/[^\s]+$/.test(value) && value.length <= 2048 ? value : null;

export class Pipedream implements Provider {
  private token?: { value: string; expiresAt: number };
  private pending?: Promise<string>;
  constructor(private config: Extract<ProviderInput, { provider: "pipedream" }>, private identity: (user: string) => Promise<string>, private fetcher: Fetcher = fetch) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    return this.pending ??= (async () => {
      const body = await call(this.fetcher, `${PIPEDREAM_API}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret, scope: "connect:*" }) }) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== "string" || !body.access_token) throw pluginError(400, "provider_rejected");
      this.token = { value: body.access_token, expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000 };
      return body.access_token;
    })().finally(() => { this.pending = undefined; });
  }

  private api: Call = async (path, init = {}) => call(this.fetcher, `${PIPEDREAM_API}${path}`, { ...init, headers: {
    authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", "x-pd-environment": this.config.environment, ...init.headers,
  } }, () => { this.token = undefined; });

  private project = (path: string) => `/v1/connect/${encodeURIComponent(this.config.projectId)}${path}`;

  async verify() {
    await this.api(this.project(`/accounts?${new URLSearchParams({ external_user_id: await this.identity("verify"), limit: "1" })}`));
  }

  async apps(): Promise<ProviderApp[]> {
    const apps: ProviderApp[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100 && apps.length < MAX_APPS; page++) {
      const query = new URLSearchParams({ limit: "100", has_actions: "true", ...(after ? { after } : {}) });
      const body = await this.api(`/v1/connect/apps?${query}`) as { data?: Record<string, unknown>[]; page_info?: { end_cursor?: unknown } };
      for (const app of body.data ?? []) {
        const slug = text(app.name_slug, 120);
        if (!slug) continue;
        const categories = Array.isArray(app.categories) ? app.categories.filter((c): c is string => typeof c === "string") : [];
        apps.push({ slug, name: text(app.name, 120) || slug, description: text(app.description, 300), logo: https(app.img_src), category: categories[0] ?? null });
      }
      after = typeof body.page_info?.end_cursor === "string" && body.page_info.end_cursor ? body.page_info.end_cursor : undefined;
      if (!after) break;
    }
    return apps;
  }

  async connect(user: string, app: string, callback: string): Promise<ConnectStart> {
    const body = await this.api(this.project("/tokens"), { method: "POST", body: JSON.stringify({ external_user_id: await this.identity(user),
      success_redirect_uri: callback, error_redirect_uri: `${callback}&failed=1`, scope: "connect:accounts:read connect:accounts:write" }) }) as { connect_link_url?: unknown };
    const link = https(body.connect_link_url);
    if (!link) throw pluginError(502, "provider_unavailable");
    const url = new URL(link);
    if (url.username || url.password) throw pluginError(502, "provider_unavailable");
    url.searchParams.set("app", app);
    return { url: url.href, ref: null };
  }

  /** The member's newest healthy account for the app; Pipedream keys accounts by our external user id. */
  async complete(user: string, app: string): Promise<ProviderAccount> {
    const body = await this.api(this.project(`/accounts?${new URLSearchParams({ external_user_id: await this.identity(user), app, limit: "100" })}`)) as { data?: Record<string, unknown>[] };
    const accounts = (body.data ?? []).filter(a => typeof a.id === "string" && a.healthy !== false && a.dead !== true &&
      (a.app as { name_slug?: unknown } | undefined)?.name_slug === app);
    accounts.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    const account = accounts[0];
    if (!account) throw pluginError(400, "provider_rejected", "No connected account was found");
    return { id: account.id as string, label: text(account.name, 200) || null };
  }

  async credential(user: string, app: string, account: string) {
    return { url: PIPEDREAM_MCP, headers: { authorization: `Bearer ${await this.accessToken()}`, "x-pd-project-id": this.config.projectId,
      "x-pd-environment": this.config.environment, "x-pd-external-user-id": await this.identity(user), "x-pd-app-slug": app, "x-pd-account-id": account } };
  }

  async revoke(account: string) {
    await this.api(this.project(`/accounts/${encodeURIComponent(account)}`), { method: "DELETE" });
  }
}

const SESSION_TTL = 30 * 60_000;

export class Composio implements Provider {
  private sessions = new Map<string, { url: string; expiresAt: number }>();
  constructor(private config: Extract<ProviderInput, { provider: "composio" }>, private identity: (user: string) => Promise<string>, private fetcher: Fetcher = fetch) {}

  private api: Call = (path, init = {}) => call(this.fetcher, `${COMPOSIO_API}${path}`, { ...init, headers: {
    "x-api-key": this.config.apiKey, "content-type": "application/json", accept: "application/json", ...init.headers } });

  /** Collects a cursor-paged listing; Composio answers `{items, next_cursor}`. */
  private async pages(path: string, limit: number, query: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const body = await this.api(`${path}?${new URLSearchParams({ ...query, limit: String(limit), ...(cursor ? { cursor } : {}) })}`) as { items?: Record<string, unknown>[]; next_cursor?: unknown };
      items.push(...(body.items ?? []));
      cursor = typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : undefined;
      if (!cursor || items.length >= MAX_APPS) break;
    }
    return items;
  }

  /** Composio connects only `toolkits` it manages sign-in for, or that this project configured; no-auth toolkits are left out. */
  async apps(): Promise<ProviderApp[]> {
    const [toolkits, configs] = await Promise.all([this.pages("/api/v3.1/toolkits", 1000), this.pages("/api/v3.1/auth_configs", 100).catch(() => [])]);
    const configured = new Set(configs.filter(c => c.status === "ENABLED").map(c => text((c.toolkit as { slug?: unknown } | undefined)?.slug, 120).toLowerCase()));
    return toolkits.flatMap(toolkit => {
      const slug = text(toolkit.slug, 120);
      const managed = Array.isArray(toolkit.composio_managed_auth_schemes) ? toolkit.composio_managed_auth_schemes.length : undefined;
      if (!slug || toolkit.no_auth === true || toolkit.is_local_toolkit === true || (managed === 0 && !configured.has(slug.toLowerCase()))) return [];
      const meta = (toolkit.meta ?? {}) as { logo?: unknown; description?: unknown; categories?: { name?: unknown; id?: unknown }[] };
      const category = Array.isArray(meta.categories) ? text(meta.categories[0]?.id ?? meta.categories[0]?.name, 60) || null : null;
      return [{ slug, name: text(toolkit.name, 120) || slug, description: text(meta.description, 300), logo: https(meta.logo), category }];
    });
  }

  async verify() {
    await this.api(`/api/v3.1/connected_accounts?${new URLSearchParams({ limit: "1" })}`);
  }

  private async session(body: Record<string, unknown>): Promise<{ id: string; mcp: string }> {
    const session = await this.api("/api/v3.1/tool_router/session", { method: "POST", body: JSON.stringify({
      manage_connections: { enable: false }, workbench: { enable: false }, ...body }) }) as { session_id?: unknown; mcp?: { url?: unknown } };
    const mcp = https(session.mcp?.url);
    // The project key goes only to Composio's own origin, as the SDK does.
    if (typeof session.session_id !== "string" || !mcp || new URL(mcp).origin !== COMPOSIO_API) throw pluginError(502, "provider_unavailable");
    return { id: session.session_id, mcp };
  }

  async connect(user: string, app: string, callback: string): Promise<ConnectStart> {
    const { id } = await this.session({ user_id: await this.identity(user), toolkits: { enable: [app] } });
    const link = await this.api(`/api/v3.1/tool_router/session/${encodeURIComponent(id)}/link`, { method: "POST", body: JSON.stringify({ toolkit: app, callback_url: callback }) }) as
      { redirect_url?: unknown; connected_account_id?: unknown };
    const url = https(link.redirect_url);
    if (!url || typeof link.connected_account_id !== "string") throw pluginError(502, "provider_unavailable");
    return { url, ref: link.connected_account_id };
  }

  async complete(user: string, app: string, ref: string | null): Promise<ProviderAccount> {
    if (!ref) throw pluginError(400, "provider_rejected");
    const account = await this.api(`/api/v3.1/connected_accounts/${encodeURIComponent(ref)}`) as { id?: unknown; status?: unknown; user_id?: unknown; toolkit?: { slug?: unknown } };
    if (account.status !== "ACTIVE" || account.user_id !== await this.identity(user) || text(account.toolkit?.slug, 120).toLowerCase() !== app.toLowerCase())
      throw pluginError(400, "provider_rejected", "The account is not connected");
    return { id: ref, label: null };
  }

  /** A session pinned to the member's one account, so Composio never acts as another of their accounts. */
  async credential(user: string, app: string, account: string) {
    const key = JSON.stringify([user, app, account]);
    let cached = this.sessions.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
      const session = await this.session({ user_id: await this.identity(user), toolkits: { enable: [app] }, connected_accounts: { [app]: [account] } });
      cached = { url: session.mcp, expiresAt: Date.now() + SESSION_TTL };
      this.sessions.set(key, cached);
    }
    return { url: cached.url, headers: { "x-api-key": this.config.apiKey } };
  }

  async revoke(account: string) {
    try { await this.api(`/api/v3.1/connected_accounts/${encodeURIComponent(account)}`, { method: "DELETE" }); }
    catch (error) { if (!(error instanceof Error && "status" in error && error.status === 404)) throw error; }
  }
}

export const providerCategory = (app: ProviderApp) => pluginCategory(app.slug, app.category);
