import { describe, expect, it } from "vitest";
import { asAdmin, call, createUser, makeService, personalSpaceOf, signIn } from "../support/harness";

describe("admin", () => {
  it("non-admins get 403, anonymous 401", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    await createUser(h, a.creds, "bob@os.test", "Bob");
    const bs = await signIn(h, "bob@os.test", "user-password-1");
    if (bs.status !== 200) throw new Error("sign-in");
    for (const [m, p] of [["GET", "/api/baskule/admin/users"], ["POST", "/api/baskule/admin/users"], ["GET", "/api/baskule/admin/spaces"]] as const) {
      expect((await call(h, m, p, { creds: bs.creds, body: m === "POST" ? {} : undefined })).status).toBe(403);
      expect((await call(h, m, p, { body: m === "POST" ? {} : undefined })).status).toBe(401);
    }
  });

  it("temporary password only for never-signed-in accounts; reset link revokes every session", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob");
    expect((await call(h, "POST", `/api/baskule/admin/users/${bob.id}/password`, { creds: a.creds, body: { password: "temp-pass-22" } })).status).toBe(200);
    const s1 = await signIn(h, "bob@os.test", "temp-pass-22");
    if (s1.status !== 200) throw new Error("sign-in");
    const s2 = await signIn(h, "bob@os.test", "temp-pass-22");
    if (s2.status !== 200) throw new Error("sign-in");
    // now that Bob has signed in, the admin can no longer set his password (review M7)
    expect((await call(h, "POST", `/api/baskule/admin/users/${bob.id}/password`, { creds: a.creds, body: { password: "admin-chosen-1" } })).status).toBe(409);

    const link = await call(h, "POST", `/api/baskule/admin/users/${bob.id}/reset-link`, { creds: a.creds });
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(/\/reset-password#token=/);
    h.calls.length = 0;
    const rs = await call(h, "POST", "/auth/reset-password", { body: { token: link.body.token, newPassword: "bob-new-pass-1" } });
    expect(rs.status).toBe(200);
    // every session of Bob is gone, and each one was revoked in Bob's spaces
    expect((await call(h, "GET", "/api/baskule/me", { creds: s1.creds })).status).toBe(401);
    expect((await call(h, "GET", "/api/baskule/me", { creds: { bearer: s2.creds.bearer } })).status).toBe(401);
    const revoked = h.revokes().map((r) => r.body.sessionId).sort();
    expect(revoked).toEqual([s1.sessionId, s2.sessionId].sort());
    // the reset token is single-use
    expect((await call(h, "POST", "/auth/reset-password", { body: { token: link.body.token, newPassword: "bob-new-pass-2" } })).status).toBe(400);
    expect((await signIn(h, "bob@os.test", "bob-new-pass-1")).status).toBe(200);
  });

  it("deactivate, sign-out-everywhere, sign-out and change-password revoke sockets; deactivated users cannot sign in", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob");
    const bobPersonal = personalSpaceOf(h, bob.id);

    // sign-out on one device → revoke that session only
    const d1 = await signIn(h, "bob@os.test", "user-password-1");
    const d2 = await signIn(h, "bob@os.test", "user-password-1");
    if (d1.status !== 200 || d2.status !== 200) throw new Error("sign-in");
    h.calls.length = 0;
    expect((await call(h, "POST", "/auth/sign-out", { creds: d1.creds, body: {} })).status).toBe(200);
    expect(h.revokes()).toEqual([{ spaceId: bobPersonal, path: "/_baskule/revoke", method: "POST", body: { sessionId: d1.sessionId } }]);
    expect((await call(h, "GET", "/api/baskule/me", { creds: d2.creds })).status).toBe(200);

    // change-password with revokeOtherSessions → the other device is revoked
    const d3 = await signIn(h, "bob@os.test", "user-password-1");
    if (d3.status !== 200) throw new Error("sign-in");
    h.calls.length = 0;
    const cp = await call(h, "POST", "/auth/change-password", { creds: d3.creds, body: { currentPassword: "user-password-1", newPassword: "user-password-2", revokeOtherSessions: true } });
    expect(cp.status).toBe(200);
    expect(h.revokes().map((r) => r.body.sessionId)).toContain(d2.sessionId);
    expect((await call(h, "GET", "/api/baskule/me", { creds: d2.creds })).status).toBe(401);

    // sign-out-everywhere
    const d4 = await signIn(h, "bob@os.test", "user-password-2");
    if (d4.status !== 200) throw new Error("sign-in");
    h.calls.length = 0;
    expect((await call(h, "POST", `/api/baskule/admin/users/${bob.id}/sign-out-everywhere`, { creds: a.creds })).status).toBe(200);
    expect((await call(h, "GET", "/api/baskule/me", { creds: d4.creds })).status).toBe(401);
    expect(h.revokes().some((r) => r.body.userId === bob.id)).toBe(true);

    // deactivate
    const d5 = await signIn(h, "bob@os.test", "user-password-2");
    if (d5.status !== 200) throw new Error("sign-in");
    expect((await call(h, "POST", `/api/baskule/admin/users/${bob.id}/deactivate`, { creds: a.creds })).status).toBe(200);
    expect((await call(h, "GET", "/api/baskule/me", { creds: d5.creds })).status).toBe(401);
    expect((await signIn(h, "bob@os.test", "user-password-2")).status).toBe(403);
    expect(h.svc.check({ spaceId: bobPersonal, sessions: [{ userId: bob.id, sessionId: d5.sessionId }] })).toEqual({ valid: [] });
    expect((await call(h, "POST", `/api/baskule/admin/users/${bob.id}/activate`, { creds: a.creds })).status).toBe(200);
    expect((await signIn(h, "bob@os.test", "user-password-2")).status).toBe(200);
    // an admin cannot deactivate or delete themselves
    expect((await call(h, "POST", `/api/baskule/admin/users/${a.userId}/deactivate`, { creds: a.creds })).status).toBe(409);
    expect((await call(h, "DELETE", `/api/baskule/admin/users/${a.userId}`, { creds: a.creds })).status).toBe(409);
  });

  it("role changes revoke and keep one admin; deleting a person wipes their personal space", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob");
    const bobPersonal = personalSpaceOf(h, bob.id);
    expect((await call(h, "PATCH", `/api/baskule/admin/users/${a.userId}`, { creds: a.creds, body: { role: "member" } })).status).toBe(409);
    h.calls.length = 0;
    const r = await call(h, "PATCH", `/api/baskule/admin/users/${bob.id}`, { creds: a.creds, body: { role: "admin" } });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe("admin");
    expect(h.revokes()).toEqual([{ spaceId: bobPersonal, path: "/_baskule/revoke", method: "POST", body: { userId: bob.id } }]);

    const users = await call(h, "GET", "/api/baskule/admin/users", { creds: a.creds });
    expect(users.body.users.map((u: any) => u.email).sort()).toEqual(["admin@os.test", "bob@os.test"]);
    // overview: cached by default (no SpaceCell call), live on request
    h.calls.length = 0;
    const cached = await call(h, "GET", "/api/baskule/admin/spaces", { creds: a.creds });
    expect(h.calls).toEqual([]);
    expect(cached.body.spaces.find((s: any) => s.id === bobPersonal).status).toBeNull();
    const spaces = await call(h, "GET", "/api/baskule/admin/spaces?status=live", { creds: a.creds });
    expect(spaces.body.spaces.find((s: any) => s.id === bobPersonal)).toMatchObject({ kind: "personal", owner: { email: "bob@os.test" }, status: { awake: false } });
    const cached2 = await call(h, "GET", "/api/baskule/admin/spaces", { creds: a.creds });
    expect(cached2.body.spaces.find((s: any) => s.id === bobPersonal).status).toEqual({ awake: false, sockets: 0, activeRuns: 0, computer: null });

    // stop a space's agent and computer: admin only, calls POST /_baskule/stop, 502 if the cell fails
    h.calls.length = 0;
    const st = await call(h, "POST", `/api/baskule/admin/spaces/${bobPersonal}/stop`, { creds: a.creds });
    expect(st.status).toBe(200);
    expect(h.calls.map((c) => [c.spaceId, c.method, c.path])).toEqual([[bobPersonal, "POST", "/_baskule/stop"], [bobPersonal, "GET", "/_baskule/status"]]);
    expect((await call(h, "POST", "/api/baskule/admin/spaces/unknown-space/stop", { creds: a.creds })).status).toBe(404);
    await createUser(h, a.creds, "carol@os.test", "Carol"); // Bob is an admin by now
    const cs = await signIn(h, "carol@os.test", "user-password-1");
    expect((await call(h, "POST", `/api/baskule/admin/spaces/${bobPersonal}/stop`, { creds: cs.creds })).status).toBe(403);
    h.setFailDelete(true);
    expect((await call(h, "POST", `/api/baskule/admin/spaces/${bobPersonal}/stop`, { creds: a.creds })).status).toBe(502);
    h.setFailDelete(false);
    expect(spaces.body.spaces.find((s: any) => s.id === bobPersonal).members).toBeUndefined();

    h.calls.length = 0;
    expect((await call(h, "DELETE", `/api/baskule/admin/users/${bob.id}`, { creds: a.creds })).status).toBe(200);
    expect(h.calls.find((c) => c.path === "/_baskule/delete")?.spaceId).toBe(bobPersonal);
    expect(h.storage.sql.exec("select count(*) as n from space where id = ?", bobPersonal).toArray()[0].n).toBe(0);
    expect((await signIn(h, "bob@os.test", "user-password-1")).status).toBe(401);
  });
});
