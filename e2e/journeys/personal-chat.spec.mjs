import { test, expect, signIn, startChat, assistant, sendMessage, sidebar, row, navigateApp } from "./fixtures.mjs";

test("home lists spaces; personal chat streams two turns without starting a computer", { tag: ["@feature:personal-chat"] }, async ({ page, stack, people, api }) => {
  await signIn(page, people.alice, stack);
  await expect(page.getByText("What can I help with?")).toBeVisible();
  const picker = page.getByRole("combobox", { name: "Run on", exact: true });
  await expect(picker).toHaveText("Personal");
  await picker.click();
  await expect(page.getByRole("option").first()).toContainText("Personal");
  await expect(page.getByRole("option", { name: people.teamName, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const computer = async () => {
    const response = await fetch(`http://127.0.0.1:${stack.ports.computerd}/v1/spaces/${api.personalSpace(people.alice)}/computer`, { headers: { authorization: `Bearer ${stack.computerdToken}` } });
    expect(response.ok).toBe(true);
    return response.json();
  };
  expect((await computer()).running).toBe(false);
  const id = await startChat(page, "What is a sourdough starter? [[fake:text A sourdough starter is flour and water, fermented.]]");
  await expect(assistant(page)).toContainText("flour and water, fermented", { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0);
  await sendMessage(page, "And next? [[fake:text About a week.]]");
  await expect(assistant(page)).toContainText("About a week.", { timeout: 60_000 });
  await sidebar(page);
  await expect(row(page, id)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Personal", exact: true })).toBeVisible();
  await page.getByTestId("baskule-user-menu").click();
  await page.screenshot({ path: test.info().outputPath("home-user-menu.png") });
  expect((await computer()).running).toBe(false);
});

test("changing providers reconnects the open browser and new chats work before and after refresh", { tag: ["@feature:personal-chat"] }, async ({ page, stack, api }) => {
  const person = await api.person("ProviderSwitch", crypto.randomUUID());
  const space = api.personalSpace(person);
  const sockets = [];
  page.on("websocket", (socket) => {
    if (socket.url().includes(`/s/${space}/ws`)) sockets.push(socket);
  });
  const saved = await api.admin.json("GET", "/api/baskule/admin/settings");
  const { organizationName, idleMinutes, ai, transcription } = saved;
  const settings = { organizationName, idleMinutes, ai, transcription };
  try {
    await signIn(page, person, stack);
    await sendMessage(page, "Before switching [[fake:text BEFORE_SWITCH_OK]]");
    await expect(assistant(page)).toContainText("BEFORE_SWITCH_OK", { timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0);
    expect(sockets.length).toBeGreaterThan(0);
    const previous = sockets.at(-1);
    // Both provider packages call the local fake LLM; no vendor receives a request.
    await api.admin.json("PATCH", "/api/baskule/admin/settings", {
      ...settings, ai: { ...ai, providerId: "mistral" }, apiKey: "fake-llm-key",
    });
    await expect.poll(() => previous.isClosed(), { message: "old runtime closes its RPC socket" }).toBe(true);
    await sidebar(page);
    await page.getByTestId("baskule-new-chat").click();
    await expect(page).toHaveURL(/\/draft\//);
    await sendMessage(page, "After switching [[fake:text AFTER_SWITCH_OK]]");
    await expect(assistant(page)).toContainText("AFTER_SWITCH_OK", { timeout: 60_000 });
    await expect(page.getByText("Failed to launch thread", { exact: true })).toHaveCount(0);

    await sidebar(page);
    await page.getByTestId("baskule-new-chat").click();
    await expect(page).toHaveURL(/\/draft\//);
    await navigateApp(page, () => page.reload());
    await sendMessage(page, "After refresh [[fake:text AFTER_REFRESH_OK]]");
    await expect(assistant(page)).toContainText("AFTER_REFRESH_OK", { timeout: 60_000 });
    await page.screenshot({ path: test.info().outputPath("provider-switch-new-chat.png") });
  } finally {
    try {
      await api.admin.json("PATCH", "/api/baskule/admin/settings", settings);
    } finally {
      await api.admin.json("POST", `/api/baskule/admin/spaces/${space}/stop`, {});
    }
  }
});
