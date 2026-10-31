import { describe, expect, it, vi } from "vitest";
import { asAdmin, call, createUser, makeService, personalSpaceOf, signIn, type H } from "../support/harness";
import { fakeOAuth } from "../fixtures/oauth.mjs";
import { INTERNAL_HEADER } from "../../src/shared/contract";

const API = "/api/baskule";
async function setup(h: H, resource: string) {
  const a = await asAdmin(h);
  const added = await call(h, "POST", `${API}/admin/plugins`, { creds: a.creds, body: { groups: ["everyone"], source: { type: "url", url: resource } } });
  const id = added.body.id;
  await call(h, "PATCH", `${API}/admin/plugins/${id}`, { creds: a.creds, body: { servers: [{ name: "remote", credential: "user-oauth" }] } });
  const accounts = async () => (await call(h, "GET", `${API}/plugins`, { creds: a.creds })).body.plugins.find((p: { id: string }) => p.id === id).servers[0].accounts;
  const start = async (label: string, account?: string, creds = a.creds) => {
    const start = await call(h, "GET", `${API}/plugins/${id}/connect?${new URLSearchParams({ server: "remote", ...(account ? { account } : { label }) })}`, { creds });
    const authorized = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const url = new URL(authorized.headers.get("location")!);
    return url.pathname + url.search;
  };
  const connect = async (label: string, account?: string, creds = a.creds) => {
    const done = await call(h, "GET", await start(label, account, creds), { creds });
    expect(done.headers.get("location")).toContain("pluginConnection=connected");
  };
  const credential = (account?: string, userId = a.userId, spaceId = personalSpaceOf(h, userId)) => call(h, "POST", "/_baskule/plugin-credential", { headers: { [INTERNAL_HEADER]: "1" }, body: { spaceId, userId, pluginId: id, server: "remote", ...(account ? { account } : {}) } });
  const change = (accountId: string, body: object, creds = a.creds) => call(h, "PATCH", `${API}/plugins/${id}/accounts/${accountId}`, { creds, body });
  const remove = (accountId: string, replacement?: string, creds = a.creds) => call(h, "DELETE", `${API}/plugins/${id}/accounts/${accountId}${replacement ? `?default=${replacement}` : ""}`, { creds });
  return { a, id, accounts, start, connect, credential, change, remove };
}

