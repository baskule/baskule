import { fakeOAuth } from "../fixtures/oauth.mjs";

export async function checkConnections(req, check, admin, alice) {
  const f = await fakeOAuth();
  f.state.shortLived = true;
  const API = "/api/baskule";
  const A = { cookie: admin.cookie }, U = { cookie: alice.cookie };
  let pluginId;
  try {
    const installed = await req("POST", `${API}/admin/plugins`, { ...A, body: { groups: [], source: { type: "url", url: f.resource } } });
    pluginId = installed.json.id;
    check("OAuth fake MCP installed", installed.status === 201, installed.text);
    const configured = await req("PATCH", `${API}/admin/plugins/${pluginId}`, { ...A, body: { enabled: true, servers: [{ name: "remote", credential: "user-oauth", personal: true }] } });
    check("OAuth personal credential configured", configured.status === 200, configured.text);
    await req("PATCH", `${API}/admin/groups/everyone`, { ...A, body: { plugins: [pluginId] } });
    const me = await req("GET", `${API}/me`, U);
    const space = me.json.spaces.find(s => s.kind === "personal").id;
    const input = { pluginId, server: "remote" };
    const invoke = (spaceId = space) => req("POST", `/s/${spaceId}/_echo/plugin-call`, { ...U, body: input });
    check("private credential seam needs the user's connection", (await invoke()).json.error === "connect");
    const start = await req("GET", `${API}/plugins/${pluginId}/connect`, U);
    check("connect redirects to discovered authorization server", start.status === 302 && new URL(start.headers.get("location")).origin === f.issuer, start.text);
    const authorization = await fetch(start.headers.get("location"), { redirect: "manual" });
    const callback = new URL(authorization.headers.get("location"));
    const bobAttempt = await req("GET", callback.pathname + callback.search, A);
    check("OAuth state is bound to the initiating user", bobAttempt.status === 302 && bobAttempt.headers.get("location").includes("connectionError=invalid_oauth_state"));
    const done = await req("GET", callback.pathname + callback.search, U);
    check("real ControlCell exchanges PKCE code on celld", done.status === 302 && done.headers.get("location").includes("pluginConnection=connected") && f.state.exchanges === 1, done.text);
    f.state.shortLived = false;
    const called = await invoke();
    check("credential refresh reaches protected fake MCP", called.json.status === 200 && called.json.result.result.content[0].text === "private fixture document" && f.state.refreshes === 1, called.text);
    check("code and refresh requests bind the MCP audience", f.requests.length === 2 && f.requests.every(r => r.resource === f.resource));
    const mine = await req("GET", `${API}/plugins`, U);
    check("user list reports connected without OAuth tokens", mine.json.plugins.find(p => p.id === pluginId)?.servers[0].status === "ready" && !mine.text.includes("accessToken") && !mine.text.includes("refreshToken"), mine.text);
    const team = (await req("POST", `${API}/spaces`, { ...A, body: { name: "OAuth policy team", members: [{ userId: alice.userId }] } })).json.space.id;
    try {
      check("team refuses personal accounts by default", (await invoke(team)).json.error === "unavailable");
      await req("PUT", `${API}/spaces/${team}/plugins`, { ...A, body: { personalPluginsAllowed: true, disabled: [] } });
      check("owner opt-in permits the turn author's account", (await invoke(team)).json.status === 200);
    } finally { await req("DELETE", `${API}/spaces/${team}`, A); }
    check("callback state is single-use", (await req("GET", callback.pathname + callback.search, U)).headers.get("location").includes("connectionError=invalid_oauth_state"));
    await req("DELETE", `${API}/plugins/${pluginId}/connection`, U);
    check("disconnect immediately prevents credential use", (await invoke()).json.error === "connect");
  } finally {
    if (pluginId) await req("DELETE", `${API}/admin/plugins/${pluginId}`, A);
    await f.close();
  }
}
