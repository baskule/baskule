#!/usr/bin/env node
// WP-C integration checks against a running celld dev (see test/integration.sh). Node >= 22 (fetch, WebSocket).
//   node test/integration/run.mjs http://127.0.0.1:47620 phase1|phase2
//   node test/integration/run.mjs http://127.0.0.1:47620 phase1 --only transcriptions
import { waitFor } from "../../src/space/test/rpc-client.mjs";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { checkPlugins } from "./plugins.mjs";
import { BASKULE_TRANSCRIPTION_MAX_BYTES } from "../../../app/packages/contracts/src/baskule.ts";

const B = process.argv[2] ?? "http://127.0.0.1:47620";
const PHASE = process.argv[3] ?? "phase1";
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
if (ONLY !== null && (ONLY !== "transcriptions" || PHASE !== "phase1")) throw new Error("Expected phase1 --only transcriptions");
const STATE = new URL("../.run/state.json", import.meta.url);
const ORIGIN = B;
const ADMIN = { email: "admin@it.test", password: "it-admin-password-1" };
let passed = 0;
const results = [];

function check(name, cond, detail = "") {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    for (const r of results) console.error(`  ok ${r}`);
    process.exit(1);
  }
  passed++;
  results.push(name);
  console.log(`ok   ${name}`);
}

async function req(method, path, { cookie, bearer, body, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (origin) h.origin = origin;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(B + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c.startsWith("baskule.") && !c.endsWith("=")).join("; ");

async function signIn(email, password) {
  const r = await req("POST", "/auth/sign-in/email", { body: { email, password } });
  if (r.status !== 200) return { status: r.status };
  const cookie = cookieOf(r);
  const bearer = r.headers.get("set-auth-token");
  const me = await req("GET", "/api/baskule/me", { cookie });
  return { status: 200, cookie, bearer, me: me.json, userId: me.json.user.id, sessionId: me.json.session.id };
}

/** Raw upgrade attempt: resolves with the HTTP status (101 when accepted). */
function rawUpgrade(path, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(B + path);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    r.on("upgrade", (res, sock) => { sock.destroy(); resolve(res.statusCode); });
    r.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", reject);
    r.end();
  });
}

