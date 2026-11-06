import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fakeOAuth } from "./oauth.mjs";

/** Stateless protocol fixture: confirmation, signed state, and confidential token forwarding. */
export async function fakeRelay() {
  const oauth = await fakeOAuth();
  const key = randomBytes(32);
  const requests = [];
  const state = { vendors: ["github", "microsoft"], unavailable: false, vendorRequests: 0, tokenError: /** @type {string | null} */ (null), tokenStatus: 502, tokenBody: /** @type {unknown} */ (null) };
  let origin;
  const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  const redirect = (res, location) => { res.writeHead(302, { location }); res.end(); };
  const sign = payload => createHmac("sha256", key).update(payload).digest("base64url");
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, origin);
      if (state.unavailable) return json(res, { error: "oauth_unavailable" }, 503);
      if (u.pathname === "/v1/vendors") {
        state.vendorRequests++;
        return json(res, { vendors: state.vendors.map(id => ({ id, clientId: "relay-client", tokenEndpointAuthMethod: "client_secret_post" })) });
      }
      if (u.pathname === "/v1/authorize") {
        const destination = new URL(u.searchParams.get("origin"));
        const authorization = new URL(u.searchParams.get("url"));
        const p = authorization.searchParams;
        if (!state.vendors.includes(u.searchParams.get("vendor"))) return json(res, { error: "relay_vendor_unavailable" }, 400);
        if (destination.href !== `${destination.origin}/` || !["http:", "https:"].includes(destination.protocol) || destination.username || destination.password ||
          authorization.origin !== oauth.issuer || authorization.pathname !== "/authorize" || p.get("response_type") !== "code" || p.get("client_id") !== "relay-client" ||
          p.get("redirect_uri") !== `${origin}/v1/callback` || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") || !p.get("state") || p.get("state").length > 512) return json(res, { error: "relay_invalid_request" }, 400);
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "text/html" });
          return res.end(`<p>Connect to ${destination.host}?</p><form method="post"><button>Continue</button></form>`);
        }
        const payload = Buffer.from(JSON.stringify({ v: 1, o: destination.origin, s: p.get("state"), d: u.searchParams.get("vendor"), e: Date.now() + 15 * 60_000 })).toString("base64url");
        p.set("state", `${payload}.${sign(payload)}`);
        return redirect(res, authorization.href);
      }
      if (u.pathname === "/v1/callback") {
        const [payload, signature] = (u.searchParams.get("state") ?? "").split(".");
        const expected = Buffer.from(sign(payload ?? ""));
        const received = Buffer.from(signature ?? "");
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) return json(res, { error: "relay_invalid_state" }, 400);
        const inner = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (inner.v !== 1 || inner.e <= Date.now()) return json(res, { error: "relay_invalid_state" }, 400);
        const callback = new URL("/api/baskule/plugins/oauth/callback", inner.o);
        callback.searchParams.set("state", inner.s);
        for (const name of ["code", "iss", "error", "error_description"]) if (u.searchParams.has(name)) callback.searchParams.set(name, u.searchParams.get(name));
        return redirect(res, callback.href);
      }
      if (u.pathname.startsWith("/v1/token/") && req.method === "POST") {
        if (!state.vendors.includes(u.pathname.slice("/v1/token/".length))) return json(res, { error: "relay_vendor_unavailable" }, 400);
        let body = ""; for await (const chunk of req) body += chunk;
        const p = new URLSearchParams(body);
        requests.push({ ...Object.fromEntries(p), authorization: req.headers.authorization });
        if (state.tokenBody) return json(res, state.tokenBody, state.tokenStatus);
        if (state.tokenError) return json(res, { error: state.tokenError }, state.tokenStatus);
        if (p.get("token_endpoint") !== `${oauth.issuer}/token` || !["authorization_code", "refresh_token"].includes(p.get("grant_type")) ||
          p.get("grant_type") === "authorization_code" && (p.get("redirect_uri") !== `${origin}/v1/callback` || !p.get("code") || !p.get("code_verifier")) ||
          p.get("grant_type") === "refresh_token" && !p.get("refresh_token")) return json(res, { error: "relay_invalid_request" }, 400);
        p.delete("token_endpoint"); p.delete("client_secret"); p.delete("client_id");
        p.set("client_id", "relay-client"); p.set("client_secret", "relay-secret");
        const response = await fetch(`${oauth.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: p });
        return json(res, await response.json(), response.status);
      }
      json(res, {}, 404);
    } catch { json(res, { error: "relay_vendor_unavailable" }, 502); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  Object.assign(oauth.client, { id: "relay-client", secret: "relay-secret", redirectUri: `${origin}/v1/callback` });
  oauth.state.dcr = false;
  return { origin, oauth, state, requests, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await oauth.close();
  } };
}
