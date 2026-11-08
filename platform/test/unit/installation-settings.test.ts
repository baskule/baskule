import { describe, expect, it, vi } from "vitest";
import { asAdmin, call, makeService, createUser, signIn } from "../support/harness";
import { ControlService } from "../../src/control/service";
import { parseAuthConfig } from "../../src/control/auth-config";
import { BASKULE_AI_PROVIDERS, type BaskuleAIProviderId } from "../../../app/packages/contracts/src/baskule";
import { defaultSettings } from "../../src/control/settings";
import { INTERNAL_HEADER } from "../../src/shared/contract";

describe("installation authentication", () => {
  it("fails closed on invalid configuration, without exposing provider secrets", () => {
    expect(parseAuthConfig().mode).toBe("authenticated");
    for (const raw of ['{"mode":"none"}', '{"password":false}', '{"mode":"anonymous","providers":[{}]}', '{"typo":true}', '{"providers":[{"id":"company","name":"Company","type":"saml","options":{}}]}'])
      expect(() => parseAuthConfig(raw)).toThrow(/Invalid installation/);
    expect(() => parseAuthConfig(JSON.stringify({ providers: [{ id: "google", name: "Google", type: "social", options: { clientId: "test", clientSecret: "secret", hd: "company.test" } }] }))).toThrow(/Invalid installation/);
    expect(() => parseAuthConfig('{"password":"secret-value"}')).toThrowError("Invalid installation authentication configuration: password");
  });

  it("shares one anonymous identity across cookie, native bearer and credential-free requests", async () => {
    const h = await makeService({ AUTH_CONFIG: '{"mode":"anonymous"}' });
    const browser = await call(h, "GET", "/api/baskule/me");
    const native = await call(h, "GET", "/api/baskule/me", { origin: null, creds: { bearer: "irrelevant" } });
    expect(browser.body).toEqual(native.body);
    expect(browser.body.user).toMatchObject({ name: "Anonymous", id: "anonymous" });
    expect(browser.body.authentication).toMatchObject({ mode: "anonymous", password: false });
    expect(h.storage.sql.exec("select id from user").toArray()).toEqual([{ id: "anonymous" }]);
    expect(h.storage.sql.exec("select id from session").toArray()).toEqual([]);
    expect((await call(h, "POST", "/auth/sign-in/email", { body: { email: "x", password: "x" } })).status).toBe(404);
    expect((await call(h, "GET", "/api/baskule/admin/users")).status).toBe(404);
    expect(h.svc.check({ spaceId: browser.body.spaces[0].id, sessions: [{ userId: "anonymous", sessionId: "anonymous" }] })).toEqual({ valid: ["anonymous"] });
    expect(h.svc.check({ spaceId: "other", sessions: [{ userId: "anonymous", sessionId: "anonymous" }] })).toEqual({ valid: [] });
    h.env.AUTH_CONFIG = '{}';
    await expect(new ControlService(h.storage, h.env, async () => Response.json({})).init()).rejects.toThrow(/wiping/);
  });

  it("limits unauthenticated native sign-in requests per connection address", async () => {
    const h = await makeService({ AUTH_RATE_LIMIT: "1" });
    for (let i = 0; i < 5; i++)
      expect((await call(h, "POST", "/api/baskule/native-login/request")).status).toBe(200);
    expect((await call(h, "POST", "/api/baskule/native-login/request")).status).toBe(429);
  });

  it("provisions a passwordless invited account without granting a session", async () => {
    const h = await makeService({ AUTH_CONFIG: JSON.stringify({ providers: [{ id: "google", name: "Google", type: "social", options: { clientId: "test", clientSecret: "private-test-secret" } }] }) });
    const admin = await asAdmin(h);
    const invite = await call(h, "POST", "/api/baskule/invitations", { creds: admin.creds, body: { email: "invited@example.test" } });
    const accepted = await call(h, "POST", "/api/baskule/invitations/accept", { body: { token: invite.body.token, name: "Invited", provider: "google" } });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("set-cookie")).toBeNull();
    expect(h.storage.sql.exec("select id from account where user_id=?", accepted.body.user.id).toArray()).toHaveLength(0);
    expect((await call(h, "POST", "/api/baskule/invitations/accept", { body: { token: invite.body.token, name: "Replay", provider: "google" } })).status).toBe(404);
    expect((await signIn(h, "invited@example.test", "anything" )).status).toBe(401);
    const discovery = await call(h, "GET", "/.well-known/baskule", { origin: null });
    expect(JSON.stringify(discovery.body)).not.toContain("private-test-secret");
    expect(discovery.body.authentication.providers).toEqual([{ id: "google", name: "Google", type: "social" }]);
    expect((await call(h, "POST", "/auth/sso/register", { creds: admin.creds, body: {} })).status).toBe(404);
  });
});

