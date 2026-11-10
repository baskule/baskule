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
console.log(`Created fresh personal-only and team accounts, with two plugin accounts for personal settings. Read credentials privately from ${path}`);
console.log("Plugin rename/default/disconnect passed with a separate native bearer account. Fake OAuth is stopped; external tools and new connections require a running fixture.");

async function seedPluginAccounts() {
  const verifier = await api.person("MobilePluginCheck", run);
  const oauth = await fakeOAuth();
  try {
    const group = await admin.json("POST", "/api/baskule/admin/groups", {
      name: `Mobile plugin QA ${run}`,
      members: [personal.me.user.id, verifier.me.user.id],
      permissions: { canCreateSpaces: false },
      plugins: [],
    });
    const input = {
      name: `Mobile QA mail ${run}`,
      description: "Local fixture for account management. External tools and new connections require a running fake OAuth provider.",
      source: { type: "custom" }, skills: [], omitted: [],
      servers: [{ name: "remote", url: oauth.resource, credential: "none" }],
    };
    const plugin = await admin.json("POST", "/api/baskule/admin/plugins", { groups: [group.id], plugin: input });
    await admin.json("PATCH", `/api/baskule/admin/plugins/${plugin.id}`, {
      plugin: { ...input, servers: [{ ...input.servers[0], credential: "user-oauth" }] },
    });
    for (const person of [personal, verifier]) {
      for (const label of ["Work", "Personal"]) {
        oauth.state.identity = label;
        const query = new URLSearchParams({ server: "remote", label, returnTo: "/settings/plugins" });
        const start = await person.http("GET", `/api/baskule/plugins/${plugin.id}/connect?${query}`);
        const authorization = redirectLocation(start);
        assert.equal(authorization.origin, oauth.issuer, "OAuth must stay on the local fixture");
        const consent = await fetch(authorization, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(15_000) });
        const callback = redirectLocation(consent);
        assert.equal(callback.origin, front.origin, "OAuth must return to this worktree");
        assert.equal(callback.pathname, "/api/baskule/plugins/oauth/callback");
        // OAuth state belongs to the initiating cookie session and origin, including on callback.
        const completed = redirectLocation(await person.http("GET", `${callback.pathname}${callback.search}`));
        assert.equal(completed.searchParams.get("pluginConnection"), "connected", "Local OAuth account connection failed");
      }
    }
    await verifyNativeAccountMutations(verifier, plugin.id);
    const member = (await personal.json("GET", "/api/baskule/plugins")).plugins.find(p => p.id === plugin.id);
    const accounts = member.servers.find(server => server.name === "remote").accounts;
    assert.deepEqual(accounts.map(account => account.label).sort(), ["Personal", "Work"]);
    assert.equal(accounts.find(account => account.default)?.label, "Work");
    return {
      pluginId: plugin.id,
      server: "remote",
      accounts: accounts.map(({ id, label, default: isDefault }) => ({ id, label, default: isDefault })),
      managementOnly: true,
      note: "The fake OAuth provider stops after seeding. Rename, default and disconnect use stored accounts; external tools and new OAuth connections need a running fixture.",
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

async function verifyNativeAccountMutations(person, pluginId) {
  const login = await nativeRequest("POST", "/auth/sign-in/email", { email: person.email, password: person.password });
  assert.equal(login.status, 200, "Native fixture sign-in failed");
  const token = login.headers.get("set-auth-token");
  assert.ok(token, "Native fixture sign-in returned no signed bearer");
  const request = async (method, path, body) => {
    const response = await nativeRequest(method, path, body, token);
    assert.equal(response.status, 200, `Native ${method} failed`);
    return response.json();
  };
  const accounts = async () => (await request("GET", "/api/baskule/plugins")).plugins
    .find(plugin => plugin.id === pluginId).servers.find(server => server.name === "remote").accounts;
  const connected = await accounts();
  const work = connected.find(account => account.label === "Work");
  const second = connected.find(account => account.label === "Personal");
  assert.ok(work && second, "Expected two verification accounts");
  const path = `/api/baskule/plugins/${pluginId}/accounts/`;
  await request("PATCH", `${path}${second.id}`, { label: "Renamed for native QA" });
  assert.equal((await accounts()).find(account => account.id === second.id)?.label, "Renamed for native QA");
  await request("PATCH", `${path}${second.id}`, { default: true });
  assert.equal((await accounts()).find(account => account.default)?.id, second.id);
  await request("DELETE", `${path}${second.id}?default=${encodeURIComponent(work.id)}`);
  const remaining = await accounts();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, work.id);
  assert.equal(remaining[0].default, true);
  await request("DELETE", `${path}${work.id}`);
  assert.deepEqual(await accounts(), []);
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
