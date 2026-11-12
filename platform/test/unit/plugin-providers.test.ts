import { describe, expect, it } from "vitest";
import { Composio, Pipedream, PIPEDREAM_MCP } from "../../src/control/plugins/providers";
import { fakeFetch, ok } from "../support/fake-fetch";

const identity = async (user: string) => `bsk_${user}`;
const pipedreamConfig = { provider: "pipedream" as const, clientId: "pd-id", clientSecret: "pd-secret", projectId: "proj_1", environment: "production" as const };
const PD = "https://api.pipedream.com";

function pipedream() {
  const fake = fakeFetch({
    [`${PD}/v1/oauth/token`]: ok({ access_token: "pd-token", token_type: "Bearer", expires_in: 3600 }),
    [`${PD}/v1/connect/apps?limit=100&has_actions=true`]: ok({ data: [{ id: "app_1", name_slug: "slack", name: "Slack", img_src: "https://assets.pipedream.net/s.v0/app_1/logo/orig", description: "Team chat", categories: ["Communication"] }], page_info: { end_cursor: "c2" } }),
    [`${PD}/v1/connect/apps?limit=100&has_actions=true&after=c2`]: ok({ data: [{ id: "app_2", name_slug: "notion", name: "Notion", img_src: "javascript:alert(1)" }], page_info: { end_cursor: null } }),
    [`${PD}/v1/connect/proj_1/tokens`]: ok({ token: "ctok_1", expires_at: "2026-11-12T03:00:00Z", connect_link_url: "https://pipedream.com/_static/connect.html?token=ctok_1&connectLink=true" }),
    [`${PD}/v1/connect/proj_1/accounts?external_user_id=bsk_alice&app=slack&limit=100`]: ok({ data: [
      { id: "apn_old", name: "old@acme.test", healthy: true, dead: false, app: { name_slug: "slack" }, created_at: "2026-11-01T00:00:00Z" },
      { id: "apn_dead", name: "dead@acme.test", healthy: false, dead: true, app: { name_slug: "slack" }, created_at: "2026-11-12T00:00:00Z" },
      { id: "apn_new", name: "ada@acme.test", healthy: true, dead: false, app: { name_slug: "slack" }, created_at: "2026-11-11T00:00:00Z" },
    ] }),
    [`${PD}/v1/connect/proj_1/accounts/apn_new`]: new Response(null, { status: 204 }),
    [`${PD}/v1/connect/proj_1/accounts?external_user_id=bsk_verify&limit=1`]: ok({ data: [] }),
  });
  return { ...fake, client: new Pipedream(pipedreamConfig, identity, fake.fetcher) };
}