/** A provider that accepts every key and model (or answers `status`); models.dev stays offline. */
function providers(status = 200) {
  const calls: { method: string; url: string; authorization: string | null }[] = [];
  const stub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://models.dev/api.json") throw new Error("offline");
    const method = init?.method ?? "GET";
    calls.push({ method, url, authorization: new Headers(init?.headers).get("authorization") });
    if (status !== 200) return Response.json({ error: { message: "rejected" } }, { status });
    if (method === "POST") return Response.json({ choices: [{ message: { content: "Hi" } }] });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "listed-model" }] });
    return Response.json({ id: url.split("/").at(-1) });
  });
  return { calls, [Symbol.dispose]: () => stub.mockRestore() };
}

const builtIn = BASKULE_AI_PROVIDERS.mistral;
/** An installation whose admin chose a built-in provider and its suggested model. */
const configured = { ...defaultSettings, ai: { providerId: "mistral" as BaskuleAIProviderId, baseUrl: builtIn.baseUrl, model: builtIn.models[0]! } };

describe("organization settings", () => {
  it("starts a new installation without an AI provider and keeps settings saved before", async () => {
    using api = providers();
    const h = await makeService();
    const admin = await asAdmin(h);
    const settingsPath = "/api/baskule/admin/settings";
    const internal = async () => (await call(h, "POST", "/_baskule/settings", {
      headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId: admin.me.spaces[0].id },
    })).body;
    expect((await call(h, "GET", settingsPath, { creds: admin.creds })).body).toMatchObject({ ai: null, apiKeyConfigured: false });
    expect(await internal()).toMatchObject({ ai: null, apiKey: "" });
    h.calls.length = 0;
    // Other settings save without a provider; a chat key has no connection to belong to.
    const renamed = await call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...defaultSettings, organizationName: "Renamed", apiKey: "orphan-key" } });
    expect(renamed.body).toMatchObject({ organizationName: "Renamed", ai: null, apiKeyConfigured: false });
    expect(h.storage.sql.exec("select key from kv where key like 'llm_api_key:%'").toArray()).toEqual([]);
    expect(api.calls).toEqual([]);
    expect(h.calls).toEqual([]);
    // Choosing one is checked like any change and reloads the spaces onto it.
    const chosen = await call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...configured, organizationName: "Renamed", apiKey: "chat-key" } });
    expect(chosen.body).toMatchObject({ ai: { providerId: "mistral", model: { id: builtIn.models[0]!.id } }, apiKeyConfigured: true });
    expect(api.calls).toHaveLength(1);
    expect(h.calls.map(c => c.path)).toEqual(["/_baskule/reconfigure"]);
    expect(await internal()).toMatchObject({ ai: chosen.body.ai, apiKey: "chat-key" });
    // Once chosen, a provider can be replaced but not removed.
    h.calls.length = 0;
    const removed = await call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...defaultSettings, organizationName: "Must not persist" } });
    expect(removed.status).toBe(400);
    expect(removed.body).toEqual({ error: "ai_required", message: "Choose a provider; the AI configuration can be changed but not removed" });
    expect((await call(h, "GET", settingsPath, { creds: admin.creds })).body).toMatchObject({ organizationName: "Renamed", ai: chosen.body.ai });
    expect(h.calls).toEqual([]);

    // Settings and keys stored by an earlier release are read as they are.
    const earlier = await makeService();
    const earlierAdmin = await asAdmin(earlier);
    earlier.storage.sql.exec("insert into kv(key, value) values ('product_settings', ?)", JSON.stringify(configured));
    earlier.storage.sql.exec("insert into kv(key, value) values (?, 'earlier-key')", `llm_api_key:${JSON.stringify(["mistral", builtIn.baseUrl])}`);
    await earlier.svc.init();
    expect((await call(earlier, "GET", settingsPath, { creds: earlierAdmin.creds })).body).toMatchObject({ ai: configured.ai, apiKeyConfigured: true });
  });

  it("restricts updates to admins, validates them, persists them and keeps keys private", async () => {
    using _providers = providers();
    const h = await makeService({ COMPUTERD_TOKEN: "internal-computerd-secret" });
    const admin = await asAdmin(h);
    await createUser(h, admin.creds, "member@example.test", "Member");
    const member = await signIn(h, "member@example.test", "user-password-1");
    expect((await call(h, "GET", "/api/baskule/admin/settings")).status).toBe(401);
    expect((await call(h, "PATCH", "/api/baskule/admin/settings", { creds: member.creds, body: configured })).status).toBe(403);
    const settings = { ...configured, organizationName: "Our company", idleMinutes: 25 };
    const saved = await call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: { ...settings, apiKey: "private-llm-key" } });
    expect(saved.status).toBe(200);
    expect(saved.body.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain("private-llm-key");
    expect((await call(h, "GET", "/api/baskule/me", { creds: member.creds })).body.organization.name).toBe("Our company");
    expect((await call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: { ...settings, idleMinutes: 0 } })).status).toBe(400);
    const invalidLimits = { ...settings, ai: { ...settings.ai, model: { ...settings.ai.model, limit: { context: 32_000, output: 64_000 } } } };
    expect((await call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: invalidLimits })).status).toBe(400);
    await h.svc.init();
    expect((await call(h, "GET", "/api/baskule/admin/settings", { creds: admin.creds })).body).toMatchObject({ organizationName: "Our company", idleMinutes: 25, apiKeyConfigured: true });
    const internal = await call(h, "POST", "/_baskule/settings", { headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId: admin.me.spaces[0].id } });
    expect(internal.body.apiKey).toBe("private-llm-key");
    expect((await call(h, "POST", "/_baskule/settings", { body: { spaceId: admin.me.spaces[0].id } })).status).toBe(404);
    expect((await call(h, "GET", "/api/baskule/runtime-settings", { creds: admin.creds })).status).toBe(401);
    expect((await call(h, "GET", "/api/baskule/runtime-settings", { creds: { bearer: "internal-computerd-secret" }, origin: null })).body).toEqual({ idleMinutes: 25 });
  });

  it("scopes keys to the provider and endpoint while preserving them across model changes", async () => {
    using _providers = providers();
    const h = await makeService();
    const admin = await asAdmin(h);
    const save = (ai: typeof configured.ai, apiKey?: string) => call(h, "PATCH", "/api/baskule/admin/settings", {
      creds: admin.creds, body: { ...defaultSettings, ai, ...(apiKey === undefined ? {} : { apiKey }) },
    });
    const key = async () => (await call(h, "POST", "/_baskule/settings", {
      headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId: admin.me.spaces[0].id },
    })).body.apiKey;
    const original = configured.ai;
    expect((await save(original, "mistral-secret")).status).toBe(200);
    const renamedModel = { ...original, model: { ...original.model, id: "another-model" } };
    expect((await save(renamedModel)).body.apiKeyConfigured).toBe(true);
    expect(await key()).toBe("mistral-secret");

    const custom = { ...original, providerId: "custom" as const };
    expect((await save(custom)).body.apiKeyConfigured).toBe(false);
    expect(await key()).toBe("");
    const proxy = { ...original, baseUrl: "https://proxy.example.test/v1" };
    expect((await save(proxy, "proxy-secret")).body.apiKeyConfigured).toBe(true);
    expect(await key()).toBe("proxy-secret");
    expect((await save(original)).body.apiKeyConfigured).toBe(true);
    expect(await key()).toBe("mistral-secret");
    // A built-in provider cannot work without its key.
    expect((await save(original, "")).body.error).toBe("ai_key_missing");
    expect(await key()).toBe("mistral-secret");
    await save(proxy);
    expect(await key()).toBe("proxy-secret");
  });

  it("saves a keyless provider without a stored key and supplies public auth privately", async () => {
    using api = providers();
    const h = await makeService();
    const admin = await asAdmin(h);
    const provider = BASKULE_AI_PROVIDERS.opencode;
    const settings = { ...defaultSettings, ai: { providerId: "opencode", baseUrl: provider.baseUrl, model: provider.models[0] } };
    for (const key of [{}, { apiKey: "" }, { apiKey: "ignored-private-key" }]) {
      const saved = await call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: { ...settings, ...key } });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ ai: settings.ai, apiKeyConfigured: true });
      expect(saved.body).not.toHaveProperty("apiKey");
      expect(h.storage.sql.exec("select key from kv where key like 'llm_api_key:%'").toArray()).toEqual([]);
      const internal = await call(h, "POST", "/_baskule/settings", {
        headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId: admin.me.spaces[0].id },
      });
      expect(internal.body.apiKey).toBe("");
    }
    await h.svc.init();
    expect((await call(h, "GET", "/api/baskule/admin/settings", { creds: admin.creds })).body.apiKeyConfigured).toBe(true);
    expect(api.calls).toEqual([{ method: "POST", url: `${provider.baseUrl}/chat/completions`, authorization: "Bearer public" }]);
    const switched = await call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: configured });
    expect(switched.body.error).toBe("ai_key_missing");
  });

  it("stores only chat configurations the provider accepts, and checks only changed ones", async () => {
    using api = providers(401);
    const h = await makeService();
    const admin = await asAdmin(h);
    const save = (body: Record<string, unknown>) => call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body });
    const rejected = await save({ ...configured, apiKey: "wrong-key" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("ai_key_rejected");
    expect(JSON.stringify(rejected.body)).not.toContain("wrong-key");
    expect((await call(h, "GET", "/api/baskule/admin/settings", { creds: admin.creds })).body.apiKeyConfigured).toBe(false);
    const unrelated = await save({ ...defaultSettings, organizationName: "Renamed" });
    expect(unrelated.status).toBe(200);
    expect(api.calls).toHaveLength(1);
  });

  it("derives built-in prices on the server and keeps the admin's custom prices", async () => {
    using _providers = providers();
    const h = await makeService();
    const admin = await asAdmin(h);
    const save = (ai: unknown) => call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: { ...defaultSettings, ai, apiKey: "key" } });
    const small = BASKULE_AI_PROVIDERS.mistral.models[1]!;
    const forged = await save({ ...configured.ai, model: { ...small, cost: { input: 99, output: 99 } } });
    expect(forged.body.ai.model.cost).toEqual(small.cost);
    const unpriced = await save({ ...configured.ai, model: { ...small, id: "unlisted-model", cost: { input: 1, output: 1 } } });
    expect(unpriced.body.ai.model).not.toHaveProperty("cost");
    const cost = { input: 1, output: 2, cache_read: 0.5, cache_write: 3 };
    const custom = await save({ providerId: "custom", baseUrl: "https://llm.example.test/v1", model: { ...small, id: "local", cost } });
    expect(custom.body.ai.model.cost).toEqual(cost);
  });

  it("lists models and checks a connection with the typed key or the saved one, for admins only", async () => {
    using api = providers();
    const h = await makeService();
    const admin = await asAdmin(h);
    await createUser(h, admin.creds, "member@example.test", "Member");
    const member = await signIn(h, "member@example.test", "user-password-1");
    const connection = { providerId: "mistral", baseUrl: BASKULE_AI_PROVIDERS.mistral.baseUrl };
    expect((await call(h, "POST", "/api/baskule/admin/ai/models", { creds: member.creds, body: connection })).status).toBe(403);
    await call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: { ...configured, apiKey: "saved-key" } });
    const listed = await call(h, "POST", "/api/baskule/admin/ai/models", { creds: admin.creds, body: connection });
    expect(listed.body.models).toEqual([{ id: "listed-model", name: "listed-model" }]);
    const checked = await call(h, "POST", "/api/baskule/admin/ai/verify", { creds: admin.creds, body: { ...connection, modelId: "mistral-small-2603", apiKey: "typed-key" } });
    expect(checked.body).toEqual({ ok: true });
    expect(api.calls.slice(1).map(({ url, authorization }) => [url, authorization])).toEqual([
      [`${connection.baseUrl}/models`, "Bearer saved-key"],
      [`${connection.baseUrl}/models/mistral-small-2603`, "Bearer typed-key"],
    ]);
    expect((await call(h, "POST", "/api/baskule/admin/ai/verify", { creds: admin.creds, body: connection })).status).toBe(400);
  });

  it("hands a signed session to the initiating native client once, after browser approval", async () => {
    const h = await makeService();
    const admin = await asAdmin(h);
    const pending = await call(h, "POST", "/api/baskule/native-login/request", { origin: null });
    const { id, secret } = pending.body;
    const poll = () => call(h, "POST", "/api/baskule/native-login/poll", { origin: null, body: { id, secret } });
    expect((await poll()).body).toEqual({ token: null });
    expect((await call(h, "POST", "/api/baskule/native-login/poll", { body: { id, secret: "wrong" } })).status).toBe(404);
    const form = new FormData(); form.set("request", id);
    const approved = await h.svc.handle(new Request("http://baskule.test/api/baskule/native-login/approve", { method: "POST", headers: { cookie: admin.creds.cookie! }, body: form }));
    expect(approved.status).toBe(200);
    const complete = await poll();
    expect(complete.status).toBe(200);
    expect(complete.body.token).toContain(".");
    expect((await call(h, "GET", "/api/baskule/me", { creds: { bearer: complete.body.token }, origin: null })).body.user.id).toBe(admin.userId);
    expect((await poll()).status).toBe(404);
  });
});
