// (f) The admin removes Bob from Acme: Bob's already-open tab loses access within seconds (its Acme socket is
// closed, Acme's chats leave his list, nothing he sends reaches Acme). Bob is added back at the end.
import { expect, test } from "@playwright/test";

import { adminApi, chatRow, ensureSidebar, metric, newDevice, openChat, personApi, shot, signInBrowser, startChat, until, waitAnswer, waitComposer, world, wsPath } from "./lib";

const S = "06-member-removal";

test("(f) removing Bob from Acme cuts his open tab within seconds", { tag: ["@security", "@team"] }, async ({ browser }) => {
  const w = await world();
  const admin = await adminApi();
  const bobApi = await personApi(w.bob);
  // A chat in Acme, open in Bob's tab.
  const alice = await newDevice(browser);
  await signInBrowser(alice.page, w.alice);
  await waitComposer(alice.page);
  const id = await startChat(alice.page, "Acme roadmap [[fake:text Roadmap ready.]]", w.acme.name);
  await waitAnswer(alice.page, /Roadmap ready/);

  const bob = await newDevice(browser);
  const sockets: Array<{ url: string; closedAt?: number }> = [];
  bob.page.on("websocket", (ws) => {
    const rec: { url: string; closedAt?: number } = { url: ws.url() };
    sockets.push(rec);
    ws.on("close", () => (rec.closedAt = Date.now()));
  });
  await signInBrowser(bob.page, w.bob);
  await waitComposer(bob.page);
  await openChat(bob.page, id);
  await expect(bob.page.getByText("Roadmap ready.", { exact: true })).toBeVisible();
  const acmeSocket = () => sockets.find((s) => s.url.includes(wsPath(w.acme.id).split("?")[0]!) && !s.closedAt);
  await until(() => acmeSocket(), 30_000, 250, "Bob's Acme socket");
  await shot(bob.page, S, "01-bob-in-acme");

  // Removal.
  const t0 = Date.now();
  const r = await admin.req("DELETE", `/api/baskule/spaces/${w.acme.id}/members/${w.bob.id}`);
  expect(r.status).toBe(200);
  const removedMs = Date.now() - t0;
  // Server side: immediately refused.
  expect((await bobApi.get(`/s/${w.acme.id}/.well-known/t3/environment`)).status).toBe(404);
  // Bob's open socket to Acme is closed by the server (push revocation).
  const closed = await until(() => sockets.find((s) => s.url.includes(`/s/${w.acme.id}/`) && s.closedAt), 15_000, 100, "Acme socket closed");
  const socketClosedMs = closed.closedAt! - t0;
  // ... and no new Acme socket stays open (reconnects are refused).
  await bob.page.waitForTimeout(3000); // no-fixed-sleep-allow: Observe the reconnect window after the socket-close signal; reconnect must stay refused.
  expect(sockets.filter((s) => s.url.includes(`/s/${w.acme.id}/`) && !s.closedAt).length, "no Acme socket open after removal").toBe(0);
  // The UI drops Acme: its chats leave Bob's list.
  await ensureSidebar(bob.page);
  await expect(chatRow(bob.page, id)).toHaveCount(0, { timeout: 15_000 });
  await expect(bob.page).not.toHaveURL(new RegExp(id), { timeout: 15_000 });
  await expect(bob.page.getByText("Roadmap ready.", { exact: true })).toHaveCount(0);
  await expect(bob.page.getByText("Access to this space was removed", { exact: true })).toBeVisible();
  const uiGoneMs = Date.now() - t0;
  await shot(bob.page, S, "02-bob-after-removal");
  // Alice is unaffected.
  await expect(alice.page.getByText("Roadmap ready.", { exact: true })).toBeVisible();
  expect((await (await personApi(w.alice)).get(`/s/${w.acme.id}/.well-known/t3/environment`)).status).toBe(200);
  metric(S, { removedMs, socketClosedMs, uiGoneMs });
  console.log(`removal: API ${removedMs} ms, Bob's socket closed after ${socketClosedMs} ms, chats gone from his UI after ${uiGoneMs} ms`);
  expect(socketClosedMs, "socket cut within seconds").toBeLessThan(5_000);
  expect(uiGoneMs, "Acme leaves the open tab within seconds").toBeLessThan(15_000);

  // Restore the world: Bob back in Acme.
  const back = await admin.post(`/api/baskule/spaces/${w.acme.id}/members`, { userId: w.bob.id, role: "member" });
  expect([200, 201]).toContain(back.status);
  expect((await bobApi.get(`/s/${w.acme.id}/.well-known/t3/environment`)).status).toBe(200);
  await alice.context.close();
  await bob.context.close();
});
