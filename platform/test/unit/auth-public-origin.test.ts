import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAuthConfig } from "../../src/control/auth-config";
import { ADMIN, call, makeService, ORIGIN, type H } from "../support/harness";
import { fakeOAuth } from "../fixtures/oauth.mjs";

const PUBLIC = "https://company.example.test";
const API = "/api/baskule";
const google = { id: "google", name: "Google", type: "social", options: { clientId: "test-id", clientSecret: "test-secret" } };
const configured = () => makeService({ AUTH_CONFIG: JSON.stringify({ publicOrigin: PUBLIC + "/", providers: [google] }) });
const publicCall = (h: H, method: string, path: string, opts: Parameters<typeof call>[3] = {}) => call(h, method, path, { ...opts, origin: PUBLIC });

async function adminSession(h: H) {
  const login = await publicCall(h, "POST", "/auth/sign-in/email", { body: ADMIN });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  return { cookie };
}

async function install(h: H, creds: Awaited<ReturnType<typeof adminSession>>, resource: string, credential: "user-oauth" | "login-identity") {
  const added = await publicCall(h, "POST", `${API}/admin/plugins`, { creds, body: { source: { type: "url", url: resource } } });
  expect(added.status).toBe(201);
  const id = added.body.id;
  const loginIdentity = credential === "login-identity" ? { provider: "google", scopes: ["https://www.googleapis.com/auth/cloud-platform"], audience: resource } : undefined;
  expect((await publicCall(h, "PATCH", `${API}/admin/plugins/${id}`, { creds, body: { enabled: true, servers: [{ name: "remote", credential, personal: true, loginIdentity }] } })).status).toBe(200);
  expect((await publicCall(h, "PATCH", `${API}/admin/groups/everyone`, { creds, body: { plugins: [id] } })).status).toBe(200);
  return id;
}

