import type { OAuthRecipe } from "../../../app/packages/contracts/src/baskule-plugins";
import { checkOutbound, serverNetwork, type Network } from "../shared/plugin-outbound";
import { z } from "zod";
import { pluginError } from "../shared/http";
import { readBounded, type Fetcher } from "./plugin-source";

export function canonicalResource(value: string, network: Network = "public"): string {
  const u = checkOutbound(value, network);
  if (u.search) throw pluginError(400, "invalid_oauth_resource");
  return u.pathname === "/" ? u.origin : u.href;
}
// Authority-root slash variants share discovery; path-bearing issuer identifiers stay exact.
const issuerKey = (issuer: string) => issuer.replace(/^(https?:\/\/[^/]+)\/$/, "$1");
const url = z.string().max(2048);
const scopes = z.array(z.string().min(1).max(2048)).max(100);
const resourceSchema = z.object({ resource: z.string(), authorization_servers: z.array(url).min(1).max(10), scopes_supported: scopes.optional() });
const asSchema = z.object({
  issuer: z.string(), authorization_endpoint: url, token_endpoint: url, registration_endpoint: url.optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()).refine(v => v.includes("code")),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  scopes_supported: scopes.optional(), authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export type AuthorizationServer = z.infer<typeof asSchema>;
export interface Discovery { resource: string; scopes: string[]; as: AuthorizationServer }

export async function oauthJson(fetcher: Fetcher, target: string, init?: RequestInit, network: Network = "public"): Promise<{ status: number; value: unknown }> {
  const checked = checkOutbound(target, network);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const r = await fetcher(checked.href, { ...init, redirect: "error", signal: controller.signal });
    const data = await readBounded(r.body, 128 * 1024);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(data)); } catch { value = null; }
    return { status: r.status, value };
  } catch { throw pluginError(502, "oauth_unavailable"); }
  finally { clearTimeout(timer); }
}
export async function discoverOAuth(server: string, fetcher: Fetcher = fetch, network: Network = "public", pinnedIssuer?: string, resourceUrl?: string): Promise<Discovery> {
  const resource = canonicalResource(resourceUrl ?? server, network);
  const u = checkOutbound(server, network);
  if (new URL(resource).origin !== u.origin) throw pluginError(400, "invalid_oauth_resource");
  // Inspect the resource's challenge without a credential, including its scoped metadata URL.
  let metadata: string | undefined;
  let challengeScopes: string[] | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const r = await fetcher(u.href, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json, text/event-stream" } });
    const challenge = r.headers.get("www-authenticate") ?? "";
    metadata = /\bresource_metadata="([^"\\]+)"/i.exec(challenge)?.[1];
    const scope = /\bscope="([^"\\]*)"/i.exec(challenge)?.[1];
    if (scope !== undefined) challengeScopes = scope.split(/\s+/).filter(Boolean);
    await r.body?.cancel();
  } catch { throw pluginError(502, "oauth_unavailable"); }
  finally { clearTimeout(timer); }
  const candidates = metadata ? [checkOutbound(metadata, network).href] : [...new Set([`${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`])];
  let protectedResource: z.infer<typeof resourceSchema> | undefined;
  for (const candidate of candidates) {
    const r = await oauthJson(fetcher, candidate, undefined, network);
    if (r.status === 404) continue;
    const parsed = resourceSchema.safeParse(r.value);
    if (r.status !== 200 || !parsed.success) throw pluginError(502, "invalid_resource_metadata");
    protectedResource = parsed.data; break;
  }
  if (protectedResource && canonicalResource(protectedResource.resource, network) !== resource) throw pluginError(502, "oauth_resource_mismatch");
  if (!protectedResource && !pinnedIssuer) throw pluginError(502, "oauth_resource_mismatch");
  if (pinnedIssuer && protectedResource && !protectedResource.authorization_servers.some(issuer => issuerKey(issuer) === issuerKey(pinnedIssuer))) throw pluginError(409, "oauth_issuer_changed");
  const issuer = pinnedIssuer ?? protectedResource!.authorization_servers[0];
  const authority = checkOutbound(issuer, network);
  if (authority.search) throw pluginError(502, "invalid_authorization_metadata");
  const suffix = authority.pathname === "/" ? "" : authority.pathname.replace(/\/$/, "");
  const urls = [...new Set([`${authority.origin}/.well-known/oauth-authorization-server${suffix}`, `${authority.origin}/.well-known/openid-configuration${suffix}`, `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`])];
  for (const endpoint of urls) {
    const r = await oauthJson(fetcher, endpoint, undefined, network);
    if (r.status === 404) continue;
    const parsed = asSchema.safeParse(r.value);
    if (r.status !== 200 || !parsed.success || issuerKey(parsed.data.issuer) !== issuerKey(issuer) || (!parsed.data.code_challenge_methods_supported?.includes("S256") && !(pinnedIssuer && parsed.data.code_challenge_methods_supported === undefined))) throw pluginError(502, "invalid_authorization_metadata");
    for (const endpoint of [parsed.data.issuer, parsed.data.authorization_endpoint, parsed.data.token_endpoint, ...(parsed.data.registration_endpoint ? [parsed.data.registration_endpoint] : [])]) checkOutbound(endpoint, network);
    return { resource, scopes: challengeScopes ?? protectedResource?.scopes_supported ?? [], as: parsed.data };
  }
  throw pluginError(502, "invalid_authorization_metadata");
}
export interface OAuthClient { clientId: string; clientSecret?: string; tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic" }
export async function registerClient(discovery: Discovery, redirectUri: string, fetcher: Fetcher): Promise<OAuthClient> {
  if (!discovery.as.registration_endpoint) throw pluginError(409, "oauth_client_configuration_required");
  const r = await oauthJson(fetcher, discovery.as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    client_name: "Baskule", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  }) }, serverNetwork(discovery.resource));
  const parsed = z.object({ client_id: z.string().min(1).max(4096), token_endpoint_auth_method: z.literal("none").optional() }).safeParse(r.value);
  if ((r.status !== 200 && r.status !== 201) || !parsed.success) throw pluginError(502, "oauth_registration_failed");
  return { clientId: parsed.data.client_id, tokenEndpointAuthMethod: "none" };
}
export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt: number | null; scopes: string[] }
export async function exchangeToken(discovery: Discovery, client: OAuthClient, params: Record<string, string>, previousScopes: string[], fetcher: Fetcher, recipe?: OAuthRecipe): Promise<OAuthTokens> {
  const form = new URLSearchParams({ ...params, ...(recipe?.resource === false ? {} : { resource: discovery.resource }), client_id: client.clientId });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.tokenEndpointAuthMethod === "client_secret_post") form.set("client_secret", client.clientSecret!);
  if (client.tokenEndpointAuthMethod === "client_secret_basic") headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret!)}`)}`;
  const r = await oauthJson(fetcher, discovery.as.token_endpoint, { method: "POST", headers, body: form.toString() }, serverNetwork(discovery.resource));
  if (r.status === 400 && (r.value as { error?: string } | null)?.error === "invalid_grant") throw pluginError(401, "oauth_grant_expired");
  const token = z.object({ access_token: z.string().min(1).max(32768).regex(/^[A-Za-z0-9\-._~+/]+=*$/), token_type: z.string().regex(/^Bearer$/i),
    refresh_token: z.string().min(1).max(32768).optional(), expires_in: z.number().positive().max(365 * 86400).optional(), scope: z.string().max(16384).optional(), resource: z.string().optional(),
  }).safeParse(r.value);
  if (r.status !== 200 || !token.success || (token.data.resource && canonicalResource(token.data.resource, serverNetwork(discovery.resource)) !== discovery.resource)) throw pluginError(502, "invalid_oauth_token");
  return { accessToken: token.data.access_token, refreshToken: token.data.refresh_token,
    expiresAt: token.data.expires_in === undefined ? null : Date.now() + token.data.expires_in * 1000, scopes: token.data.scope === undefined ? previousScopes : token.data.scope.split(/\s+/).filter(Boolean) };
}
