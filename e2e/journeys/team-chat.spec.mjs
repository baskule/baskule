import { test, expect, signIn, startChat, assistant, sendMessage, sidebar, closeSidebar, row, phoneOptions } from "./fixtures.mjs";

test("team chat streams author-stamped messages and catches up after every device disconnects", { tag: ["@feature:team-chat"] }, async ({ page, browser, stack, people, api }) => {
  const peer = await browser.newContext(phoneOptions);
  const phone = await peer.newPage();
  try {
    await signIn(page, people.alice, stack);
    await signIn(phone, people.bob, stack);
    const id = await startChat(page, "Long report [[fake:long 80]] [[fake:delay 100]]", people.teamName);
    await expect(assistant(page)).toContainText("word1", { timeout: 60_000 });
    await sidebar(page);
    await expect(page.getByTestId("baskule-space-heading").filter({ hasText: people.teamName })).toBeVisible();
    await closeSidebar(page);
    await sidebar(phone);
    await expect(row(phone, id)).toBeVisible();
    await row(phone, id).click();
    await phone.keyboard.press("Escape");
    await expect(assistant(phone)).toContainText("word1", { timeout: 60_000 });
    await expect(phone.locator("[data-user-message-author]").first()).toContainText("Alice");
    await expect.poll(async () => {
      const overview = await api.admin.json("GET", "/api/baskule/admin/spaces?status=live");
      return overview.spaces.find((s) => s.id === people.team)?.status?.activeRuns;
    }).toBe(1);
    await page.close();
    await peer.close();
    await expect.poll(async () => {
      const overview = await api.admin.json("GET", "/api/baskule/admin/spaces?status=live");
      return overview.spaces.find((s) => s.id === people.team)?.status?.activeRuns;
    }, { timeout: 120_000 }).toBe(0);
    const reopened = await browser.newContext(phoneOptions);
    try {
      const p = await reopened.newPage();
      await signIn(p, people.bob, stack);
      await sidebar(p);
      await row(p, id).click();
      await expect(assistant(p)).toContainText("word80");
      await expect(assistant(p)).toContainText("word1 ");
      await sendMessage(p, "Next? [[fake:text About a week.]]");
      await expect(assistant(p)).toContainText("About a week.", { timeout: 60_000 });
      await p.screenshot({ path: test.info().outputPath("caught-up.png") });
    } finally { await reopened.close(); }
  } finally { if (browser.contexts().includes(peer)) await peer.close(); }
});
