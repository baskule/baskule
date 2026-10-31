import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

/** Separate fake resource and AS, shared by unit and stock-celld component checks. */
export async function fakeOAuth() {
  const state = { refreshes: 0, exchanges: 0, registrations: 0, invalidGrant: false, shortLived: false, scopes: "files.read", dcr: true, resourceMismatch: false, issuerMismatch: false, pkce: true, metadata: true, resourceParameter: true, advertisedIssuer: /** @type {string | null} */ (null), onRefresh: /** @type {null | (() => Promise<void>)} */ (null), onExchange: /** @type {null | (() => Promise<void>)} */ (null) };
  const codes = new Map();
  const refreshTokens = new Set();
  const accessTokens = new Set();
  const requests = [];
  const calls = [];
  const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  let issuer, resource;
  const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  const as = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, issuer);
      if (u.pathname === "/.well-known/oauth-authorization-server") return json(res, {
        issuer: state.issuerMismatch ? `${issuer}/other` : issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, ...(state.dcr ? { registration_endpoint: `${issuer}/register` } : {}),
        code_challenge_methods_supported: state.pkce ? ["S256"] : ["plain"], response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"], authorization_response_iss_parameter_supported: true,
      });
      if (u.pathname === "/register") { state.registrations++; return json(res, { client_id: "fake-client", token_endpoint_auth_method: "none" }, 201); }
      if (u.pathname === "/authorize") {
        if ((state.resourceParameter ? u.searchParams.get("resource") !== resource : u.searchParams.has("resource")) || u.searchParams.get("code_challenge_method") !== "S256") return json(res, { error: "invalid_request" }, 400);
        const code = randomUUID();
        codes.set(code, Object.fromEntries(u.searchParams));
        const callback = new URL(u.searchParams.get("redirect_uri"));
        for (const [key, value] of Object.entries({ code, state: u.searchParams.get("state"), iss: issuer })) callback.searchParams.set(key, value);
        res.writeHead(302, { location: callback.href }); return res.end();
      }
      if (u.pathname === "/token") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const p = new URLSearchParams(body);
        requests.push({ ...Object.fromEntries(p), authorization: req.headers.authorization });
        if ((state.resourceParameter ? p.get("resource") !== resource : p.has("resource"))) return json(res, { error: "invalid_target" }, 400);
        if (p.get("grant_type") === "authorization_code") {
          state.exchanges++;
          const c = codes.get(p.get("code")); codes.delete(p.get("code"));
          if (!c || c.client_id !== p.get("client_id") || c.redirect_uri !== p.get("redirect_uri") || c.code_challenge !== createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url")) return json(res, { error: "invalid_grant" }, 400);
          await state.onExchange?.();
        } else {
          state.refreshes++;
          if (state.invalidGrant || !refreshTokens.delete(p.get("refresh_token"))) return json(res, { error: "invalid_grant" }, 400);
          await state.onRefresh?.();
        }
        const token = randomUUID(), refresh = randomUUID();
        accessTokens.add(token); refreshTokens.add(refresh);
        return json(res, { access_token: token, refresh_token: refresh, expires_in: state.shortLived ? 1 : 3600, token_type: "Bearer", scope: state.scopes, resource });
      }
      json(res, {}, 404);
    } catch { json(res, { error: "fixture_failure" }, 500); }
  });
  issuer = await listen(as);
  const mcp = createServer(async (req, res) => {
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) {
      if (!state.metadata) return json(res, {}, 404);
      return json(res, { resource: state.resourceMismatch ? `${resource}/other` : resource, authorization_servers: [state.advertisedIssuer ?? issuer], scopes_supported: ["files.read"] });
    }
    if (!accessTokens.has(req.headers.authorization?.replace(/^Bearer /, ""))) {
      res.setHeader("www-authenticate", `Bearer resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp", scope="files.read"`);
      return json(res, { error: "unauthorized" }, 401);
    }
    if (req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      if (message.method === "initialize") return json(res, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1" } } });
      if (message.method === "tools/list") return json(res, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "fixture_lookup", description: "Read the private fixture", inputSchema: { type: "object", properties: {} } }] } });
      if (message.method === "tools/call") calls.push(message.params);
      return json(res, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "private fixture document" }] } });
    }
    json(res, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "private fixture document" }] } });
  });
  resource = `${await listen(mcp)}/mcp`;
  return { issuer, resource, state, requests, calls, close: async () => {
    for (const server of [mcp, as]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } };
}
