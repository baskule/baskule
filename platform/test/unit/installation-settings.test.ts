import { describe, expect, it } from "vitest";
import { asAdmin, call, makeService, createUser, signIn } from "../support/harness";
import { ControlService } from "../../src/control/service";
import { parseAuthConfig } from "../../src/control/auth-config";
import { BASKULE_AI_PROVIDERS } from "../../../app/packages/contracts/src/baskule";
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

describe("organization settings", () => {
  it("restricts updates to admins, validates them, persists them and keeps keys private", async () => {
    const h = await makeService({ COMPUTERD_TOKEN: "internal-computerd-secret" });
    const admin = await asAdmin(h);
    await createUser(h, admin.creds, "member@example.test", "Member");
    const member = await signIn(h, "member@example.test", "user-password-1");
    expect((await call(h, "GET", "/api/baskule/admin/settings")).status).toBe(401);
    expect((await call(h, "PATCH", "/api/baskule/admin/settings", { creds: member.creds, body: defaultSettings })).status).toBe(403);
    const settings = { ...defaultSettings, organizationName: "Our company", idleMinutes: 25 };
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
    const h = await makeService();
    const admin = await asAdmin(h);
    const save = (ai: typeof defaultSettings.ai, apiKey?: string) => call(h, "PATCH", "/api/baskule/admin/settings", {
      creds: admin.creds, body: { ...defaultSettings, ai, ...(apiKey === undefined ? {} : { apiKey }) },
    });
    const key = async () => (await call(h, "POST", "/_baskule/settings", {
      headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId: admin.me.spaces[0].id },
    })).body.apiKey;
    const original = defaultSettings.ai;
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
    expect((await save(original, "")).body.apiKeyConfigured).toBe(false);
    expect(await key()).toBe("");
    await save(proxy);
    expect(await key()).toBe("proxy-secret");
  });

  it("saves a keyless provider without a stored key and supplies public auth privately", async () => {
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
    const switched = await call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: defaultSettings });
    expect(switched.body.apiKeyConfigured).toBe(false);
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
    const approved = await h.svc.handle(new Request("http://os.test/api/baskule/native-login/approve", { method: "POST", headers: { cookie: admin.creds.cookie! }, body: form }));
    expect(approved.status).toBe(200);
    const complete = await poll();
    expect(complete.status).toBe(200);
    expect(complete.body.token).toContain(".");
    expect((await call(h, "GET", "/api/baskule/me", { creds: { bearer: complete.body.token }, origin: null })).body.user.id).toBe(admin.userId);
    expect((await poll()).status).toBe(404);
  });
});
