import { describe, expect, it } from "vitest";
import { asAdmin, call, createUser, makeService, personalSpaceOf, signIn, type H } from "../support/harness";
import { INTERNAL_HEADER } from "../../src/shared/contract";

const internal = { [INTERNAL_HEADER]: "1" };

async function authorize(h: H, creds: { cookie?: string; bearer?: string }, spaceId: string) {
  return call(h, "POST", "/_baskule/authorize", { creds, body: { spaceId }, headers: internal, origin: null });
}

describe("team spaces", () => {
  it("admin creates a team space; members need permission; membership changes revoke", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const alice = await createUser(h, a.creds, "alice@os.test", "Alice");
    const bob = await createUser(h, a.creds, "bob@os.test", "Bob");
    const bs = await signIn(h, "bob@os.test", "user-password-1");
    if (bs.status !== 200) throw new Error("sign-in");

    // Bob may not create spaces until the admin allows it
    expect((await call(h, "POST", "/api/baskule/spaces", { creds: bs.creds, body: { name: "Bobs" } })).status).toBe(403);
    await call(h, "POST", "/api/baskule/admin/groups", { creds: a.creds, body: { name: "Space creators", members: [bob.id], permissions: { canCreateSpaces: true }, plugins: [] } });
    expect((await call(h, "POST", "/api/baskule/spaces", { creds: bs.creds, body: { name: "Bobs" } })).status).toBe(201);

    const c = await call(h, "POST", "/api/baskule/spaces", { creds: a.creds, body: { name: "Acme", members: [{ email: "alice@os.test" }, { userId: bob.id, role: "member" }] } });
    expect(c.status).toBe(201);
    const acme = c.body.space.id as string;
    expect(c.body.members.map((m: any) => [m.email, m.role]).sort()).toEqual([["admin@os.test", "owner"], ["alice@os.test", "member"], ["bob@os.test", "member"]]);

    const me = await call(h, "GET", "/api/baskule/me", { creds: bs.creds });
    expect(me.body.spaces.map((s: any) => s.name)).toEqual(["Personal", "Acme", "Bobs"]);
    expect((await authorize(h, bs.creds, acme)).body.identity.spaceRole).toBe("member");

    // A plain member cannot manage members
    expect((await call(h, "POST", `/api/baskule/spaces/${acme}/members`, { creds: bs.creds, body: { email: "admin@os.test" } })).status).toBe(403);
    expect((await call(h, "DELETE", `/api/baskule/spaces/${acme}/members/${alice.id}`, { creds: bs.creds })).status).toBe(403);

    // The admin removes Bob: revoke {userId} sent to Acme, access is gone at once
    h.calls.length = 0;
    expect((await call(h, "DELETE", `/api/baskule/spaces/${acme}/members/${bob.id}`, { creds: a.creds })).status).toBe(200);
    expect(h.revokes()).toEqual([{ spaceId: acme, path: "/_baskule/revoke", method: "POST", body: { userId: bob.id } }]);
    expect((await authorize(h, bs.creds, acme)).status).toBe(404);
    expect(h.svc.check({ spaceId: acme, sessions: [{ userId: bob.id, sessionId: bs.sessionId }] })).toEqual({ valid: [] });

    // Role change revokes too (identity carries spaceRole); last owner is protected
    h.calls.length = 0;
    expect((await call(h, "PATCH", `/api/baskule/spaces/${acme}/members/${alice.id}`, { creds: a.creds, body: { role: "owner" } })).status).toBe(200);
    expect(h.revokes()).toHaveLength(1);
    expect((await call(h, "DELETE", `/api/baskule/spaces/${acme}/members/${a.userId}`, { creds: a.creds })).status).toBe(200);
    expect((await call(h, "DELETE", `/api/baskule/spaces/${acme}/members/${alice.id}`, { creds: a.creds })).status).toBe(409);

    // Personal spaces cannot get members
    const bobPersonal = personalSpaceOf(h, bob.id);
    expect((await call(h, "POST", `/api/baskule/spaces/${bobPersonal}/members`, { creds: bs.creds, body: { email: "alice@os.test" } })).status).toBe(409);

    // Deleting a team space wipes the SpaceCell first, then the rows
    h.calls.length = 0;
    expect((await call(h, "DELETE", `/api/baskule/spaces/${acme}`, { creds: a.creds })).status).toBe(200);
    expect(h.calls.map((x) => x.path)).toContain("/_baskule/delete");
    expect((await call(h, "GET", `/api/baskule/spaces/${acme}`, { creds: a.creds })).status).toBe(404);
  });

  it("space deletion fails closed when the SpaceCell does not confirm the wipe", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const c = await call(h, "POST", "/api/baskule/spaces", { creds: a.creds, body: { name: "T" } });
    h.setFailDelete(true);
    expect((await call(h, "DELETE", `/api/baskule/spaces/${c.body.space.id}`, { creds: a.creds })).status).toBe(502);
    expect((await call(h, "GET", `/api/baskule/spaces/${c.body.space.id}`, { creds: a.creds })).status).toBe(200);
  });

  it("the admin can only delete a personal space; it is wiped and replaced by a fresh one", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const alice = await createUser(h, a.creds, "alice@os.test", "Alice");
    const as = await signIn(h, "alice@os.test", "user-password-1");
    if (as.status !== 200) throw new Error("sign-in");
    const old = personalSpaceOf(h, alice.id);
    expect((await call(h, "DELETE", `/api/baskule/spaces/${old}`, { creds: as.creds })).status).toBe(403);
    expect((await call(h, "PATCH", `/api/baskule/spaces/${old}`, { creds: a.creds, body: { name: "x" } })).status).toBe(404);
    expect((await call(h, "DELETE", `/api/baskule/spaces/${old}`, { creds: a.creds })).status).toBe(200);
    const fresh = personalSpaceOf(h, alice.id);
    expect(fresh).not.toBe(old);
    expect(h.calls.find((c) => c.path === "/_baskule/delete")?.spaceId).toBe(old);
  });
});

