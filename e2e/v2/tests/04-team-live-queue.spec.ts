// (d) Shared chats in a team space: Bob watches Alice's run stream live, with Alice's name on her message; a message
// Bob sends during the run is queued (visible to both) and answered next.
import { expect, test } from "@playwright/test";

import { assistantMessages, ensureSidebar, metric, newDevice, openChat, shot, signInBrowser, startChat, stopButton, userMessages, waitAnswer, waitComposer, world } from "./lib";

const S = "04-team-live-queue";

test("(d) Bob sees Alice's run live with her name; his message during the run is queued and answered next", { tag: ["@chat", "@team"] }, async ({ browser }) => {
  const w = await world();
  const alice = await newDevice(browser);
  const bob = await newDevice(browser);
  await signInBrowser(alice.page, w.alice);
  await signInBrowser(bob.page, w.bob);
  await waitComposer(alice.page);
  await waitComposer(bob.page);

  // Alice starts a long, slow answer in Acme (~400 words at 40 ms per chunk).
  const id = await startChat(alice.page, "Draft the Acme launch plan [[fake:long 400]] [[fake:delay 40]]", w.acme.name);
  // Bob: the chat appears in his list live (no reload), labelled Acme; he opens it while it streams.
  await ensureSidebar(bob.page);
  const row = bob.page.locator(`[data-thread-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("baskule-chat-space")).toHaveText(w.acme.name);
  await openChat(bob.page, id);
  await expect(stopButton(bob.page)).toBeVisible({ timeout: 30_000 });
  // Alice's name on her message, as Bob sees it.
  await expect(userMessages(bob.page).first().locator("[data-user-message-author]")).toContainText(w.alice.name);
  // Live: the streamed text grows on Bob's screen while the run is active.
  const len1 = (await assistantMessages(bob.page).last().innerText().catch(() => "")).length;
  await expect.poll(async () => (await assistantMessages(bob.page).last().innerText().catch(() => "")).length).toBeGreaterThan(len1);
  const len2 = (await assistantMessages(bob.page).last().innerText().catch(() => "")).length;
  expect(len2, "Bob's view grows while Alice's run streams").toBeGreaterThan(len1);
  await shot(bob.page, S, "01-bob-watches-live");

  // Bob writes during the run: queued, visible to both.
  const t0 = Date.now();
  const bobText = "Add a budget section [[fake:text Budget section added for Bob.]]";
  const box = bob.page.locator('[contenteditable="true"]').first();
  await box.click();
  await box.fill(bobText);
  await bob.page.keyboard.press("Enter");
  const queuedOnBob = bob.page.getByText("Add a budget section").first();
  await expect(queuedOnBob).toBeVisible();
  await expect(stopButton(alice.page)).toBeVisible(); // still Alice's run
  await expect(alice.page.getByText("Add a budget section").first(), "the queued message is visible to Alice").toBeVisible({ timeout: 15_000 });
  await shot(bob.page, S, "02-bob-queued");
  await shot(alice.page, S, "03-alice-sees-queue");

  // Alice's run completes, then Bob's message is answered.
  await waitAnswer(alice.page, /word400/, 120_000);
  await waitAnswer(bob.page, /Budget section added for Bob/, 120_000);
  await waitAnswer(alice.page, /Budget section added for Bob/, 60_000);
  // Order: Alice's message, the long answer, Bob's message, Bob's answer.
  const texts = await alice.page.locator("[data-message-role]").evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.messageRole}:${(e as HTMLElement).innerText.slice(0, 60).replace(/\s+/g, " ")}`));
  const iBob = texts.findIndex((t) => t.startsWith("user:") && t.includes("Add a budget section"));
  const iLong = texts.findIndex((t) => t.startsWith("assistant:") && t.includes("word1"));
  expect(iLong).toBeGreaterThanOrEqual(0);
  expect(iBob, `Bob's message after Alice's answer: ${JSON.stringify(texts)}`).toBeGreaterThan(iLong);
  // Alice sees Bob's name on his message.
  await expect(alice.page.locator('[data-message-role="user"]').filter({ hasText: "Add a budget section" }).locator("[data-user-message-author]")).toContainText(w.bob.name);
  await shot(alice.page, S, "04-alice-final");
  metric(S, { threadId: id, queuedToAnsweredMs: Date.now() - t0 });
  await alice.context.close();
  await bob.context.close();
});