/** Opens a WebSocket and collects messages; `closed` resolves with {code, reason}. */
function openWs(path, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(B.replace(/^http/, "ws") + path, { headers });
    const msgs = [];
    let resolveClosed;
    const closed = new Promise((r) => (resolveClosed = r));
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
    ws.onclose = (e) => resolveClosed({ code: e.code, reason: e.reason });
    ws.onerror = () => {};
    ws.onopen = async () => {
      for (let i = 0; i < 50 && !msgs.length; i++) await sleep(100); // no-fixed-sleep-allow: Poll the first WebSocket frame with a bounded retry count.
      resolve({ ws, msgs, closed });
    };
    setTimeout(() => reject(new Error(`ws ${path} did not open`)), 15000);
    closed.then((c) => reject(new Error(`ws ${path} closed before open: ${c.code}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

async function transcriptions(admin) {
  const A = { cookie: admin.cookie };
  const current = await req("GET", "/api/baskule/admin/settings", A);
  const { apiKeyConfigured: _chat, transcriptionApiKeyConfigured: _voice, authentication: _auth, ...settings } = current.json;
  const key = "fake-transcription-key";
  const uploads = [];
  const provider = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers["content-type"] } }).formData();
      const file = form.get("file");
      uploads.push({ path: request.url, method: request.method, authorization: request.headers.authorization,
        model: form.get("model"), format: form.get("response_format"), filename: file?.name, type: file?.type, audio: await file?.text() });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "  Recorded through celld.  " }));
    } catch {
      response.writeHead(400);
      response.end("invalid multipart");
    }
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  try {
    const endpoint = `http://127.0.0.1:${provider.address().port}`;
    const saved = await req("PATCH", "/api/baskule/admin/settings", { ...A, body: {
      ...settings, transcription: { enabled: true, providerId: "custom", baseUrl: endpoint, model: "fake-transcribe" }, transcriptionApiKey: key,
    } });
    if (saved.status !== 200) throw new Error(`Transcription settings: HTTP ${saved.status} ${saved.text}`);
    const headers = { origin: ORIGIN, cookie: admin.cookie, "content-type": "audio/webm;codecs=opus" };
    const recording = await fetch(B + "/api/baskule/transcriptions", { method: "POST", headers, body: "small fake recording" });
    const text = await recording.text();
    if (recording.status !== 200) throw new Error(`Transcription: HTTP ${recording.status} ${text}`);
    const oversized = await fetch(B + "/api/baskule/transcriptions", {
      method: "POST", headers, body: new Uint8Array(BASKULE_TRANSCRIPTION_MAX_BYTES + 1),
    });
    const tooLarge = await oversized.json();
    check("transcriptions: real celld multipart forwarding and upload cap", text === JSON.stringify({ text: "Recorded through celld." }) &&
      JSON.stringify(uploads) === JSON.stringify([{ path: "/audio/transcriptions", method: "POST", authorization: `Bearer ${key}`,
        model: "fake-transcribe", format: "json", filename: "audio.webm", type: "audio/webm;codecs=opus", audio: "small fake recording" }]) &&
      oversized.status === 413 && tooLarge.error === "audio_too_large", JSON.stringify({ status: recording.status, text, uploads, oversized: oversized.status, tooLarge }));
  } finally {
    await req("PATCH", "/api/baskule/admin/settings", { ...A, body: settings });
    await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  }
}

async function phase1() {
  // 1. bootstrap admin
  const admin = await signIn(ADMIN.email, ADMIN.password);
  check("bootstrap admin signs in (cookie + signed bearer)", admin.status === 200 && admin.cookie.startsWith("baskule.session_token=") && admin.bearer?.includes("."));
  check("me: admin with role and personal space", admin.me.user.role === "admin" && admin.me.spaces.length === 1 && admin.me.spaces[0].kind === "personal" && admin.me.organization.name === "Baskule");
  check("me without session → 401", (await req("GET", "/api/baskule/me")).status === 401);
  check("public sign-up disabled", (await req("POST", "/auth/sign-up/email", { body: { email: "x@it.test", password: "password-123", name: "X" } })).status === 404);
  await transcriptions(admin);

  // 2. create users
  const A = { cookie: admin.cookie };
  for (const [email, name] of [["alice@it.test", "Alice"], ["bob@it.test", "Bob"]]) {
    const r = await req("POST", "/api/baskule/admin/users", { ...A, body: { email, name, password: "it-user-password-1" } });
    check(`admin creates ${name}`, r.status === 201, JSON.stringify(r.json));
  }
  const cross = await req("POST", "/api/baskule/admin/users", { ...A, origin: "http://evil.test", body: { email: "e@it.test", name: "E", password: "it-user-password-1" } });
  check("cross-origin admin POST refused (403)", cross.status === 403);
  const noOrigin = await req("POST", "/api/baskule/admin/users", { ...A, origin: null, body: { email: "e@it.test", name: "E", password: "it-user-password-1" } });
  check("cookie POST without Origin refused (403)", noOrigin.status === 403);

  const alice = await signIn("alice@it.test", "it-user-password-1");
  const bob = await signIn("bob@it.test", "it-user-password-1");
  check("alice signs in with cookie", alice.status === 200 && alice.me.spaces.length === 1);
  const bobMe = await req("GET", "/api/baskule/me", { bearer: bob.bearer, origin: null });
  check("bob uses the bearer token (Android path)", bobMe.status === 200 && bobMe.json.user.email === "bob@it.test");
  const rawToken = bob.bearer.split(".")[0];
  check("unsigned raw session token refused", (await req("GET", "/api/baskule/me", { bearer: rawToken, origin: null })).status === 401);
  check("bob cannot use admin endpoints (403)", (await req("GET", "/api/baskule/admin/users", { bearer: bob.bearer, origin: null })).status === 403);
  check("better auth admin routes blocked", (await req("POST", "/auth/admin/impersonate-user", { ...A, body: { userId: bob.userId } })).status === 404);
  await checkPlugins(req, check, admin, alice);

  // 3. team space
  const acmeR = await req("POST", "/api/baskule/spaces", { ...A, body: { name: "Acme", members: [{ email: "alice@it.test" }, { email: "bob@it.test" }] } });
  check("admin creates team space Acme with Alice and Bob", acmeR.status === 201 && acmeR.json.members.length === 3);
  const acme = acmeR.json.space.id;
  const aliceSpaces = (await req("GET", "/api/baskule/me", { cookie: alice.cookie })).json.spaces;
  check("alice sees Personal + Acme", aliceSpaces.map((s) => s.name).join(",") === "Personal,Acme" && aliceSpaces[1].role === "member");
  const alicePersonal = aliceSpaces[0].id;

  // 4. forwarding with identity
  const fw = await req("POST", `/s/${acme}/some/path?q=1`, {
    cookie: alice.cookie + "; theme=dark",
    body: { hi: 1 },
    headers: { "x-baskule-identity": "Zm9yZ2Vk", "X-Baskule-Base": "/s/evil", "x-baskule-internal": "1", "x-baskule-webhook": "1" },
  });
  check("member request forwarded to SpaceCell with stripped path", fw.status === 200 && fw.json.stub === "EchoSpaceCell" && fw.json.path === "/some/path" && fw.json.search === "?q=1" && fw.json.body === '{"hi":1}');
  check("forged x-baskule-* headers are replaced/stripped", JSON.stringify(Object.keys(fw.json.baskuleHeaders).sort()) === '["x-baskule-base","x-baskule-identity"]' && fw.json.baskuleHeaders["x-baskule-base"] === `/s/${acme}`);
  check("identity header = alice (contract fields)", JSON.stringify(fw.json.identity) === JSON.stringify({ userId: alice.userId, name: "Alice", email: "alice@it.test", role: "member", sessionId: alice.sessionId, spaceRole: "member" }));
  check("Better Auth cookie and Authorization not forwarded", fw.json.cookie === "theme=dark" && fw.json.hasAuthorization === false);
  const fwBob = await req("GET", `/s/${acme}/`, { bearer: bob.bearer, origin: null });
  check("bob (bearer) forwarded as bob", fwBob.status === 200 && fwBob.json.identity.userId === bob.userId);
  check("non-member (bob → alice's personal) → 404", (await req("GET", `/s/${alicePersonal}/x`, { bearer: bob.bearer, origin: null })).status === 404);
  check("unknown space → 404", (await req("GET", `/s/0123456789abcdef/x`, { cookie: alice.cookie })).status === 404);
  check("no session → 401", (await req("GET", `/s/${acme}/x`)).status === 401);
  check("admin cannot read alice's personal space (404)", (await req("GET", `/s/${alicePersonal}/`, A)).status === 404);
  check("admin cannot read alice's personal space via API (404)", (await req("GET", `/api/baskule/spaces/${alicePersonal}`, A)).status === 404);
  for (const p of [`/s/${acme}/_baskule/status`, `/s/${acme}/%5Fbaskule/status`, `/s/${acme}//_baskule/revoke`])
    check(`internal route blocked: ${p}`, (await req("GET", p, { cookie: alice.cookie })).status === 404);
  check("cross-origin POST to a space refused", (await req("POST", `/s/${acme}/x`, { cookie: alice.cookie, origin: "http://localhost:3000", body: {} })).status === 403);
  check("PUBLIC_ORIGINS origin accepted", (await req("POST", `/s/${acme}/x`, { cookie: alice.cookie, origin: "http://allowed.test:47090", body: {} })).status === 200);

  // 5. WebSockets: origin + session on upgrade
  check("cross-origin WS upgrade refused (403)", (await rawUpgrade(`/s/${acme}/ws`, { cookie: alice.cookie, origin: "http://evil.test" })) === 403);
  check("same-host-other-port WS upgrade refused (403)", (await rawUpgrade(`/s/${acme}/ws`, { cookie: alice.cookie, origin: B.replace(/:\d+$/, ":32400") })) === 403);
  check("cookie WS upgrade without Origin refused (403)", (await rawUpgrade(`/s/${acme}/ws`, { cookie: alice.cookie })) === 403);
  check("WS upgrade without session refused (401)", (await rawUpgrade(`/s/${acme}/ws`, { origin: ORIGIN })) === 401);
  check("WS upgrade by non-member refused (404)", (await rawUpgrade(`/s/${alicePersonal}/ws`, { authorization: `Bearer ${bob.bearer}` })) === 404);
  const wsA = await openWs(`/s/${acme}/ws`, { cookie: alice.cookie, origin: ORIGIN });
  check("alice WS upgrade accepted with identity", wsA.msgs[0]?.identity?.userId === alice.userId && wsA.msgs[0]?.base === `/s/${acme}`);
  const wsB = await openWs(`/s/${acme}/ws`, { authorization: `Bearer ${bob.bearer}` });
  check("bob WS upgrade (bearer, no Origin) accepted", wsB.msgs[0]?.identity?.userId === bob.userId);
  wsB.ws.send("ping");
  await waitFor("WebSocket ping echo", () => wsB.msgs.some((m) => m.echo === "ping"), 5000);
  check("WS round trip through the Worker", wsB.msgs.some((m) => m.echo === "ping"));

  // 6. revocation: member removal closes bob's socket at once, alice's stays
  const t0 = Date.now();
  const rm = await req("DELETE", `/api/baskule/spaces/${acme}/members/${bob.userId}`, A);
  const c = await within(wsB.closed, 5000);
  check("admin removes bob from Acme → bob's open socket closed", rm.status === 200 && c?.code === 4401, JSON.stringify(c));
  console.log(`     (closed ${Date.now() - t0} ms after the request)`);
  check("bob's next request → 404", (await req("GET", `/s/${acme}/`, { bearer: bob.bearer, origin: null })).status === 404);
  wsA.ws.send("still-open");
  await waitFor("Alice round trip after Bob revoked", () => wsA.msgs.some((m) => m.echo === "still-open"), 5000);
  check("alice's socket still open", wsA.ws.readyState === WebSocket.OPEN);
  const rc = await req("GET", `/s/${acme}/_echo/recheck`, { cookie: alice.cookie });
  check("60 s recheck path SpaceCell → ControlCell /_baskule/check (stub)", rc.json?.checked >= 1 && rc.json.closed === 0, JSON.stringify(rc.json));
  const cachedOv = await req("GET", "/api/baskule/admin/spaces", A);
  check("admin overview uses cached status by default", cachedOv.status === 200 && cachedOv.json.spaces.find((s) => s.id === acme)?.status === null);
  const st = await req("GET", "/api/baskule/admin/spaces?status=live", A);
  const acmeSt = st.json.spaces.find((s) => s.id === acme);
  check("admin overview shows SpaceCell status via /_baskule/status", acmeSt?.status?.awake === true && acmeSt.status.sockets >= 1 && acmeSt.members.length === 2);
  const stop = await req("POST", `/api/baskule/admin/spaces/${acme}/stop`, A);
  check("admin stops a space's agent and computer (POST /_baskule/stop on the stub)", stop.status === 200 && stop.json.status?.stops === 1 && stop.json.status.computer === "stopped", JSON.stringify(stop.json));
  check("members cannot stop spaces (403)", (await req("POST", `/api/baskule/admin/spaces/${acme}/stop`, { cookie: alice.cookie })).status === 403);
  check("admin overview never lists personal members", st.json.spaces.filter((s) => s.kind === "personal").every((s) => s.members === undefined && s.owner?.email));

  // 7. sign-out revokes that session's sockets
  const alice2 = await signIn("alice@it.test", "it-user-password-1");
  const wsP = await openWs(`/s/${alicePersonal}/ws`, { cookie: alice2.cookie, origin: ORIGIN });
  const so = await req("POST", "/auth/sign-out", { cookie: alice2.cookie, body: {} });
  const cp = await within(wsP.closed, 5000);
  check("sign-out closes that session's socket", so.status === 200 && cp?.code === 4401, JSON.stringify(cp));
  check("sign-out sends Clear-Site-Data", so.headers.get("clear-site-data")?.includes("storage"));
  check("signed-out cookie → 401", (await req("GET", `/s/${alicePersonal}/`, { cookie: alice2.cookie })).status === 401);
  check("other session of alice unaffected", wsA.ws.readyState === WebSocket.OPEN && (await req("GET", "/api/baskule/me", { cookie: alice.cookie })).status === 200);
  wsA.ws.close();

  // 8. invitations
  check("member cannot invite (403)", (await req("POST", "/api/baskule/invitations", { cookie: alice.cookie, body: { email: "carol@it.test" } })).status === 403);
  const inv = await req("POST", "/api/baskule/invitations", { ...A, body: { email: "carol@it.test", spaces: [{ spaceId: acme }] } });
  check("admin creates invitation link", inv.status === 201 && inv.json.url.startsWith(`${ORIGIN}/invite#token=`));
  const lk = await req("POST", "/api/baskule/invitations/lookup", { body: { token: inv.json.token }, origin: null });
  check("invitation lookup (public)", lk.status === 200 && lk.json.email === "carol@it.test" && lk.json.spaces[0].name === "Acme");
  check("invitation bound to its email", (await req("POST", "/api/baskule/invitations/accept", { body: { token: inv.json.token, name: "M", password: "mallory-pw-1", email: "mallory@it.test" }, origin: null })).status === 400);
  const acc = await req("POST", "/api/baskule/invitations/accept", { body: { token: inv.json.token, name: "Carol", password: "carol-password-1" }, origin: null });
  check("accept creates the account + Acme membership + session", acc.status === 201 && acc.json.user.email === "carol@it.test" && acc.json.spaces.map((s) => s.name).join() === "Personal,Acme" && cookieOf(acc));
  check("invitation is single-use", (await req("POST", "/api/baskule/invitations/accept", { body: { token: inv.json.token, name: "Carol", password: "carol-password-2" }, origin: null })).status === 404);
  const carolFw = await req("GET", `/s/${acme}/`, { cookie: cookieOf(acc) });
  check("carol enters Acme with her identity", carolFw.status === 200 && carolFw.json.identity.email === "carol@it.test");

  // 8b. connection links: discovery document, one-time code → a new session for another device
  const wk = await req("GET", "/.well-known/baskule", { origin: null });
  check("discovery document is public", wk.status === 200 && wk.json.product === "baskule" && typeof wk.json.name === "string");
  const connectCode = await req("POST", "/auth/connect/code", { cookie: cookieOf(acc), body: {} });
  check("signed-in person issues a connect code", connectCode.status === 200 && connectCode.json.code.length >= 43);
  const rd = await req("POST", "/auth/connect/redeem", { body: { code: connectCode.json.code }, origin: null });
  const phone = rd.headers.get("set-auth-token");
  const phoneMe = phone && (await req("GET", "/api/baskule/me", { bearer: phone, origin: null }));
  check("the code signs another device in as the same person", rd.status === 200 && phoneMe?.json?.user.email === "carol@it.test");
  check("a connect code is single-use", (await req("POST", "/auth/connect/redeem", { body: { code: connectCode.json.code }, origin: null })).status === 404);

  // 9. password reset revokes sessions (and their sockets)
  const bob2 = await signIn("bob@it.test", "it-user-password-1");
  const bobPersonal = bob2.me.spaces.find((s) => s.kind === "personal").id;
  const wsR = await openWs(`/s/${bobPersonal}/ws`, { authorization: `Bearer ${bob2.bearer}` });
  check("admin cannot set the password of a signed-in account (409)", (await req("POST", `/api/baskule/admin/users/${bob.userId}/password`, { ...A, body: { password: "admin-chosen-pw" } })).status === 409);
  const link = await req("POST", `/api/baskule/admin/users/${bob.userId}/reset-link`, A);
  const rs = await req("POST", "/auth/reset-password", { body: { token: link.json.token, newPassword: "bob-new-password-1" } });
  const cr = await within(wsR.closed, 5000);
  check("password reset closes the person's sockets", rs.status === 200 && cr?.code === 4401, JSON.stringify(cr));
  check("password reset revokes all sessions (bearer 1)", (await req("GET", "/api/baskule/me", { bearer: bob.bearer, origin: null })).status === 401);
  check("password reset revokes all sessions (bearer 2)", (await req("GET", "/api/baskule/me", { bearer: bob2.bearer, origin: null })).status === 401);
  check("new password works", (await signIn("bob@it.test", "bob-new-password-1")).status === 200);

  // 10. deactivation
  const carol = await signIn("carol@it.test", "carol-password-1");
  const wsC = await openWs(`/s/${acme}/ws`, { cookie: carol.cookie, origin: ORIGIN });
  const da = await req("POST", `/api/baskule/admin/users/${carol.userId}/deactivate`, A);
  const cc = await within(wsC.closed, 5000);
  check("deactivate closes sockets", da.status === 200 && cc?.code === 4401, JSON.stringify(cc));
  check("deactivated: requests 401", (await req("GET", `/s/${acme}/`, { cookie: carol.cookie })).status === 401);
  check("deactivated: sign-in refused", (await signIn("carol@it.test", "carol-password-1")).status === 403);

  // 11. webhooks
  const wh = await req("POST", `/hooks/${acme}/task-1/secret-token?src=gh`, { body: { event: "push" }, origin: null, headers: { "x-baskule-identity": "Zm9yZ2Vk" } });
  check("webhook forwarded without user auth to /api/hooks/*", wh.status === 200 && wh.json.path === "/api/hooks/task-1/secret-token" && wh.json.search === "?src=gh" && wh.json.identity === null && wh.json.baskuleHeaders["x-baskule-webhook"] === "1");
  check("webhook to unknown space → 404", (await req("POST", `/hooks/0123456789abcdef/task-1/x`, { body: {}, origin: null })).status === 404);

  // 12. downloads + static
  const dl = await req("GET", "/api/baskule/downloads");
  check("downloads listing", dl.status === 200 && dl.json.files[0]?.name === "Baskule-0.2.0-test.AppImage", JSON.stringify({ status: dl.status, body: dl.json ?? dl.text }));
  const f = await fetch(B + dl.json.files[0].url);
  check("download served as attachment", f.status === 200 && (await f.text()) === "fake desktop artifact\n" && f.headers.get("content-disposition")?.includes("attachment"));
  const spa = await req("GET", "/some/client/route");
  check("SPA fallback serves the web bundle", spa.status === 200 && spa.text.includes("<title>Baskule</title>"));
  check("unknown /api path → 404 JSON", (await req("GET", "/api/nope")).status === 404);

  writeFileSync(STATE, JSON.stringify({ acme, aliceCookie: alice.cookie, alicePersonal }));
}

async function phase2() {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  const admin = await signIn(ADMIN.email, ADMIN.password);
  check("after restart: admin signs in (no second bootstrap)", admin.status === 200);
  const users = await req("GET", "/api/baskule/admin/users", { cookie: admin.cookie });
  check("after restart: accounts kept", users.json.users.map((u) => u.email).sort().join() === "admin@it.test,alice@it.test,bob@it.test,carol@it.test");
  const me = await req("GET", "/api/baskule/me", { cookie: s.aliceCookie });
  check("after restart: alice's session and spaces kept", me.status === 200 && me.json.spaces.map((x) => x.id).join() === `${s.alicePersonal},${s.acme}`);
  check("after restart: forwarding works", (await req("GET", `/s/${s.acme}/x`, { cookie: s.aliceCookie })).json?.identity?.email === "alice@it.test");
}

try {
  if (ONLY === "transcriptions") {
    const admin = await signIn(ADMIN.email, ADMIN.password);
    if (admin.status !== 200) throw new Error(`Transcription admin sign-in: HTTP ${admin.status}`);
    await transcriptions(admin);
  } else if (PHASE === "anonymous") {
    const me = await req("GET", "/api/baskule/me", { origin: null });
    const space = me.json.spaces[0].id;
    const forwarded = await req("POST", `/s/${space}/echo`, { origin: null, body: { anonymous: true } });
    check("anonymous native HTTP forwards the shared identity without credentials", forwarded.status === 200 && forwarded.json.identity.userId === "anonymous");
    check("anonymous browser and native upgrades need no bearer or ticket", await rawUpgrade(`/s/${space}/ws`, { origin: B }) === 101 && await rawUpgrade(`/s/${space}/ws`, {}) === 101);
    check("anonymous retains the Origin boundary", (await req("POST", `/s/${space}/echo`, { origin: "http://evil.test", body: {} })).status === 403);
  } else await (PHASE === "phase2" ? phase2() : phase1());
  console.log(`${PHASE}: ${passed} checks passed`);
} catch (e) {
  console.error(`ERROR after ${passed} checks:`, e);
  process.exit(1);
}
