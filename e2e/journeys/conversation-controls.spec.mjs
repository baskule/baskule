import { test, expect, signIn, startChat, assistant, sidebar, row, menu, openMenu, phoneOptions, sendMessage, navigateApp } from "./fixtures.mjs";

test("rename, archive and delete propagate to another device", { tag: ["@feature:conversation-controls"] }, async ({ page, browser, stack, people }) => {
  const context = await browser.newContext(phoneOptions);
  try {
    const phone = await context.newPage();
    await signIn(page, people.alice, stack);
    const x = await startChat(page, "First chat [[fake:text alpha]]");
    await expect(assistant(page)).toContainText("alpha", { timeout: 60_000 });
    const y = await startChat(page, "Second chat [[fake:text beta]]");
    await expect(assistant(page)).toContainText("beta", { timeout: 60_000 });
    await signIn(phone, people.alice, stack);
    await sidebar(phone);
    await expect(row(phone, x)).toBeVisible();
    await expect(row(phone, y)).toBeVisible();
    await openMenu(page, x);
    for (const name of ["Pin", "Snooze", "Mark unread"])
      await expect(page.getByRole("button", { name, exact: true }).or(page.getByRole("menuitem", { name, exact: true })).last()).toBeVisible();
    await page.getByRole("button", { name: "Rename", exact: true }).or(page.getByRole("menuitem", { name: "Rename", exact: true })).last().click();
    await sidebar(page);
    const title = page.getByRole("textbox", { name: "Thread title", exact: true });
    await title.fill("Renamed by journeys");
    await title.press("Enter");
    await expect(row(phone, x)).toContainText("Renamed by journeys");
    await menu(page, x, "Archive");
    await expect(row(page, x)).toHaveCount(0);
    await expect(row(phone, x)).toHaveCount(0);
    await menu(phone, y, "Delete");
    await expect(phone.getByText(/Delete chat/).first()).toBeVisible();
    await phone.getByRole("button", { name: "Confirm", exact: true }).or(phone.getByRole("button", { name: "Delete", exact: true })).last().click();
    await sidebar(phone);
    await sidebar(page);
    await expect(row(phone, y)).toHaveCount(0);
    await expect(row(page, y)).toHaveCount(0);
    await sidebar(page);
    await page.getByTestId("baskule-archived-link").click();
    await expect(page.getByText("Renamed by journeys").first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("archived.png") });
  } finally { await context.close(); }
});

test("a member stops a running answer", { tag: ["@feature:conversation-controls"] }, async ({ page, stack, people, api }) => {
  await signIn(page, people.bob, stack);
  const id = await startChat(page, "Very long [[fake:long 2000]] [[fake:delay 50]]", people.teamName);
  const stop = page.getByRole("button", { name: "Stop generation" });
  await expect(stop).toBeVisible();
  await expect(assistant(page)).toContainText("word1");
  await stop.click();
  await expect(stop).toHaveCount(0);
  const client = await people.bob.rpc(people.team);
  try {
    const state = api.watchThread(client, id);
    await api.waitFor("stop committed", () => state.settled());
    expect([...state.runs.values()].every((r) => ["cancelled", "interrupted", "completed"].includes(r.status))).toBe(true);
    const stopped = await api.waitFor("provider stopped and message finalized", async () => {
      const projection = await client.ok("orchestration.getThreadProjection", { threadId: id });
      const message = projection.messages.find((m) => m.role === "assistant" && m.text.startsWith("word1"));
      return message && !message.streaming && projection.providerSessions.every((s) => ["ready", "stopped"].includes(s.status)) && message;
    });
    const text = stopped.text;
    const stoppedBody = assistant(page).locator("p").filter({ hasText: /^word1(?: |$)/ });
    await expect(stoppedBody).toHaveText(text);
    await navigateApp(page, () => page.reload());
    await expect(stoppedBody).toHaveText(text);
    await sendMessage(page, "Continue [[fake:text after]]");
    await expect(assistant(page)).toContainText("after", { timeout: 60_000 });
    await api.waitFor("follow-up completed", () => state.settled() && state.assistantText().includes("after"));
    const persisted = await client.ok("orchestration.getThreadProjection", { threadId: id });
    expect(persisted.messages.find((m) => m.id === stopped.id).text).toBe(text);
    state.stop();
  } finally { client.close(); await client.closed; }
});
