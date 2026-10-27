import { describe, expect, it } from "vitest";
import { ADMIN, asAdmin, call, cookieFrom, createUser, makeService, personalSpaceOf, signIn, type H } from "../support/harness";
import { INTERNAL_HEADER } from "../../src/shared/contract";

const internal = { [INTERNAL_HEADER]: "1" };

async function authorize(h: H, creds: { cookie?: string; bearer?: string }, spaceId: string) {
  return call(h, "POST", "/_baskule/authorize", { creds, body: { spaceId }, headers: internal, origin: null });
}

describe("boot", () => {
  it("runs migrations, creates the organisation and the first admin once", async () => {
    const h = await makeService();
    const users = h.storage.sql.exec("select email, role from user").toArray();
    expect(users).toEqual([{ email: ADMIN.email, role: "admin" }]);
    expect(await h.svc.bootstrapAdmin()).toBe("exists");
    await h.svc.init(); // a second boot (new instance on the same storage) is idempotent
    expect(h.storage.sql.exec("select count(*) as n from user").toArray()[0].n).toBe(1);
    expect(h.storage.sql.exec("select name from organization").toArray()).toEqual([{ name: "Baskule" }]);
    // the admin got a personal space with exactly one owner
    const admin = await asAdmin(h);
    expect(admin.me.spaces).toHaveLength(1);
    expect(admin.me.spaces[0]).toMatchObject({ kind: "personal", role: "owner" });
  });

  it("skips the admin when ADMIN_EMAIL/ADMIN_PASSWORD are missing, and generates + keeps an auth secret", async () => {
    const h = await makeService({ ADMIN_EMAIL: "", ADMIN_PASSWORD: "" });
    expect(h.storage.sql.exec("select count(*) as n from user").toArray()[0].n).toBe(0);
    const secret = h.storage.sql.exec("select value from kv where key='auth_secret'").toArray()[0].value as string;
    expect(secret.length).toBeGreaterThanOrEqual(40);
  });
});

describe("database invariants", () => {
  it("a personal space has exactly one member, its owner (CHECK + triggers)", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob");
    const personal = personalSpaceOf(h, bob.id);
    const sql = h.storage.sql;
    expect(() => sql.exec("insert into space_member(space_id, user_id, role, created_at) values (?, ?, 'member', 1)", personal, a.userId).toArray()).toThrow(/personal space/);
    expect(() => sql.exec("update space_member set role = 'member' where space_id = ?", personal).toArray()).toThrow(/personal space/);
    expect(() => sql.exec("insert into space(id, organization_id, kind, name, created_at) values ('x', ?, 'personal', 'n', 1)", h.svc.orgId).toArray()).toThrow(/CHECK/);
    expect(() => sql.exec("insert into space(id, organization_id, kind, name, personal_user_id, created_at) values ('y', ?, 'personal', 'n', ?, 1)", h.svc.orgId, bob.id).toArray()).toThrow(/UNIQUE/);
    expect(() => sql.exec("update space set kind = 'team', personal_user_id = null where id = ?", personal).toArray()).toThrow(/immutable/);
  });
});

describe("sessions", () => {
  it("signs in with a cookie and a signed bearer; a raw DB token is not accepted", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    expect(a.creds.cookie).toMatch(/^baskule\.session_token=/);
    expect(a.creds.bearer).toContain(".");
    expect((await call(h, "GET", "/api/baskule/me", { creds: { bearer: a.creds.bearer } })).status).toBe(200);
    const raw = a.creds.bearer!.split(".")[0];
    expect((await call(h, "GET", "/api/baskule/me", { creds: { bearer: raw } })).status).toBe(401);
    expect((await call(h, "GET", "/api/baskule/me")).status).toBe(401);
    expect((await signIn(h, ADMIN.email, "wrong-password")).status).toBe(401);
  });

  it("public sign-up and Better Auth's own admin routes are not reachable", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    expect((await call(h, "POST", "/auth/sign-up/email", { body: { email: "x@os.test", password: "password-123", name: "X" } })).status).toBe(404);
    expect((await call(h, "POST", "/auth/admin/set-user-password", { creds: a.creds, body: { userId: a.userId, newPassword: "aaaaaaaaaa" } })).status).toBe(404);
    expect((await call(h, "POST", "/auth/admin/impersonate-user", { creds: a.creds, body: { userId: a.userId } })).status).toBe(404);
  });

  it("internal routes need the internal marker", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const sp = a.me.spaces[0].id;
    expect((await call(h, "POST", "/_baskule/authorize", { creds: a.creds, body: { spaceId: sp } })).status).toBe(404);
    expect((await authorize(h, a.creds, sp)).status).toBe(200);
  });
});

