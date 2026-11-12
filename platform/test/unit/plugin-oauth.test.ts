import { describe, expect, it } from "vitest";
import { ISSUER_DEFAULT_PARAMS } from "../../../app/packages/contracts/src/baskule-plugins";
import { authorizationUrl, discover, exchangeToken, parseAuthorizationParams, probeAuth, registerClient, requestedScopes, TokenError } from "../../src/control/plugins/oauth";
import { fakeFetch, ok } from "../support/fake-fetch";

const GOOGLE_AS = { issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token",
  response_types_supported: ["code"], code_challenge_methods_supported: ["plain", "S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  scopes_supported: ["openid", "email"] };
const GMAIL = "https://gmailmcp.googleapis.com/mcp/v1";
/** Recorded from Google on 2026-11-12: initialize answers 200, the protected resource names accounts.google.com, which has no registration endpoint. */
const google = () => fakeFetch({
  [GMAIL]: ok({ jsonrpc: "2.0", id: 1, result: {} }),
  "https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1": ok({ authorization_servers: ["https://accounts.google.com/"], bearer_methods_supported: ["header"],
    resource: GMAIL, scopes_supported: ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.readonly"] }),
  "https://accounts.google.com/.well-known/oauth-authorization-server": ok(GOOGLE_AS),
});
const challenge = (metadata?: string) => new Response("{}", { status: 401, headers: { "www-authenticate": `Bearer${metadata ? ` resource_metadata="${metadata}",` : ""} scope="files.read"` } });
const dcr = { issuer: "https://auth.vendor.test", authorization_endpoint: "https://auth.vendor.test/authorize", token_endpoint: "https://auth.vendor.test/token",
  registration_endpoint: "https://auth.vendor.test/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] };

describe("auth probing", () => {
  it("detects that Google needs an administrator's OAuth client, although initialize succeeds", async () => {
    const { fetcher, seen } = google();
    expect(await probeAuth(fetcher, GMAIL, "streamable-http", "public")).toEqual({ kind: "oauth", issuer: "https://accounts.google.com", registration: "client" });
    expect(seen[0]).toMatchObject({ url: GMAIL, method: "POST" });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ method: "initialize" });
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });
  it("follows a 401's resource metadata to a server with dynamic registration", async () => {
    const { fetcher } = fakeFetch({
      "https://mcp.vendor.test/mcp": challenge("https://mcp.vendor.test/.well-known/oauth-protected-resource/mcp"),
      "https://mcp.vendor.test/.well-known/oauth-protected-resource/mcp": ok({ resource: "https://mcp.vendor.test/mcp", authorization_servers: ["https://auth.vendor.test"] }),
      "https://auth.vendor.test/.well-known/oauth-authorization-server": ok(dcr),
    });
    expect(await probeAuth(fetcher, "https://mcp.vendor.test/mcp", "streamable-http", "public")).toEqual({ kind: "oauth", issuer: "https://auth.vendor.test", registration: "dynamic" });
  });
  it.each([
    ["an open server", { "https://open.test/mcp": ok({}) }, { kind: "none" }],
    ["a 401 whose origin is its own authorization server", { "https://old.test/mcp": challenge(),
      "https://old.test/.well-known/oauth-authorization-server": ok({ ...dcr, issuer: "https://old.test", authorization_endpoint: "https://old.test/a", token_endpoint: "https://old.test/t", registration_endpoint: undefined }) },
      { kind: "oauth", issuer: "https://old.test", registration: "client" }],
    ["a 401 without any metadata", { "https://bare.test/mcp": challenge() }, { kind: "oauth", issuer: null, registration: "dynamic" }],
    ["an unreachable server", { "https://down.test/mcp": () => { throw new TypeError("fetch failed"); } }, { kind: "oauth", issuer: null, registration: "dynamic" }],
    ["a server error", { "https://busy.test/mcp": new Response("", { status: 503 }) }, { kind: "oauth", issuer: null, registration: "dynamic" }],
    ["metadata naming an unreachable authorization server", { "https://half.test/mcp": challenge(),
      "https://half.test/.well-known/oauth-protected-resource/mcp": ok({ authorization_servers: ["https://as.half.test/"] }), "https://as.half.test/*": new Response("", { status: 502 }) },
      { kind: "oauth", issuer: "https://as.half.test", registration: "dynamic" }],
  ] as const)("classifies %s", async (_name, routes, expected) => {
    const url = Object.keys(routes)[0]!;
    expect(await probeAuth(fakeFetch(routes as never).fetcher, url, "streamable-http", "public")).toEqual(expected);
  });
  it("refuses metadata for another resource or a moved authorization server at sign-in", async () => {
    const moved = google();
    moved.routes["https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1"] = ok({ authorization_servers: ["https://evil.test"], resource: GMAIL });
    await expect(discover(moved.fetcher, GMAIL, "streamable-http", "public", "https://accounts.google.com")).rejects.toMatchObject({ code: "oauth_failed" });
    const other = google();
    other.routes["https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1"] = ok({ authorization_servers: ["https://accounts.google.com"], resource: "https://other.test/mcp" });
    await expect(discover(other.fetcher, GMAIL, "streamable-http", "public", null)).rejects.toMatchObject({ code: "oauth_failed" });
  });
});

describe("authorization", () => {
  it("builds Google's URL with its default parameters, the resource, PKCE and advertised scopes", async () => {
    const discovery = await discover(google().fetcher, GMAIL, "streamable-http", "public", "https://accounts.google.com");
    expect(discovery).toMatchObject({ resource: GMAIL, scopes: ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.readonly"], server: { issuer: "https://accounts.google.com" } });
    const url = new URL(authorizationUrl({ discovery, clientId: "client.apps.googleusercontent.com", redirectUri: "https://baskule.test/api/baskule/plugins/oauth/callback", state: "s",
      challenge: "c", scopes: requestedScopes(discovery, null), params: parseAuthorizationParams(ISSUER_DEFAULT_PARAMS["https://accounts.google.com"]!)! }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ access_type: "offline", prompt: "consent", response_type: "code", client_id: "client.apps.googleusercontent.com",
      redirect_uri: "https://baskule.test/api/baskule/plugins/oauth/callback", state: "s", code_challenge: "c", code_challenge_method: "S256", resource: GMAIL,
      scope: "https://mail.google.com/ https://www.googleapis.com/auth/gmail.readonly" });
    expect(requestedScopes(discovery, "openid  email")).toEqual(["openid", "email"]);
    expect(parseAuthorizationParams("redirect_uri=https://evil.test")).toBeNull();
    expect(parseAuthorizationParams("?hd=example.com&prompt=select_account")?.get("hd")).toBe("example.com");
  });

  it("registers a public client with the callback", async () => {
    const { fetcher, seen } = fakeFetch({ "https://auth.vendor.test/register": ok({ client_id: "registered" }, { status: 201 }) });
    const client = await registerClient(fetcher, { resource: null, scopes: [], server: dcr }, "https://baskule.test/cb", "public");
    expect(client).toEqual({ clientId: "registered", method: "none" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ client_name: "Baskule", redirect_uris: ["https://baskule.test/cb"], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", application_type: "web" });
    await expect(registerClient(fetcher, { resource: null, scopes: [], server: GOOGLE_AS }, "https://baskule.test/cb", "public")).rejects.toMatchObject({ code: "oauth_client_required" });
  });

  it("keeps the refresh token through outages and expires it only on invalid_grant", async () => {
    const token = (answer: Response | (() => never)) => exchangeToken(fakeFetch({ "https://oauth2.googleapis.com/token": answer as Response }).fetcher, "https://oauth2.googleapis.com/token", GMAIL,
      { clientId: "id", clientSecret: "s3cret", method: "client_secret_basic" }, { grant_type: "refresh_token", refresh_token: "r" }, ["a"], "public");
    await expect(token(ok({ error: "invalid_grant" }, { status: 400 }))).rejects.toEqual(new TokenError("expired"));
    for (const answer of [new Response("", { status: 503 }), new Response("", { status: 429 }), ok({ error: "invalid_client" }, { status: 401 }), () => { throw new TypeError("offline"); }])
      await expect(token(answer as never)).rejects.toEqual(new TokenError("unavailable"));
    const claims = Buffer.from(JSON.stringify({ email: "ada@example.com" })).toString("base64url");
    const { fetcher, seen } = fakeFetch({ "https://oauth2.googleapis.com/token": ok({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: `h.${claims}.s` }) });
    const tokens = await exchangeToken(fetcher, "https://oauth2.googleapis.com/token", GMAIL, { clientId: "id", clientSecret: "s3cret", method: "client_secret_basic" },
      { grant_type: "authorization_code", code: "c" }, ["a"], "public");
    expect(tokens).toMatchObject({ accessToken: "at", scopes: ["a"], account: "ada@example.com" });
    expect(tokens).not.toHaveProperty("refreshToken");
    expect(seen[0]!.headers.authorization).toBe(`Basic ${btoa("id:s3cret")}`);
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({ grant_type: "authorization_code", code: "c", resource: GMAIL });
  });
});
