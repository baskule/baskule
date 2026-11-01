import { describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER } from "../../src/shared/contract";
import { ADMIN, call, cookieFrom, makeService, signIn } from "../support/harness";

const body = { token: "setup-test-token", name: "First admin", ...ADMIN };
describe("first admin setup", () => {
  it("exposes status, rejects bad tokens and invalid fields, creates a signed-in admin once", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token }, false);
    expect((await call(h, "GET", "/api/baskule/setup")).body).toEqual({ required: true, password: true });
    expect(await call(h, "POST", "/api/baskule/setup", { body: { ...body, token: "wrong" } })).toMatchObject({ status: 403, body: { error: "bad_token" } });
    expect((await call(h, "POST", "/api/baskule/setup", { body: null })).status).toBe(400);
    for (const invalid of [{ email: "bad" }, { name: "" }, { password: "short" }])
      expect((await call(h, "POST", "/api/baskule/setup", { body: { ...body, ...invalid } })).status).toBe(400);
    const created = await call(h, "POST", "/api/baskule/setup", { body, origin: null, headers: { cookie: "" } });
    expect(created.status).toBe(201);
    expect((await call(h, "GET", "/api/baskule/me", { creds: { cookie: cookieFrom(created) } })).body.user.role).toBe("admin");
    expect((await call(h, "GET", "/api/baskule/setup")).body.required).toBe(false);
    expect(await call(h, "POST", "/api/baskule/setup", { body })).toMatchObject({ status: 409, body: { error: "already_set_up" } });
    expect((await signIn(h, ADMIN.email, ADMIN.password)).status).toBe(200);
  });

  it("sets Secure cookies on inferred HTTPS and authenticates that session without a public origin setting", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token }, false);
    const origin = "https://proxy.example.test";
    const created = await h.svc.handle(new Request(`${origin}/api/baskule/setup`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(created.status).toBe(201);
    const cookies = created.headers.getSetCookie();
    expect(cookies.some(cookie => cookie.includes("; Secure"))).toBe(true);
    const cookie = cookies.map(value => value.split(";")[0]).join("; ");
    const me = await h.svc.handle(new Request(`${origin}/api/baskule/me`, { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { role: "admin" } });
    const login = await h.svc.handle(new Request(`${origin}/auth/sign-in/email`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify(ADMIN) }));
    expect(login.status).toBe(200);
    expect(login.headers.getSetCookie().some(value => value.includes("; Secure"))).toBe(true);
    expect((await signIn(h, ADMIN.email, ADMIN.password)).status).toBe(200);
  });

  it("returns creation success even when automatic sign-in is rate-limited", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token, AUTH_RATE_LIMIT: "1" }, false);
    for (let n = 0; n < 10; n++) expect((await call(h, "POST", "/auth/sign-in/email", { headers: { [CLIENT_IP_HEADER]: "operator" }, body: ADMIN })).status).toBe(401);
    const created = await call(h, "POST", "/api/baskule/setup", { headers: { [CLIENT_IP_HEADER]: "operator" }, body });
    expect(created.status).toBe(201);
    expect(created.body.user.email).toBe(ADMIN.email);
    expect(cookieFrom(created)).toBe("");
    expect((await call(h, "GET", "/api/baskule/setup")).body.required).toBe(false);
    expect((await call(h, "POST", "/api/baskule/setup", { body })).status).toBe(409);
  });

  it("returns creation success if automatic sign-in throws", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token }, false);
    const handler = vi.spyOn(h.svc.auth, "handler").mockRejectedValueOnce(new Error("sign-in unavailable"));
    const created = await call(h, "POST", "/api/baskule/setup", { body });
    expect(created.status).toBe(201);
    expect(cookieFrom(created)).toBe("");
    handler.mockRestore();
    expect((await signIn(h, ADMIN.email, ADMIN.password)).status).toBe(200);
  });

  it("keeps setup available to a new operator after 1000 other client addresses", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token, AUTH_RATE_LIMIT: "1" }, false);
    for (let n = 0; n < 1000; n++)
      expect((await call(h, "POST", "/api/baskule/setup", { headers: { [CLIENT_IP_HEADER]: `client-${n}` }, body: { ...body, token: "wrong" } })).status).toBe(403);
    expect((await call(h, "POST", "/api/baskule/setup", { headers: { [CLIENT_IP_HEADER]: "operator" }, body })).status).toBe(201);
  });

  it("returns readable validation errors for the name and email limits", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token }, false);
    for (const [invalid, message] of [[{ name: "n".repeat(101) }, /Name.*100/], [{ email: "e".repeat(255) }, /email.*254/]] as const) {
      const result = await call(h, "POST", "/api/baskule/setup", { body: { ...body, ...invalid } });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_field");
      expect(result.body.message).toMatch(message);
    }
  });

  it("creates an SSO admin without a password or session", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token, AUTH_CONFIG: JSON.stringify({ version: 1, password: false, providers: [{ type: "oidc", id: "company", name: "Company", options: { clientId: "test", clientSecret: "test", discoveryUrl: "https://id.example/.well-known/openid-configuration" } }] }) }, false);
    expect((await call(h, "GET", "/api/baskule/setup")).body).toEqual({ required: true, password: false });
    const invalid = await call(h, "POST", "/api/baskule/setup", { body });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toContain("Password sign-in is disabled");
    const { password: _password, ...sso } = body;
    const created = await call(h, "POST", "/api/baskule/setup", { body: sso });
    expect(created.status).toBe(201);
    expect(cookieFrom(created)).toBe("");
    expect(h.storage.sql.exec("select role, email from user").toArray()).toEqual([{ role: "admin", email: ADMIN.email }]);
    expect(h.storage.sql.exec("select count(*) as n from account").toArray()[0].n).toBe(0);
  });

  it("allows one winner for simultaneous submissions", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token }, false);
    const results = await Promise.all([call(h, "POST", "/api/baskule/setup", { body }), call(h, "POST", "/api/baskule/setup", { body: { ...body, email: "other@example.test" } })]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(h.storage.sql.exec("select count(*) as n from user where role='admin'").toArray()[0].n).toBe(1);
  });

  it("limits attempts by the same client like sign-in", async () => {
    const h = await makeService({ SETUP_TOKEN: body.token, AUTH_RATE_LIMIT: "1" }, false);
    for (let n = 0; n < 10; n++) expect((await call(h, "POST", "/api/baskule/setup", { body: { ...body, token: "wrong" } })).status).toBe(403);
    expect((await call(h, "POST", "/api/baskule/setup", { body })).status).toBe(429);
  });
});