describe("installation public origin", () => {
  it("normalizes HTTPS origins and leaves local request inference optional", () => {
    expect(parseAuthConfig().publicOrigin).toBeUndefined();
    for (const value of [PUBLIC, PUBLIC + "/"])
      expect(parseAuthConfig(JSON.stringify({ publicOrigin: value })).publicOrigin).toBe(PUBLIC);
    expect(parseAuthConfig('{"publicOrigin":"https://COMPANY.example.test:8443/"}').publicOrigin).toBe("https://company.example.test:8443");
  });

  it.each([
    "", "not-a-url", "http://company.example.test", "ftp://company.example.test",
    "https://user:private-secret@company.example.test", "https://company.example.test/path",
    "https://company.example.test/path/..", "https://company.example.test//",
    "https://company.example.test?query=1", "https://company.example.test?",
    "https://company.example.test#fragment", "https://company.example.test#", null, 42,
  ])("rejects non-origin configuration %# without echoing it", value => {
    expect(() => parseAuthConfig(JSON.stringify({ publicOrigin: value })))
      .toThrowError("Invalid installation authentication configuration: publicOrigin");
  });

  it("starts Google login and issues Secure state/session cookies over incoming HTTP", async () => {
    const h = await configured();
    const start = await publicCall(h, "POST", "/auth/sign-in/social", {
      body: { provider: "google", callbackURL: PUBLIC + "/after-login?source=google", disableRedirect: true },
      headers: { "x-forwarded-proto": "http", "x-forwarded-host": "attacker.example.test", forwarded: "proto=http;host=attacker.example.test" },
    });
    expect(start.status).toBe(200);
    expect(new URL(start.body.url).searchParams.get("redirect_uri")).toBe(PUBLIC + "/auth/callback/google");
    expect(start.headers.getSetCookie().length).toBeGreaterThan(0);
    for (const cookie of start.headers.getSetCookie()) expect(cookie).toMatch(/; Secure(?:;|$)/);

    const login = await publicCall(h, "POST", "/auth/sign-in/email", { body: ADMIN });
    expect(login.status).toBe(200);
    expect(login.headers.getSetCookie()).toEqual(expect.arrayContaining([expect.stringMatching(/^__Secure-baskule\.session_token=.*; Secure(?:;|$)/)]));
    const ctx = await h.svc.auth.$context;
    expect(ctx.isTrustedOrigin(PUBLIC)).toBe(true);
    expect(ctx.isTrustedOrigin("https://attacker.example.test")).toBe(false);
  });

  it("keeps local login URLs and cookies dynamic without publicOrigin, ignoring forwarded headers", async () => {
    const h = await makeService({ AUTH_CONFIG: JSON.stringify({ providers: [google] }) });
    const start = await call(h, "POST", "/auth/sign-in/social", {
      body: { provider: "google", callbackURL: ORIGIN + "/", disableRedirect: true },
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "attacker.example.test" },
    });
    expect(start.status).toBe(200);
    expect(new URL(start.body.url).searchParams.get("redirect_uri")).toBe(ORIGIN + "/auth/callback/google");
    expect(start.headers.getSetCookie().length).toBeGreaterThan(0);
    for (const cookie of start.headers.getSetCookie()) expect(cookie).not.toMatch(/; Secure(?:;|$)/);
    const other = await h.svc.handle(new Request("http://other-local.test/auth/sign-in/social", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://other-local.test" },
      body: JSON.stringify({ provider: "google", callbackURL: "/", disableRedirect: true }),
    }));
    expect(other.status).toBe(200);
    const otherBody = z.object({ url: z.url() }).parse(await other.json());
    expect(new URL(otherBody.url).searchParams.get("redirect_uri")).toBe("http://other-local.test/auth/callback/google");
  });

  it("generates public native, invitation and password reset URLs from HTTP requests", async () => {
    const h = await configured();
    const creds = await adminSession(h);
    const pending = await call(h, "POST", `${API}/native-login/request`, { origin: null });
    expect(pending.status).toBe(200);
    expect(pending.body.url).toBe(`${PUBLIC}${API}/native-login?request=${pending.body.id}`);
    const invitation = await publicCall(h, "POST", `${API}/invitations`, { creds, body: { email: "invited@example.test" } });
    expect(invitation.status).toBe(201);
    expect(invitation.body.url).toBe(`${PUBLIC}/invite#token=${invitation.body.token}`);
    const me = await publicCall(h, "GET", `${API}/me`, { creds });
    expect(me.status).toBe(200);
    const reset = await publicCall(h, "POST", `${API}/admin/users/${me.body.user.id}/reset-link`, { creds });
    expect(reset.status).toBe(201);
    expect(reset.body.url).toBe(`${PUBLIC}/reset-password#token=${reset.body.token}`);
  });

  it("uses the public Google callback for account consent and preserves Secure state cookies", async () => {
    const h = await configured();
    const creds = await adminSession(h);
    const id = await install(h, creds, "https://bigquery.googleapis.com/mcp", "login-identity");
    const me = await publicCall(h, "GET", `${API}/me`, { creds });
    const ctx = await h.svc.auth.$context;
    await ctx.internalAdapter.createAccount({ userId: me.body.user.id, providerId: "google", accountId: "google-subject" });
    const start = await publicCall(h, "GET", `${API}/plugins/${id}/connect?server=remote&returnTo=%2Fsettings%3Ftab%3Dplugins`, { creds });
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get("location")!);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(PUBLIC + "/auth/callback/google");
    expect(authorization.searchParams.get("prompt")).toBe("consent");
    expect(start.headers.getSetCookie().length).toBeGreaterThan(0);
    for (const cookie of start.headers.getSetCookie()) expect(cookie).toMatch(/; Secure(?:;|$)/);
  });

  it("registers and completes MCP OAuth with public callback and return URLs", async () => {
    const fixture = await fakeOAuth();
    try {
      const h = await configured();
      const creds = await adminSession(h);
      const id = await install(h, creds, fixture.resource, "user-oauth");
      const start = await publicCall(h, "GET", `${API}/plugins/${id}/connect?server=remote&returnTo=%2Fsettings%3Ftab%3Dplugins`, { creds });
      expect(start.status).toBe(302);
      const authorization = new URL(start.headers.get("location")!);
      expect(authorization.searchParams.get("redirect_uri")).toBe(`${PUBLIC}${API}/plugins/oauth/callback`);
      const authorized = await fetch(authorization, { redirect: "manual" });
      expect(authorized.status).toBe(302);
      const callback = new URL(authorized.headers.get("location")!);
      expect(callback.origin).toBe(PUBLIC);
      const done = await publicCall(h, "GET", callback.pathname + callback.search, { creds });
      expect(done.status).toBe(302);
      const returned = new URL(done.headers.get("location")!);
      expect(returned.origin).toBe(PUBLIC);
      expect(returned.pathname).toBe("/settings");
      expect(returned.searchParams.get("tab")).toBe("plugins");
      expect(returned.searchParams.get("pluginConnection")).toBe("connected");
    } finally { await fixture.close(); }
  });
});
