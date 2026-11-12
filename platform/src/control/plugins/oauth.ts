import { z } from "zod";
import type { ServerAuth } from "../../../../app/packages/contracts/src/baskule-plugins";
import { pluginError } from "../../shared/http";
import { checkOutbound, type Network } from "../../shared/plugin-outbound";
import { OutboundError, json, send, type Fetcher } from "./fetch";

/** Authority-root slash variants name one issuer (`https://accounts.google.com/` is Google's advertised form). */
export const issuerKey = (issuer: string) => issuer.replace(/^(https?:\/\/[^/]+)\/$/, "$1");

export function canonicalResource(value: string, network: Network): string {
  const url = checkOutbound(value, network);
  return url.pathname === "/" && !url.search ? url.origin : url.href;
}

const scopes = z.array(z.string().min(1).max(2048)).max(200);
const resourceSchema = z.object({ resource: z.string().max(2048).optional(), authorization_servers: z.array(z.string().max(2048)).min(1).max(10), scopes_supported: scopes.optional() });
const serverSchema = z.object({
  issuer: z.string().max(2048), authorization_endpoint: z.string().max(2048), token_endpoint: z.string().max(2048), registration_endpoint: z.string().max(2048).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(), response_types_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(), scopes_supported: scopes.optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export type AuthorizationServer = z.infer<typeof serverSchema>;
export interface Discovery { resource: string | null; scopes: string[]; server: AuthorizationServer }

async function metadata(fetcher: Fetcher, url: string, network: Network): Promise<unknown | null> {
  const answer = await send(fetcher, url, { headers: { accept: "application/json" }, limit: 256 * 1024, timeoutMs: 10_000, network });
  if (answer.status >= 400 && answer.status < 500) return null;
  if (answer.status !== 200) throw new OutboundError(answer.status);
  return json(answer.text);
}

async function protectedResource(fetcher: Fetcher, server: URL, network: Network, advertised?: string) {
  const path = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
  const candidates = advertised ? [advertised] : [...new Set([`${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`])];
  for (const candidate of candidates) {
    const parsed = resourceSchema.safeParse(await metadata(fetcher, checkOutbound(candidate, network).href, network));
    if (parsed.success) return parsed.data;
  }
  return null;
}

export async function authorizationServer(fetcher: Fetcher, issuer: string, network: Network): Promise<AuthorizationServer> {
  const authority = checkOutbound(issuer, network);
  const suffix = authority.pathname === "/" ? "" : authority.pathname.replace(/\/$/, "");
  for (const url of [...new Set([`${authority.origin}/.well-known/oauth-authorization-server${suffix}`, `${authority.origin}/.well-known/openid-configuration${suffix}`,
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`])]) {
    const value = await metadata(fetcher, url, network);
    if (value === null) continue;
    const parsed = serverSchema.safeParse(value);
    if (!parsed.success || issuerKey(parsed.data.issuer) !== issuerKey(issuer) || (parsed.data.response_types_supported && !parsed.data.response_types_supported.includes("code")) ||
        (parsed.data.code_challenge_methods_supported && !parsed.data.code_challenge_methods_supported.includes("S256"))) throw pluginError(502, "oauth_failed", "Invalid authorization server metadata");
    for (const endpoint of [parsed.data.authorization_endpoint, parsed.data.token_endpoint, ...(parsed.data.registration_endpoint ? [parsed.data.registration_endpoint] : [])]) checkOutbound(endpoint, network);
    return { ...parsed.data, issuer: issuerKey(parsed.data.issuer) };
  }
  throw pluginError(502, "oauth_failed", "The authorization server publishes no metadata");
}

interface Challenge { status: number | null; metadata?: string; scopes?: string[] }

/** An unauthenticated MCP initialize: a 401 names the resource metadata; some servers (Google) only challenge tool calls. */
async function challenge(fetcher: Fetcher, url: string, transport: "streamable-http" | "sse", network: Network, headers: Record<string, string>): Promise<Challenge> {
  const init: RequestInit = transport === "sse" ? { method: "GET", headers: { ...headers, accept: "text/event-stream" } } : {
    method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Baskule", version: "1" } } }),
  };
  try {
    const answer = await send(fetcher, url, { ...init, limit: 64 * 1024, timeoutMs: 10_000, network });
    const header = answer.headers.get("www-authenticate") ?? "";
    const scope = /\bscope="([^"\\]*)"/i.exec(header)?.[1];
    return { status: answer.status, metadata: /\bresource_metadata="([^"\\]+)"/i.exec(header)?.[1], ...(scope === undefined ? {} : { scopes: scope.split(/\s+/).filter(Boolean) }) };
  } catch (error) {
    if (error instanceof OutboundError) return { status: null };
    throw error;
  }
}

/** How members authenticate to a server, detected when an administrator previews it. Network failures leave the issuer to sign-in. */
export async function probeAuth(fetcher: Fetcher, url: string, transport: "streamable-http" | "sse", network: Network, headers: Record<string, string> = {}): Promise<ServerAuth> {
  const unknown: ServerAuth = { kind: "oauth", issuer: null, registration: "dynamic" };
  const answer = await challenge(fetcher, url, transport, network, headers);
  if (answer.status === null || answer.status >= 500) return unknown;
  const target = new URL(url);
  let resource;
  try { resource = await protectedResource(fetcher, target, network, answer.metadata); }
  catch { return unknown; }
  // Before the 2025-06 MCP revision the server's own origin was its authorization server.
  const issuer = resource?.authorization_servers[0] ?? (answer.status === 401 ? target.origin : undefined);
  if (!issuer) return { kind: "none" };
  try {
    const server = await authorizationServer(fetcher, issuer, network);
    return { kind: "oauth", issuer: server.issuer, registration: server.registration_endpoint ? "dynamic" : "client" };
  } catch { return resource ? { kind: "oauth", issuer: issuerKey(issuer), registration: "dynamic" } : unknown; }
}

/** Sign-in discovery: protected-resource metadata (RFC 9728), then the authorization server (RFC 8414). */
export async function discover(fetcher: Fetcher, url: string, transport: "streamable-http" | "sse", network: Network, issuer: string | null): Promise<Discovery> {
  const target = checkOutbound(url, network);
  try {
    const answer = await challenge(fetcher, url, transport, network, {});
    const resource = await protectedResource(fetcher, target, network, answer.metadata);
    if (resource?.resource !== undefined && canonicalResource(resource.resource, network) !== canonicalResource(url, network))
      throw pluginError(502, "oauth_failed", "The server's metadata names another resource");
    const advertised = resource?.authorization_servers.map(issuerKey);
    if (issuer && advertised && !advertised.includes(issuerKey(issuer))) throw pluginError(409, "oauth_failed", "The server changed its authorization server");
    const chosen = issuer ?? advertised?.[0] ?? (answer.status === 401 ? target.origin : null);
    if (!chosen) throw pluginError(502, "oauth_failed", "The server does not use OAuth sign-in");
    return { resource: resource?.resource === undefined ? null : canonicalResource(resource.resource, network),
      scopes: answer.scopes ?? resource?.scopes_supported ?? [], server: await authorizationServer(fetcher, chosen, network) };
  } catch (error) {
    if (error instanceof OutboundError) throw pluginError(502, "oauth_failed", "The authorization server is unreachable");
    throw error;
  }
}

export interface OAuthClient { clientId: string; clientSecret?: string; method: "none" | "client_secret_post" | "client_secret_basic" }

/** RFC 6749 §2.3.1: Basic is the default when the server advertises nothing. */
export function clientMethod(server: AuthorizationServer, secret: boolean): OAuthClient["method"] {
  const supported = server.token_endpoint_auth_methods_supported;
  if (!secret) return "none";
  if (supported?.includes("client_secret_post") && !supported.includes("client_secret_basic")) return "client_secret_post";
  return "client_secret_basic";
}

export async function registerClient(fetcher: Fetcher, discovery: Discovery, redirectUri: string, network: Network): Promise<OAuthClient> {
  const endpoint = discovery.server.registration_endpoint;
  if (!endpoint) throw pluginError(409, "oauth_client_required");
  const supported = discovery.server.token_endpoint_auth_methods_supported;
  const method = (["none", "client_secret_post", "client_secret_basic"] as const).find(m => !supported || supported.includes(m));
  if (!method) throw pluginError(409, "oauth_client_required");
  let answer;
  try {
    answer = await send(fetcher, endpoint, { method: "POST", network, timeoutMs: 10_000, headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({
      client_name: "Baskule", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      ...(supported ? { token_endpoint_auth_method: method } : {}), application_type: "web",
    }) });
  } catch { throw pluginError(502, "oauth_failed", "Client registration is unreachable"); }
  const parsed = z.object({ client_id: z.string().min(1).max(4096), client_secret: z.string().min(1).max(8192).optional(),
    token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional() }).safeParse(json(answer.text));
  if ((answer.status !== 200 && answer.status !== 201) || !parsed.success) throw pluginError(502, "oauth_failed", "Client registration failed");
  const chosen = parsed.data.token_endpoint_auth_method ?? (parsed.data.client_secret ? clientMethod(discovery.server, true) : "none");
  if (chosen !== "none" && !parsed.data.client_secret) throw pluginError(502, "oauth_failed", "Client registration returned no secret");
  return { clientId: parsed.data.client_id, ...(parsed.data.client_secret ? { clientSecret: parsed.data.client_secret } : {}), method: chosen };
}

export interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number | null; scopes: string[]; account: string | null }

/** `expired` only for `invalid_grant`; timeouts, 429 and 5xx keep the refresh token for the next call. */
export class TokenError extends Error {
  constructor(readonly kind: "expired" | "unavailable") { super(kind); }
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(32768).regex(/^[A-Za-z0-9\-._~+/]+=*$/), token_type: z.string().regex(/^bearer$/i),
  refresh_token: z.string().min(1).max(32768).optional(), expires_in: z.number().positive().max(365 * 86400).optional(),
  scope: z.string().max(16384).optional(), id_token: z.string().max(32768).optional(),
});

/** A label from the ID token the token endpoint returned over TLS; never used for authorization. */
function idTokenAccount(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { email?: unknown; name?: unknown };
    const label = typeof claims.email === "string" ? claims.email : typeof claims.name === "string" ? claims.name : null;
    return label ? label.slice(0, 200) : null;
  } catch { return null; }
}

export async function exchangeToken(fetcher: Fetcher, endpoint: string, resource: string | null, client: OAuthClient, params: Record<string, string>, previousScopes: string[], network: Network): Promise<Tokens> {
  const form = new URLSearchParams({ ...params, ...(resource ? { resource } : {}), client_id: client.clientId });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.method === "client_secret_post") form.set("client_secret", client.clientSecret!);
  if (client.method === "client_secret_basic") {
    form.delete("client_id");
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret!)}`)}`;
  }
  let answer;
  try { answer = await send(fetcher, endpoint, { method: "POST", headers, body: form.toString(), limit: 128 * 1024, timeoutMs: 15_000, network }); }
  catch { throw new TokenError("unavailable"); }
  const value = json(answer.text) as { error?: unknown } | null;
  if ((answer.status === 400 || answer.status === 401) && value?.error === "invalid_grant") throw new TokenError("expired");
  const token = tokenSchema.safeParse(value);
  if (answer.status !== 200 || !token.success) throw new TokenError("unavailable");
  return { accessToken: token.data.access_token, ...(token.data.refresh_token ? { refreshToken: token.data.refresh_token } : {}),
    expiresAt: token.data.expires_in === undefined ? null : Date.now() + token.data.expires_in * 1000,
    scopes: token.data.scope === undefined ? previousScopes : token.data.scope.split(/\s+/).filter(Boolean), account: idTokenAccount(token.data.id_token) };
}

const RESERVED = new Set(["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"]);

export function parseAuthorizationParams(value: string): URLSearchParams | null {
  const params = new URLSearchParams(value.replace(/^\?/, ""));
  return [...params.keys()].some(key => RESERVED.has(key) || !/^[A-Za-z0-9_.-]{1,100}$/.test(key)) ? null : params;
}

export function authorizationUrl(input: { discovery: Discovery; clientId: string; redirectUri: string; state: string; challenge: string; scopes: string[]; params: URLSearchParams }): string {
  const url = new URL(input.discovery.server.authorization_endpoint);
  for (const [key, value] of input.params) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: input.clientId, redirect_uri: input.redirectUri, state: input.state,
    code_challenge: input.challenge, code_challenge_method: "S256", ...(input.discovery.resource ? { resource: input.discovery.resource } : {}) })) url.searchParams.set(key, value);
  if (input.scopes.length) url.searchParams.set("scope", input.scopes.join(" "));
  return url.href;
}

/** Scopes to request: the administrator's, else what the server challenges for or advertises, plus offline access when offered. */
export function requestedScopes(discovery: Discovery, configured: string | null): string[] {
  const wanted = configured ? configured.split(/\s+/).filter(Boolean) : discovery.scopes;
  return [...new Set([...wanted, ...(wanted.length && discovery.server.scopes_supported?.includes("offline_access") ? ["offline_access"] : [])])];
}
