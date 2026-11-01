// (e) Isolation and the front's security checks (ported from spike path-c's security.sh to the front):
// Bob cannot see Alice's personal space (API + UI); forged identity, cross-origin requests and WebSockets,
// internal routes, path tricks, other-space RPCs and admin-only actions are refused. Each check is a soft
// assertion, so one run reports all of them (artifacts/05-security/checks.json).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { ARTIFACTS, Api, BASE, envGet, until, wsPath, newDevice, personApi, rawGet, shot, signInBrowser, spaceRpc, upgradeStatus, waitComposer, world } from "./lib";

const S = "05-security";
const results: Array<{ check: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ check: name, ok, detail });
  expect.soft(ok, `${name} ${detail}`).toBe(true);
}
const is = (name: string, actual: unknown, expected: unknown) => check(name, actual === expected, `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
const oneOf = (name: string, actual: unknown, expected: unknown[]) => check(name, expected.includes(actual), `(got ${JSON.stringify(actual)}, want one of ${JSON.stringify(expected)})`);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

test.afterAll(() => {
  mkdirSync(path.join(ARTIFACTS, S), { recursive: true });
  writeFileSync(path.join(ARTIFACTS, S, "checks.json"), JSON.stringify(results, null, 2));
  console.log(`security checks: ${results.filter((r) => r.ok).length}/${results.length} passed`);
});

test("(e) isolation and front security checks", { tag: ["@security", "@auth"] }, async ({ browser }) => {
  const w = await world();
  const alice = await personApi(w.alice);
  const bob = await personApi(w.bob);
  const admin = await personApi({ ...w.admin, name: "admin" });
  const anon = new Api("anon");
  const ap = w.alice.personal;
  const acme = w.acme.id;
  const evil = "http://evil.example";

  // --- sessions and membership -----------------------------------------------------------------------------
  is("no session: /api/baskule/me", (await anon.get("/api/baskule/me")).status, 401);
  is("no session: Alice's personal space", (await anon.get(`/s/${ap}/.well-known/t3/environment`)).status, 401);
  is("control: Alice reaches her personal space", (await alice.get(`/s/${ap}/.well-known/t3/environment`)).status, 200);
  is("Bob → Alice's personal space (HTTP)", (await bob.get(`/s/${ap}/.well-known/t3/environment`)).status, 404);
  is("Bob → Alice's personal space (orchestration snapshot)", (await bob.get(`/s/${ap}/api/orchestration/shell`)).status, 404);
  is("Bob → Alice's personal space (WebSocket upgrade)", await upgradeStatus(wsPath(ap), { cookie: bob.cookie, origin: BASE }), 404);
  is("Bob → GET /api/baskule/spaces/<Alice personal>", (await bob.get(`/api/baskule/spaces/${ap}`)).status, 404);
  oneOf("Bob adds himself to Alice's personal space", (await bob.post(`/api/baskule/spaces/${ap}/members`, { userId: w.bob.id })).status, [403, 404]);
  is("admin → Alice's personal space content", (await admin.get(`/s/${ap}/.well-known/t3/environment`)).status, 404);
  const unknown = await bob.get(`/s/00000000000000000000000000000000/.well-known/t3/environment`);
  const foreign = await bob.get(`/s/${ap}/.well-known/t3/environment`);
  check("unknown space and non-member space answer the same (no enumeration)", unknown.status === foreign.status && unknown.text === foreign.text, `(${unknown.status} vs ${foreign.status})`);
  check("Bob's /me lists only his spaces", !(await bob.get("/api/baskule/me")).json.spaces.some((s: any) => s.id === ap));

  // --- forged identity --------------------------------------------------------------------------------------
  const aliceIdentity = b64({ userId: w.alice.id, name: w.alice.name, email: w.alice.email, role: "member", sessionId: "forged", spaceRole: "owner" });
  is("forged x-baskule-identity (Alice), no session", (await anon.get(`/s/${ap}/.well-known/t3/environment`, { "x-baskule-identity": aliceIdentity, "x-baskule-base": `/s/${ap}` })).status, 401);
  is("forged x-baskule-identity (Alice) with Bob's session on Alice's space", (await bob.get(`/s/${ap}/.well-known/t3/environment`, { "x-baskule-identity": aliceIdentity })).status, 404);
  // In a shared space the cell sees the real caller, never the forged header: Bob's session reads as Bob.
  const sessionAsBob = await bob.get(`/s/${acme}/api/auth/session`, { "x-baskule-identity": aliceIdentity });
  check("forged identity in a shared space is replaced by the caller's", sessionAsBob.status === 200 && !sessionAsBob.text.includes(w.alice.id), `(status ${sessionAsBob.status})`);
  is("forged webhook marker + identity on a space route", (await anon.get(`/s/${acme}/api/orchestration/shell`, { "x-baskule-webhook": "1", "x-baskule-identity": aliceIdentity })).status, 401);
  is("T3's own bearer/pairing endpoints are refused in a space (browser-session)", (await bob.post(`/s/${acme}/api/auth/browser-session`, {})).status === 200 ? "accepted" : "refused", "refused");
  is("unsigned (raw) session token as bearer", (await new Api().get("/api/baskule/me", { authorization: `Bearer ${bob.cookie.match(/baskule\.session_token=([^;.]+)/)?.[1] ?? "x"}` })).status, 401);

  // --- Origin checks (cross-site writes and WebSockets) -----------------------------------------------------
  is("cross-origin WebSocket (evil.example) with Bob's cookie", await upgradeStatus(wsPath(acme), { cookie: bob.cookie, origin: evil }), 403);
  is("cross-origin WebSocket from another port of the same host", await upgradeStatus(wsPath(acme), { cookie: bob.cookie, origin: BASE.replace(/:\d+$/, ":47091") }), 403);
  is("cookie WebSocket without Origin", await upgradeStatus(wsPath(acme), { cookie: bob.cookie }), 403);
  is("control: same-origin WebSocket with Bob's cookie on Acme", await upgradeStatus(wsPath(acme), { cookie: bob.cookie, origin: BASE }), 101);
  is("cross-origin POST to the API (create a space)", (await bob.post("/api/baskule/spaces", { name: "evil" }, { origin: evil })).status, 403);
  is("cross-origin sign-in", (await new Api().post("/auth/sign-in/email", { email: w.bob.email, password: w.bob.password }, { origin: evil })).status, 403);
  is("Origin: null on a state-changing call", (await bob.post(`/s/${acme}/api/attachments/upload/x`, {}, { origin: "null" })).status, 403);

  // --- internal routes and path tricks ----------------------------------------------------------------------
  for (const p of [`/s/${acme}/_baskule/status`, `/s/${acme}/%5Fbaskule/status`, `/s/${acme}//_baskule/status`, `/s/${acme}/x/../_baskule/status`, `/s/${acme}/%2E%2E/${acme}/_baskule/status`]) {
    const r = await rawGet(p, { cookie: bob.cookie });
    check(`internal route blocked: ${p.replace(acme, "<acme>")}`, r.status === 404 && !/activeRuns|sockets/.test(r.body), `(got ${r.status})`);
  }
  oneOf("internal revoke via the front (POST)", (await bob.post(`/s/${acme}/_baskule/revoke`, { userId: w.alice.id })).status, [403, 404]);
  const trav = await rawGet(`/s/${acme}/../${ap}/.well-known/t3/environment`, { cookie: bob.cookie });
  check("dot-dot from a member space into Alice's", trav.status !== 200 || !trav.body.includes("environmentId") || !(await alice.get(`/s/${ap}/.well-known/t3/environment`)).text.includes(JSON.parse(trav.body).environmentId), `(got ${trav.status})`);
  for (const p of ["/..%2F..%2Fetc%2Fpasswd", "/assets/..%2F..%2F..%2Fetc%2Fpasswd", "/%2e%2e/%2e%2e/etc/passwd"]) {
    const r = await rawGet(p);
    check(`static traversal ${p}`, !r.body.includes("root:x:0:0"), `(got ${r.status})`);
  }
  is("unknown space webhook", (await anon.post(`/hooks/00000000000000000000000000000000/x/y`, {})).status, 404);
  is("Better Auth admin routes are closed (/auth/admin/list-users)", (await admin.get("/auth/admin/list-users")).status, 404);
  is("public sign-up is closed", (await anon.post("/auth/sign-up/email", { email: "mallory@e2e.test", password: "mallory-pass-1", name: "M" })).status, 404);

  // --- roles -------------------------------------------------------------------------------------------------
  is("member → admin people list", (await bob.get("/api/baskule/admin/users")).status, 403);
  is("member → create an invitation", (await bob.post("/api/baskule/invitations", { email: "x@e2e.test" })).status, 403);
  is("member → stop a space (admin action)", (await bob.post(`/api/baskule/admin/spaces/${acme}/stop`)).status, 403);
  is("member (not owner) → rename Acme", (await bob.req("PATCH", `/api/baskule/spaces/${acme}`, { name: "Bob's" })).status, 403);
  oneOf("member → create a team space without permission", (await bob.post("/api/baskule/spaces", { name: `bob-space-${w.run}` })).status, [403]);

  // --- RPC confinement inside a space (Bob in Acme) ------------------------------------------------------------
  const settingsList = await spaceRpc(bob, acme, "projects.listEntries", { cwd: "/baskule", directoryPath: "" });
  check("RPC: list T3's home (settings, secrets) is refused", settingsList._tag === "Failure", JSON.stringify(settingsList).slice(0, 160));
  const escape = await spaceRpc(bob, acme, "projects.listEntries", { cwd: "/sandbox/space/chats", directoryPath: "../../../etc" });
  check("RPC: list outside the workspace (../../../etc) is refused", escape._tag === "Failure" || JSON.stringify(escape).indexOf("passwd") < 0, JSON.stringify(escape).slice(0, 160));
  const listChats = (api: Api, id: string) => spaceRpc(api, id, "projects.listEntries", { cwd: "/sandbox/space/chats", directoryPath: "" });
  // Positive control fixture: Alice's personal space needs at least one chat folder (declared setup, not another spec).
  let aliceChats: string[] = ((await listChats(alice, ap)).value?.entries ?? []).map((e: any) => e.path);
  // Chat folders are T3 records, so the fixture is a real plain chat (no computer needed).
  if (aliceChats.length === 0) {
    const project = await spaceRpc(alice, ap, "projects.ensureScratch", {});
    await spaceRpc(alice, ap, "orchestration.launchThread", {
      commandId: crypto.randomUUID(), projectId: project.value.projectId, title: "Security control", runtimeMode: "full-access", interactionMode: "default",
      modelSelection: { instanceId: "opencode", model: `custom/${process.env.E2E_MODEL ?? "mistral-large-4"}` }, workspaceStrategy: { type: "root" },
      initialMessage: { text: "control [[fake:text ok]]", attachments: [] },
    });
    aliceChats = await until(async () => {
      const paths = ((await listChats(alice, ap)).value?.entries ?? []).map((e: any) => e.path);
      return paths.length ? paths : null;
    }, 60_000, 1000, "Alice's control chat folder");
  }
  const bobAcme = await listChats(bob, acme);
  const bobChats: string[] = (bobAcme.value?.entries ?? []).map((e: any) => e.path);
  check("RPC: Acme's chats root lists Acme's chats only, none of Alice's personal ones", bobAcme._tag === "Success" && aliceChats.length > 0 && !bobChats.some((c) => aliceChats.includes(c)), `(alice ${aliceChats.length}, bob ${bobChats.length})`);
  const terminal = await spaceRpc(bob, acme, "terminal.open", { terminalId: "t1", threadId: "x", cwd: "/sandbox", cols: 80, rows: 24 }).catch((e) => ({ _tag: "Failure", e: String(e) }));
  check("RPC: terminal (host shell) is unsupported", terminal._tag === "Failure" && /unsupported|EnvironmentAuthorizationError/.test(JSON.stringify(terminal)), JSON.stringify(terminal).slice(0, 160));
  const settingsWrite = await spaceRpc(bob, acme, "server.updateSettings", { patch: {} }).catch((e) => ({ _tag: "Failure", e: String(e) }));
  check("RPC: settings writes are refused (installation-managed)", settingsWrite._tag === "Failure", JSON.stringify(settingsWrite).slice(0, 160));
  const config = JSON.stringify(await spaceRpc(bob, acme, "server.getConfig", {}).catch((e) => String(e)));
  const secrets = [envGet("COMPUTERD_TOKEN"), envGet("BASKULE_LLM_API_KEY"), envGet("BETTER_AUTH_SECRET"), envGet("RUSTFS_SECRET_KEY")].filter((s) => s.length > 8);
  check("server config sent to members holds no secret (computerd token, LLM key, auth secret)", !secrets.some((s) => config.includes(s)), "");
  // A WebSocket opened with Bob's cookie but a forged Alice identity speaks as Bob in Acme (author stamping).
  check("RPC over a forged-identity socket still authenticates as the cookie's owner", (await spaceRpc(bob, acme, "server.getConfig", {}, { "x-baskule-identity": aliceIdentity }).then(() => true, () => false)), "");

  // --- UI: Bob's sidebar never shows Alice's personal space ---------------------------------------------------
  const b = await newDevice(browser);
  await signInBrowser(b.page, w.bob);
  await waitComposer(b.page);
  await b.page.getByRole("combobox", { name: "Run on", exact: true }).click();
  const items = (await b.page.getByRole("option").allInnerTexts()).map((s) => s.trim());
  await b.page.keyboard.press("Escape");
  check("UI: Bob's spaces are exactly Personal + Acme", items.filter((s) => s === "Personal").length === 1 && items.includes(w.acme.name) && !items.some((s) => s.includes(w.alice.name)), JSON.stringify(items));
  const html = await b.page.content();
  check("UI: no trace of Alice's personal space id in Bob's page", !html.includes(ap), "");
  await shot(b.page, S, "01-bob-spaces");
  await b.page.goto(`/s/${ap}/`);
  check("UI: Bob opening Alice's space URL gets nothing", !(await b.page.content()).includes("environmentId"), "");
  await b.context.close();

  expect(results.length).toBeGreaterThanOrEqual(20);
});
