import { expect, it, vi } from "vitest";
import { asAdmin, call, cookieFrom, makeService } from "../support/harness";
import { defaultSettings } from "../../src/control/settings";

it("admits only verified Google Workspace users from admin-approved domains, immediately", async () => {
  let exchangedToken = "";
  const originalFetch = globalThis.fetch;
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://oauth2.googleapis.com/token") return Promise.resolve(Response.json({ access_token: "google-access", token_type: "Bearer", expires_in: 3600, id_token: exchangedToken }));
    return originalFetch(input, init);
  });
  const h = await makeService({ AUTH_CONFIG: JSON.stringify({ providers: [{ id: "google", name: "Google", type: "social", options: { clientId: "google-test", clientSecret: "test-secret" } }] }) });
  const admin = await asAdmin(h);
  const save = (domains: string[]) => call(h, "PATCH", "/api/baskule/admin/settings", { creds: admin.creds, body: { ...defaultSettings, googleSignupDomains: domains } });
  const login = async (email: string, claims: Record<string, unknown> = {}) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "RS256", kid: "google-fixture" })}.${encode({ iss: "https://accounts.google.com", aud: "google-test", sub: email, email, email_verified: true, hd: "company.test", name: "New member", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    exchangedToken = `${payload}.fixture-signature`;
    const start = await call(h, "POST", "/auth/sign-in/social", { body: { provider: "google", callbackURL: "http://os.test/", disableRedirect: true } });
    expect(start.status).toBe(200);
    const state = new URL(start.body.url).searchParams.get("state");
    const callback = await call(h, "GET", `/auth/callback/google?code=fixture-code&state=${state}`, { creds: { cookie: cookieFrom(start) } });
    const me = await call(h, "GET", "/api/baskule/me", { creds: { cookie: cookieFrom(callback) } });
    return { ...me, headers: callback.headers };
  };
  expect((await login("before@company.test")).status).not.toBe(200);
  expect((await save(["Company.Test"])).body.googleSignupDomains).toEqual(["company.test"]);
  for (const domain of ["*", "@company.test", "company.test/", "company.test.evil/"])
    expect((await save([domain])).status).toBe(400);
  for (const [email, claims] of [
    ["outside@other.test", {}],
    ["suffix@evilcompany.test", {}],
    ["subdomain@sub.company.test", {}],
    ["unverified@company.test", { email_verified: false }],
    ["external@company.test", { hd: undefined }],
    ["wrong-host@company.test", { hd: "other.test" }],
  ] as const) {
    expect((await login(email, claims)).status, email).not.toBe(200);
    expect(h.storage.sql.exec("select id from user where email=?", email).toArray()).toEqual([]);
  }
  expect((await call(h, "POST", "/auth/sign-in/social", { body: { provider: "google", idToken: { token: "caller-forged-token" } } })).body.error).toBe("provider_code_flow_required");
  expect((await save(["company.test", "subsidiary.test"])).status).toBe(200);
  expect((await login("new@subsidiary.test", { hd: "subsidiary.test" })).status).toBe(200);
  expect((await save(["company.test"])).status).toBe(200);
  const registered = await login("new@company.test");
  expect(registered.status, JSON.stringify(registered.body)).toBe(200);
  const creds = { cookie: cookieFrom(registered) };
  const me = await call(h, "GET", "/api/baskule/me", { creds });
  expect(me.body.user).toMatchObject({ email: "new@company.test", role: "member" });
  expect(me.body.spaces).toHaveLength(1);
  expect((await call(h, "PATCH", "/api/baskule/admin/settings", { creds, body: { ...defaultSettings, googleSignupDomains: ["other.test"] } })).status).toBe(403);
  expect((await call(h, "POST", "/auth/sign-up/email", { body: { email: "password@company.test", name: "Password", password: "password-123" } })).status).toBe(404);
  await h.svc.init();
  expect((await call(h, "GET", "/api/baskule/admin/settings", { creds: admin.creds })).body.googleSignupDomains).toEqual(["company.test"]);
  expect((await login("persisted@company.test")).status).toBe(200);
  expect((await save([])).status).toBe(200);
  expect((await login("disabled@company.test")).status).not.toBe(200);
  expect((await login("new@company.test")).status).toBe(200);
});
