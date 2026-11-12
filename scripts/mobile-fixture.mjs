// Disposable native QA accounts and fake dictation, scoped to this worktree's stack.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "../e2e/journeys/api.mjs";
import { fakeOAuth } from "../platform/test/fixtures/oauth.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stack = JSON.parse(readFileSync(join(root, ".run/stack/stack.json"), "utf8"));
if (realpathSync(stack.worktree) !== realpathSync(root) || stack.phase !== "running") {
  throw new Error("Start this worktree's disposable stack and run scripts/stack doctor first.");
}
const front = new URL(stack.urls.loopback);
if (front.hostname !== "127.0.0.1" || Number(front.port) !== stack.ports.celld || !stack.ports["fake-llm"]) {
  throw new Error("Expected the worktree stack's loopback front and fake model service.");
}
const api = createApi(stack);
const admin = await api.adminSession();
const { apiKeyConfigured: _chat, transcriptionApiKeyConfigured: _voice, authentication: _auth, ...settings } =
  await admin.json("GET", "/api/baskule/admin/settings");
if (settings.ai.baseUrl !== `http://127.0.0.1:${stack.ports["fake-llm"]}/v1`) {
  throw new Error("Mobile fixtures require the stack's fake model, not a real provider.");
}
await admin.json("PATCH", "/api/baskule/admin/settings", {
  ...settings,
  transcription: { enabled: true, providerId: "custom", baseUrl: settings.ai.baseUrl, model: "fake-transcribe" },
  // Same endpoint means a shared chat/voice key; match scripts/stack.mjs's fake service.
  transcriptionApiKey: "fake-llm-key",
});
const run = randomUUID().slice(0, 8);
const personal = await api.person("MobilePersonal", run);
const team = await api.person("MobileTeam", run);
await api.teamSpace(admin, `Mobile QA ${run}`, [team]);
const plugins = await seedPluginAccounts();
const path = join(root, ".run/mobile-fixture.json");
writeFileSync(path, JSON.stringify({
  stackId: stack.id,
  serverUrl: stack.urls.loopback,
  accounts: {
    personal: { email: personal.email, password: personal.password },
    team: { email: team.email, password: team.password },
  },
  plugins,
  transcript: "Voice input verified.",
}, null, 2) + "\n", { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`Created fresh personal-only and team accounts, with a signed-in plugin and an organization-key plugin for personal settings. Read credentials privately from ${path}`);
console.log("Plugin switch and disconnect passed with a separate native bearer account. Fake OAuth is stopped; tools and new sign-ins require a running fixture.");

async function seedPluginAccounts() {
  const verifier = await api.person("MobilePluginCheck", run);
  const oauth = await fakeOAuth();
  try {
    const group = await admin.json("POST", "/api/baskule/admin/groups", {
      name: `Mobile plugin QA ${run}`,
      members: [personal.me.user.id, verifier.me.user.id],
      permissions: { canCreateSpaces: false },
    });
    const access = { kind: "groups", groups: [group.id] };
    const install = async (server, values = {}) => {
      const ref = { kind: "custom", server };
      const preview = await admin.json("POST", "/api/baskule/admin/plugins/preview", { ref });
      return admin.json("POST", "/api/baskule/admin/plugins", { ref, digest: preview.digest, access, values });
    };
    const mail = await install({ displayName: `Mobile QA mail ${run}`, url: oauth.resource, auth: "oauth",
      description: "Local fixture for sign-in management. Tools and new sign-ins require a running fake OAuth provider." });
    const notes = await install({ displayName: `Mobile QA notes ${run}`, url: "https://mobile-fixture.invalid/mcp", auth: "header", headerName: "X-API-Key",
      description: "Organization key fixture: members have nothing to sign in to." }, { [`Mobile QA notes ${run}`]: { "X-API-Key": "fixture-key" } });
    const server = mail.servers[0].id;
    for (const person of [personal, verifier]) {
      oauth.state.identity = person.email;
      const start = await person.http("GET", `/api/baskule/plugins/${mail.id}/servers/${server}/connect?returnTo=%2Fsettings%2Fplugins`);
      const authorization = redirectLocation(start);
      assert.equal(authorization.origin, oauth.issuer, "OAuth must stay on the local fixture");
      const consent = await fetch(authorization, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(15_000) });
      const callback = redirectLocation(consent);
      assert.equal(callback.origin, front.origin, "OAuth must return to this worktree");
      assert.equal(callback.pathname, "/api/baskule/plugins/oauth/callback");
      // OAuth state belongs to the initiating cookie session and origin, including on callback.
      const completed = redirectLocation(await person.http("GET", `${callback.pathname}${callback.search}`));
      assert.equal(completed.searchParams.get("connection"), "connected", "Local OAuth sign-in failed");
    }
    await verifyNativeMutations(verifier, mail.id, server);
    const mine = (await personal.json("GET", "/api/baskule/plugins")).plugins;
    assert.equal(mine.find(p => p.id === mail.id).servers[0].connection.state, "connected");
    assert.equal(mine.find(p => p.id === notes.id).servers[0].connection.state, "not_required");
    return {
      pluginIds: [mail.id, notes.id],
      signIn: { pluginId: mail.id, serverId: server },
      managementOnly: true,
      note: "The fake OAuth provider stops after seeding. The switch and disconnect use stored data; tools and new sign-ins need a running fixture.",
    };
  } finally {
    await oauth.close();
    await admin.json("POST", `/api/baskule/admin/users/${verifier.me.user.id}/deactivate`, {});
  }
}

function redirectLocation(response) {
  assert.equal(response.status, 302, "Expected a local OAuth redirect");
  const location = response.headers.get("location");
  assert.ok(location, "OAuth redirect has no destination");
  return new URL(location, front);
}

async function verifyNativeMutations(person, pluginId, serverId) {
  const login = await nativeRequest("POST", "/auth/sign-in/email", { email: person.email, password: person.password });
  assert.equal(login.status, 200, "Native fixture sign-in failed");
  const token = login.headers.get("set-auth-token");
  assert.ok(token, "Native fixture sign-in returned no signed bearer");
  const request = async (method, path, body) => {
    const response = await nativeRequest(method, path, body, token);
    assert.equal(response.status, 200, `Native ${method} failed`);
    return response.json();
  };
  const plugin = async () => (await request("GET", "/api/baskule/plugins")).plugins.find(p => p.id === pluginId);
  assert.equal((await plugin()).servers[0].connection.state, "connected");
  await request("PUT", `/api/baskule/plugins/${pluginId}`, { on: false });
  assert.equal((await plugin()).on, false);
  await request("PUT", `/api/baskule/plugins/${pluginId}`, { on: true });
  await request("DELETE", `/api/baskule/plugins/${pluginId}/servers/${serverId}/connection`);
  assert.equal((await plugin()).servers[0].connection.state, "not_connected");
  await request("POST", "/auth/sign-out", {});
}

// Node fetch adds Sec-Fetch-* browser headers; phones send neither those headers nor Origin/cookies.
function nativeRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, front), {
      method, signal: AbortSignal.timeout(15_000),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
