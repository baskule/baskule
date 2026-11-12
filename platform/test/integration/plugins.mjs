import { fakeOAuth } from "../fixtures/oauth.mjs";

/** Worker→ControlCell plugin wiring on celld: preview probing, install, member sign-in with PKCE and per-call credentials. */
export async function checkPlugins(req, check, admin, alice) {
  const f = await fakeOAuth();
  f.state.shortLived = true;
  const API = "/api/baskule";
  const A = { cookie: admin.cookie }, U = { cookie: alice.cookie };
  let pluginId;
  try {
    const ref = { kind: "custom", server: { displayName: "Fixture docs", url: f.resource, auth: "oauth" } };
    const preview = await req("POST", `${API}/admin/plugins/preview`, { ...A, body: { ref } });
    check("preview probes the server's sign-in on celld", preview.status === 200 && preview.json.servers[0].auth.kind === "oauth" && preview.json.servers[0].auth.registration === "dynamic", preview.text);
    check("members cannot preview plugins", (await req("POST", `${API}/admin/plugins/preview`, { ...U, body: { ref } })).status === 403);
    const installed = await req("POST", `${API}/admin/plugins`, { ...A, body: { ref, digest: preview.json.digest, access: { kind: "everyone" }, values: {} } });
    check("custom OAuth server installed for everyone and ready", installed.status === 201 && installed.json.status === "ready", installed.text);
    pluginId = installed.json.id;
    const serverId = installed.json.servers[0].id;
    const space = (await req("GET", `${API}/me`, U)).json.spaces.find(s => s.kind === "personal").id;
    const invoke = (spaceId = space) => req("POST", `/s/${spaceId}/_echo/plugin-call`, { ...U, body: { pluginId, serverId } });
    check("the private credential seam asks the member to sign in", (await invoke()).json.error === "sign_in_required");
    const start = await req("GET", `${API}/plugins/${pluginId}/servers/${serverId}/connect`, U);
    check("connect redirects to the discovered authorization server", start.status === 302 && new URL(start.headers.get("location")).origin === f.issuer, start.text);
    const authorization = await fetch(start.headers.get("location"), { redirect: "manual" });
    const callback = new URL(authorization.headers.get("location"));
    const stolen = await req("GET", callback.pathname + callback.search, A);
    check("sign-in state is bound to the member who started it", stolen.status === 302 && stolen.headers.get("location").includes("code=invalid_request"));
    const done = await req("GET", callback.pathname + callback.search, U);
    check("real ControlCell exchanges the PKCE code on celld", done.status === 302 && done.headers.get("location").includes("connection=connected") && f.state.exchanges === 1, done.text);
    check("callback state is single-use", (await req("GET", callback.pathname + callback.search, U)).headers.get("location").includes("code=invalid_request"));
    f.state.shortLived = false;
    const called = await invoke();
    check("token refresh reaches the protected fake MCP", called.json.status === 200 && called.json.result.result.content[0].text === "private fixture document" && f.state.refreshes === 1, called.text);
    check("code and refresh requests bind the MCP audience", f.requests.length === 2 && f.requests.every(r => r.resource === f.resource));
    const mine = await req("GET", `${API}/plugins`, U);
    check("member list reports the connection without tokens", mine.json.plugins.find(p => p.id === pluginId)?.servers[0].connection.state === "connected" && !mine.text.includes("accessToken") && !mine.text.includes("refresh"), mine.text);
    const team = (await req("POST", `${API}/spaces`, { ...A, body: { name: "OAuth policy team", members: [{ userId: alice.userId }] } })).json.space.id;
    try { check("team spaces use the turn author's own connection", (await invoke(team)).json.status === 200); }
    finally { await req("DELETE", `${API}/spaces/${team}`, A); }
    await req("PUT", `${API}/plugins/${pluginId}`, { ...U, body: { on: false } });
    check("the member's switch turns the plugin off for their calls", (await invoke()).json.error === "plugin_off");
    await req("PUT", `${API}/plugins/${pluginId}`, { ...U, body: { on: true } });
    await req("DELETE", `${API}/plugins/${pluginId}/servers/${serverId}/connection`, U);
    check("disconnect immediately prevents credential use", (await invoke()).json.error === "sign_in_required");
  } finally {
    if (pluginId) await req("DELETE", `${API}/admin/plugins/${pluginId}`, A);
    await f.close();
  }
}