describe("authorization (Worker → ControlCell)", () => {
  it("returns the contract identity for members, 404 for unknown/non-member/malformed, 401 without session", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    await createUser(h, a.creds, "alice@os.test", "Alice");
    const alice = await signIn(h, "alice@os.test", "user-password-1");
    if (alice.status !== 200) throw new Error("sign-in");
    const alicePersonal = alice.me.spaces[0].id;
    const r = await authorize(h, alice.creds, alicePersonal);
    expect(r.status).toBe(200);
    expect(r.body.identity).toEqual({
      userId: alice.userId, name: "Alice", email: "alice@os.test", role: "member", sessionId: alice.sessionId, spaceRole: "owner",
    });
    expect((await authorize(h, { bearer: alice.creds.bearer }, alicePersonal)).status).toBe(200);
    // the admin cannot enter Alice's personal space (scope Part 2)
    expect((await authorize(h, a.creds, alicePersonal)).status).toBe(404);
    expect((await call(h, "GET", `/api/baskule/spaces/${alicePersonal}`, { creds: a.creds })).status).toBe(404);
    expect((await authorize(h, alice.creds, "does-not-exist")).status).toBe(404);
    expect((await authorize(h, alice.creds, "../etc")).status).toBe(404);
    expect((await authorize(h, {}, alicePersonal)).status).toBe(401);
  });
});

describe("60 s recheck contract", () => {
  it("lists only sessions that are live, unbanned and still members", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const sp = a.me.spaces[0].id;
    const r = await call(h, "POST", "/_baskule/check", {
      headers: internal, origin: null,
      body: { spaceId: sp, sessions: [{ userId: a.userId, sessionId: a.sessionId }, { userId: a.userId, sessionId: "nope" }, { userId: "x", sessionId: a.sessionId }] },
    });
    expect(r.body).toEqual({ valid: [a.sessionId] });
    h.storage.sql.exec("update session set expires_at = 1").toArray();
    expect(h.svc.check({ spaceId: sp, sessions: [{ userId: a.userId, sessionId: a.sessionId }] })).toEqual({ valid: [] });
  });
});

describe("connecting a device (connect codes, discovery)", () => {
  it("serves the discovery document without a session", async () => {
    const h = await makeService();
    const r = await call(h, "GET", "/.well-known/baskule", { origin: null });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      product: "baskule",
      name: "Baskule",
      authentication: { mode: "authenticated", password: true, providers: [] },
    });
  });

  it("a code signs another device in once, as a new session of the same person", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    expect((await call(h, "POST", "/auth/connect/code")).status).toBe(401);
    const issued = await call(h, "POST", "/auth/connect/code", { creds: a.creds });
    expect(issued.status).toBe(200);
    expect(issued.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.body.expiresAt).toBeGreaterThan(Date.now());
    // stored hashed, never in clear
    const rows = h.storage.sql.exec("select identifier, value from verification").toArray();
    expect(JSON.stringify(rows)).not.toContain(issued.body.code);

    // a native client: no Origin, no cookie; it gets a signed bearer
    const redeemed = await call(h, "POST", "/auth/connect/redeem", { body: { code: issued.body.code }, origin: null });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.user).toMatchObject({ id: a.userId, email: ADMIN.email });
    const bearer = redeemed.headers.get("set-auth-token");
    expect(bearer).toContain(".");
    expect(cookieFrom(redeemed)).toMatch(/^baskule\.session_token=/);
    const me = await call(h, "GET", "/api/baskule/me", { creds: { bearer: bearer! } });
    expect(me.status).toBe(200);
    expect(me.body.session.id).not.toBe(a.sessionId);

    expect((await call(h, "POST", "/auth/connect/redeem", { body: { code: issued.body.code }, origin: null })).status).toBe(404);
    // signing the new device out leaves the issuing session alive
    expect((await call(h, "POST", "/auth/sign-out", { creds: { bearer: bearer! }, origin: null })).status).toBe(200);
    expect((await call(h, "GET", "/api/baskule/me", { creds: a.creds })).status).toBe(200);
  });

  it("refuses unknown, expired and deactivated-person codes", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    expect((await call(h, "POST", "/auth/connect/redeem", { body: { code: "x".repeat(43) }, origin: null })).status).toBe(404);
    expect((await call(h, "POST", "/auth/connect/redeem", { body: {}, origin: null })).status).toBe(404);

    const expired = await call(h, "POST", "/auth/connect/code", { creds: a.creds });
    h.storage.sql.exec("update verification set expires_at = ?", Date.now() - 1000).toArray();
    expect((await call(h, "POST", "/auth/connect/redeem", { body: { code: expired.body.code }, origin: null })).status).toBe(404);

    await createUser(h, a.creds, "bob@os.test", "Bob");
    const bob = await signIn(h, "bob@os.test", "user-password-1");
    const code = (await call(h, "POST", "/auth/connect/code", { creds: bob.creds })).body.code;
    expect((await call(h, "POST", `/api/baskule/admin/users/${bob.userId}/deactivate`, { creds: a.creds })).status).toBe(200);
    expect((await call(h, "POST", "/auth/connect/redeem", { body: { code }, origin: null })).status).toBe(404);
  });
});