describe("Pipedream Connect", () => {
  it("authenticates once per token lifetime and pages the app directory", async () => {
    const { client, seen } = pipedream();
    expect(await client.apps()).toEqual([
      { slug: "slack", name: "Slack", description: "Team chat", logo: "https://assets.pipedream.net/s.v0/app_1/logo/orig", category: "Communication" },
      { slug: "notion", name: "Notion", description: "", logo: null, category: null },
    ]);
    await client.verify();
    expect(seen.filter(s => s.url.endsWith("/v1/oauth/token"))).toHaveLength(1);
    expect(JSON.parse(seen[0]!.body)).toEqual({ grant_type: "client_credentials", client_id: "pd-id", client_secret: "pd-secret", scope: "connect:*" });
    expect(seen.slice(1).every(s => s.headers.authorization === "Bearer pd-token" && s.headers["x-pd-environment"] === "production")).toBe(true);
  });
  it("connects through a hosted link, picks the newest healthy account, and hands the MCP server its headers", async () => {
    const { client, seen } = pipedream();
    const start = await client.connect("alice", "slack", "https://baskule.test/api/baskule/plugins/provider/callback?state=abc");
    expect(start).toEqual({ url: "https://pipedream.com/_static/connect.html?token=ctok_1&connectLink=true&app=slack", ref: null });
    expect(JSON.parse(seen.find(s => s.url.endsWith("/tokens"))!.body)).toEqual({ external_user_id: "bsk_alice",
      success_redirect_uri: "https://baskule.test/api/baskule/plugins/provider/callback?state=abc", error_redirect_uri: "https://baskule.test/api/baskule/plugins/provider/callback?state=abc&failed=1",
      scope: "connect:accounts:read connect:accounts:write" });
    expect(await client.complete("alice", "slack")).toEqual({ id: "apn_new", label: "ada@acme.test" });
    expect(await client.credential("alice", "slack", "apn_new")).toEqual({ url: PIPEDREAM_MCP, headers: { authorization: "Bearer pd-token", "x-pd-project-id": "proj_1",
      "x-pd-environment": "production", "x-pd-external-user-id": "bsk_alice", "x-pd-app-slug": "slack", "x-pd-account-id": "apn_new" } });
    await client.revoke("apn_new");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: `${PD}/v1/connect/proj_1/accounts/apn_new` });
  });
  it("tells refused credentials from an outage", async () => {
    await expect(new Pipedream(pipedreamConfig, identity, fakeFetch({ [`${PD}/v1/oauth/token`]: ok({ error: "invalid_client" }, { status: 401 }) }).fetcher).verify())
      .rejects.toMatchObject({ code: "provider_rejected" });
    await expect(new Pipedream(pipedreamConfig, identity, fakeFetch({ [`${PD}/v1/oauth/token`]: new Response("", { status: 503 }) }).fetcher).verify())
      .rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

const C = "https://backend.composio.dev";
function composio() {
  const fake = fakeFetch({
    [`${C}/api/v3.1/toolkits?limit=1000`]: ok({ items: [
      { slug: "gmail", name: "Gmail", meta: { logo: "https://logos.composio.dev/api/gmail", description: "Email", categories: [{ id: "productivity", name: "Productivity" }] }, no_auth: false, composio_managed_auth_schemes: ["OAUTH2"] },
      { slug: "shopify", name: "Shopify", meta: {}, no_auth: false, composio_managed_auth_schemes: [] },
      { slug: "twitter", name: "Twitter", meta: {}, no_auth: false, composio_managed_auth_schemes: [] },
      { slug: "hackernews", name: "Hacker News", meta: {}, no_auth: true, composio_managed_auth_schemes: [] },
    ], next_cursor: null }),
    [`${C}/api/v3.1/auth_configs?limit=100`]: ok({ items: [{ toolkit: { slug: "shopify" }, status: "ENABLED" }, { toolkit: { slug: "twitter" }, status: "DISABLED" }], next_cursor: null }),
    [`${C}/api/v3.1/tool_router/session`]: ({ body }) => ok({ session_id: `trs_${JSON.parse(body).connected_accounts ? "pinned" : "connect"}`, mcp: { type: "http", url: `${C}/tool_router/trs_1/mcp` }, tool_router_tools: [] }, { status: 201 }),
    [`${C}/api/v3.1/tool_router/session/trs_connect/link`]: ok({ link_token: "lt", redirect_url: "https://connect.composio.dev/link/lt", connected_account_id: "ca_1" }, { status: 201 }),
    [`${C}/api/v3.1/connected_accounts/ca_1`]: ok({ id: "ca_1", status: "ACTIVE", user_id: "bsk_alice", toolkit: { slug: "gmail" } }),
    [`${C}/api/v3.1/connected_accounts?limit=1`]: ok({ items: [] }),
  });
  return { ...fake, client: new Composio({ provider: "composio", apiKey: "ck_secret" }, identity, fake.fetcher) };
}

describe("Composio", () => {
  it("lists toolkits it can sign members in to", async () => {
    const { client, seen } = composio();
    expect(await client.apps()).toEqual([
      { slug: "gmail", name: "Gmail", description: "Email", logo: "https://logos.composio.dev/api/gmail", category: "productivity" },
      { slug: "shopify", name: "Shopify", description: "", logo: null, category: null },
    ]);
    expect(seen.every(s => s.headers["x-api-key"] === "ck_secret")).toBe(true);
  });
  it("links an account through a tool-router session and pins later sessions to it", async () => {
    const { client, seen } = composio();
    const start = await client.connect("alice", "gmail", "https://baskule.test/cb?state=s");
    expect(start).toEqual({ url: "https://connect.composio.dev/link/lt", ref: "ca_1" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ manage_connections: { enable: false }, workbench: { enable: false }, user_id: "bsk_alice", toolkits: { enable: ["gmail"] } });
    expect(JSON.parse(seen[1]!.body)).toEqual({ toolkit: "gmail", callback_url: "https://baskule.test/cb?state=s" });
    expect(await client.complete("alice", "gmail", "ca_1")).toEqual({ id: "ca_1", label: null });
    await expect(client.complete("bob", "gmail", "ca_1")).rejects.toMatchObject({ code: "provider_rejected" });
    const credential = await client.credential("alice", "gmail", "ca_1");
    expect(credential).toEqual({ url: `${C}/tool_router/trs_1/mcp`, headers: { "x-api-key": "ck_secret" } });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ manage_connections: { enable: false }, workbench: { enable: false }, user_id: "bsk_alice",
      toolkits: { enable: ["gmail"] }, connected_accounts: { gmail: ["ca_1"] } });
    const sessions = seen.filter(s => s.url.endsWith("/tool_router/session")).length;
    await client.credential("alice", "gmail", "ca_1");
    expect(seen.filter(s => s.url.endsWith("/tool_router/session"))).toHaveLength(sessions);
  });
  it("never sends the project key to an MCP endpoint on another origin", async () => {
    const { fetcher } = fakeFetch({ [`${C}/api/v3.1/tool_router/session`]: ok({ session_id: "trs_x", mcp: { url: "https://evil.test/mcp" } }, { status: 201 }) });
    await expect(new Composio({ provider: "composio", apiKey: "ck" }, identity, fetcher).credential("alice", "gmail", "ca_1")).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