describe("several plugin accounts", () => {
  it("keeps two named accounts, selects the default and an owned label, and isolates another person's labels", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await setup(h, f.resource);
      await x.connect("Work"); await x.connect("Second");
      const accounts = await x.accounts();
      expect(accounts).toHaveLength(2);
      expect(accounts.filter((a: { default: boolean }) => a.default).map((a: { label: string }) => a.label)).toEqual(["Work"]);
      expect((await x.credential()).body.account.label).toBe("Work");
      expect((await x.credential("second")).body.account.label).toBe("Second");
      const bob = await createUser(h, x.a.creds, "account-bob@os.test", "Bob");
      expect((await x.credential("Work", bob.id)).body).toEqual({ error: "connect" });
      const b = await signIn(h, bob.email, "user-password-1");
      await x.connect("Bob private", undefined, b.creds);
      expect((await x.credential("Work", bob.id)).body).toEqual({ error: "unknown_account", accounts: ["Bob private (default)"] });
      expect((await x.credential("Bob private")).body).toEqual({ error: "unknown_account", accounts: ["Work (default)", "Second"] });
      const unknown = await x.credential("Other");
      expect(unknown.body).toEqual({ error: "unknown_account", accounts: ["Work (default)", "Second"] });
    } finally { await f.close(); }
  });
  it("renames and reconnects the same account, and requires an owned replacement when removing the default", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await setup(h, f.resource);
      await x.connect("Work"); await x.connect("Second");
      const [work, second] = await x.accounts();
      expect((await x.change(work.id, { label: "Primary" })).status).toBe(200);
      await x.connect("ignored", work.id);
      expect((await x.accounts()).find((a: { id: string }) => a.id === work.id)).toEqual({ ...work, label: "Primary" });
      expect((await x.change(second.id, { label: "Primary" })).status).toBe(409);
      expect((await x.remove(work.id)).status).toBe(409);
      expect((await x.remove(work.id, "missing")).status).toBe(409);
      expect((await x.accounts())).toHaveLength(2);
      expect((await x.remove(work.id, second.id)).status).toBe(200);
      expect(await x.accounts()).toEqual([{ ...second, default: true }]);
      expect((await x.remove(second.id)).status).toBe(200);
      expect((await x.credential()).body).toEqual({ error: "connect" });
    } finally { await f.close(); }
  });
  it("refuses another person's account mutations without revealing that account", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await setup(h, f.resource);
      await x.connect("Work"); const [work] = await x.accounts();
      const bob = await createUser(h, x.a.creds, "account-owner@os.test", "Bob");
      const b = await signIn(h, bob.email, "user-password-1");
      expect((await x.change(work.id, { label: "Stolen", default: true }, b.creds)).status).toBe(404);
      expect((await x.remove(work.id, undefined, b.creds)).status).toBe(404);
      expect(await x.accounts()).toEqual([work]);
    } finally { await f.close(); }
  });
  it("makes exactly one concurrently connected first account the default, enforced by SQL", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await setup(h, f.resource);
      const callbacks = await Promise.all([x.start("Work"), x.start("Second")]);
      const results = await Promise.all(callbacks.map(path => call(h, "GET", path, { creds: x.a.creds })));
      for (const done of results) expect(done.headers.get("location")).toContain("pluginConnection=connected");
      const accounts = await x.accounts();
      expect(accounts).toHaveLength(2);
      expect(accounts.filter((a: { default: boolean }) => a.default)).toHaveLength(1);
      expect(() => h.storage.sql.exec("update plugin_connection set is_default=1").toArray()).toThrow();
    } finally { await f.close(); }
  });
  it("keeps team use off by default and permits only the author's current default after the owner enables it", async () => {
    const f = await fakeOAuth();
    try {
      const h = await makeService(); const x = await setup(h, f.resource);
      await x.connect("Work"); await x.connect("Second");
      const [, second] = await x.accounts();
      const team = (await call(h, "POST", `${API}/spaces`, { creds: x.a.creds, body: { name: "Accounts team" } })).body.space.id;
      expect((await x.credential(undefined, x.a.userId, team)).body).toEqual({ error: "unavailable" });
      await call(h, "PUT", `${API}/spaces/${team}/plugins`, { creds: x.a.creds, body: { personalPluginsAllowed: true, disabled: [] } });
      expect((await x.credential(undefined, x.a.userId, team)).body.account.label).toBe("Work");
      expect((await x.credential("Second", x.a.userId, team)).body).toEqual({ error: "default_account_required" });
      expect((await x.change(second.id, { default: true })).status).toBe(200);
      expect((await x.credential(undefined, x.a.userId, team)).body.account.label).toBe("Second");
      expect((await x.credential("Work", x.a.userId, team)).body).toEqual({ error: "default_account_required" });
    } finally { await f.close(); }
  });
  it("refreshes different accounts independently and shares concurrent refreshes of one account", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    let release: (() => void) | undefined;
    try {
      const h = await makeService(); const x = await setup(h, f.resource);
      await x.connect("Work"); await x.connect("Second");
      f.state.shortLived = false;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      f.state.onRefresh = () => barrier;
      const work = x.credential("Work"), second = x.credential("Second"), alsoWork = x.credential("Work");
      await vi.waitFor(() => expect(f.state.refreshes).toBe(2));
      release!();
      const results = await Promise.all([work, second, alsoWork]);
      expect(results[0].body.headers).toEqual(results[2].body.headers);
      expect(results[0].body.headers).not.toEqual(results[1].body.headers);
      expect(results.map(r => r.body.account.label)).toEqual(["Work", "Second", "Work"]);
      expect(f.state.refreshes).toBe(2);
    } finally { release?.(); await f.close(); }
  });
  it("does not overwrite a reconnected account with a refresh started before that reconnect", async () => {
    const f = await fakeOAuth(); f.state.shortLived = true;
    try {
      const h = await makeService(); const x = await setup(h, f.resource);
      await x.connect("Work"); const [work] = await x.accounts();
      f.state.shortLived = false;
      f.state.onRefresh = () => x.connect("ignored", work.id);
      expect((await x.credential()).body).toEqual({ error: "unavailable" });
      expect((await x.credential()).body.account).toEqual({ id: work.id, label: "Work" });
      expect(f.state.refreshes).toBe(1);
      expect(f.state.exchanges).toBe(2);
    } finally { await f.close(); }
  });
});