describe("invitations", () => {
  it("admin-only, single-use, email-bound, expiring; accepting creates the account, memberships and a session", async () => {
    const h = await makeService();
    const a = await asAdmin(h);
    const team = (await call(h, "POST", "/api/baskule/spaces", { creds: a.creds, body: { name: "Acme" } })).body.space.id;
    await createUser(h, a.creds, "bob@os.test", "Bob");
    const bs = await signIn(h, "bob@os.test", "user-password-1");
    if (bs.status !== 200) throw new Error("sign-in");
    expect((await call(h, "POST", "/api/baskule/invitations", { creds: bs.creds, body: { email: "carol@os.test" } })).status).toBe(403);
    expect((await call(h, "POST", "/api/baskule/invitations", { creds: a.creds, body: { email: "bob@os.test" } })).status).toBe(409);

    const inv = await call(h, "POST", "/api/baskule/invitations", { creds: a.creds, body: { email: "Carol@OS.test", spaces: [{ spaceId: team, role: "member" }] } });
    expect(inv.status).toBe(201);
    expect(inv.body.url).toMatch(/^http:\/\/os\.test\/invite#token=/);
    const token = inv.body.token as string;
    // the token is only stored hashed
    const stored = h.storage.sql.exec("select token_hash from invitation").toArray()[0].token_hash as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(token);
    // listing invitations never returns tokens
    expect(JSON.stringify((await call(h, "GET", "/api/baskule/invitations", { creds: a.creds })).body)).not.toContain(token);

    const look = await call(h, "POST", "/api/baskule/invitations/lookup", { body: { token }, origin: null });
    expect(look.body).toMatchObject({ email: "carol@os.test", spaces: [{ id: team, name: "Acme" }] });
    expect(look.headers.get("referrer-policy")).toBe("no-referrer");

    // email-bound: another email is refused, and the token stays usable
    expect((await call(h, "POST", "/api/baskule/invitations/accept", { body: { token, name: "Mallory", password: "mallory-pass-1", email: "mallory@os.test" } })).status).toBe(400);
    const acc = await call(h, "POST", "/api/baskule/invitations/accept", { body: { token, name: "Carol", password: "carol-pass-1" } });
    expect(acc.status).toBe(201);
    expect(acc.body.user.email).toBe("carol@os.test");
    expect(acc.body.spaces.map((s: any) => s.name)).toEqual(["Personal", "Acme"]);
    expect(acc.headers.getSetCookie().join()).toMatch(/baskule\.session_token=/);
    expect(acc.headers.get("set-auth-token")).toBeTruthy();
    // single use
    expect((await call(h, "POST", "/api/baskule/invitations/accept", { body: { token, name: "Carol2", password: "carol-pass-2" } })).status).toBe(404);
    expect((await call(h, "POST", "/api/baskule/invitations/lookup", { body: { token } })).status).toBe(404);
    expect((await signIn(h, "carol@os.test", "carol-pass-1")).status).toBe(200);
    expect((await signIn(h, "carol@os.test", "carol-pass-2")).status).toBe(401);

    // revoked and expired invitations are refused; garbage tokens too
    const inv2 = await call(h, "POST", "/api/baskule/invitations", { creds: a.creds, body: { email: "dave@os.test" } });
    await call(h, "DELETE", `/api/baskule/invitations/${inv2.body.id}`, { creds: a.creds });
    expect((await call(h, "POST", "/api/baskule/invitations/accept", { body: { token: inv2.body.token, name: "D", password: "dave-pass-12" } })).status).toBe(404);
    const inv3 = await call(h, "POST", "/api/baskule/invitations", { creds: a.creds, body: { email: "erin@os.test" } });
    h.storage.sql.exec("update invitation set expires_at = 1 where id = ?", inv3.body.id).toArray();
    expect((await call(h, "POST", "/api/baskule/invitations/accept", { body: { token: inv3.body.token, name: "E", password: "erin-pass-123" } })).status).toBe(404);
    expect((await call(h, "POST", "/api/baskule/invitations/accept", { body: { token: "x".repeat(43), name: "E", password: "erin-pass-123" } })).status).toBe(404);
  });
});
