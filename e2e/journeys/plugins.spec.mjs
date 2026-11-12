import { test, expect, signIn, phoneOptions } from "./fixtures.mjs";

import { fakeMcp } from "../../platform/test/fixtures/mcp.mjs";
import { fakeOAuth } from "../../platform/test/fixtures/oauth.mjs";

const optionsFor = () => test.info().project.name === "phone" ? phoneOptions : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };

/** Admin → Plugins → "+" → MCP server, up to the review page of the server. */
async function reviewServer(page, stack, { name, url, signIn: choice }) {
  await page.goto(`${stack.urls.front}/admin/plugins/browse`);
  await page.getByRole("button", { name: "Add a plugin that isn't listed", exact: true }).click();
  await page.getByRole("menuitem", { name: "MCP server", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Server address", { exact: true }).fill(url);
  await page.getByRole("radio", { name: choice, exact: true }).click();
  await page.getByRole("button", { name: "Review server", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add plugin", exact: true })).toBeEnabled();
}

async function addReviewed(page) {
  await page.getByRole("button", { name: "Add plugin", exact: true }).click();
  await page.waitForURL(url => /^\/admin\/plugins\/installed\/[^/]+$/.test(url.pathname));
  return decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
}

/** Removes the plugin, found by name when the test stopped before it learnt the id. */
async function removePlugin(api, name) {
  const plugin = (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.find(p => p.displayName === name);
  if (plugin) await api.admin.json("DELETE", `/api/baskule/admin/plugins/${encodeURIComponent(plugin.id)}`);
}

/** One fake-model turn in a person's space; returns the assistant's text. */
async function reply(api, person, spaceId, text) {
  const client = await person.rpc(spaceId);
  const shell = api.watchShell(client);
  try {
    await expect.poll(() => shell.ready, { message: "the space is ready before the turn" }).toBe(true);
    const projectId = (await client.ok("projects.ensureScratch", {})).projectId;
    const id = await api.launch(client, projectId, text, "Plugin tools", { generateTitle: false });
    const state = api.watchThread(client, id);
    try { await api.waitRun(state); return state.assistantText(); } finally { state.stop(); }
  } finally { shell.stop(); client.close(); await client.closed; }
}

test("an MCP server added by address serves members until they switch it off", { tag: ["@feature:plugins"] }, async ({ browser, stack, people, api }) => {
  const mcp = await fakeMcp();
  const adminContext = await browser.newContext(optionsFor());
  const memberContext = await browser.newContext(optionsFor());
  const adminPage = await adminContext.newPage();
  const memberPage = await memberContext.newPage();
  const name = `Team notes ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await signIn(adminPage, api.admin, stack);
    await reviewServer(adminPage, stack, { name, url: mcp.resource, signIn: "No sign-in" });
    await expect(adminPage.getByText("No sign-in needed", { exact: true })).toBeVisible();
    await expect(adminPage.getByRole("radio", { name: "Everyone in your organization", exact: true })).toBeChecked();
    await adminPage.screenshot({ path: test.info().outputPath("plugin-review-mcp-server.png"), fullPage: true });
    const pluginId = await addReviewed(adminPage);
    await expect(adminPage.getByRole("heading", { name, exact: true })).toBeVisible();
    const added = (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.find(p => p.id === pluginId);
    expect(added).toMatchObject({ status: "ready", access: { kind: "everyone" }, origin: { kind: "custom" } });

    await signIn(memberPage, people.alice, stack);
    await memberPage.goto(`${stack.urls.front}/settings/plugins`);
    const toggle = memberPage.getByRole("group", { name, exact: true }).getByRole("switch", { name: `Use ${name}`, exact: true });
    await expect(toggle).toBeChecked();
    await expect(memberPage.getByRole("button", { name: /^(Add|Install)/ })).toHaveCount(0);
    await memberPage.screenshot({ path: test.info().outputPath("plugin-member-on.png") });
    const personal = api.personalSpace(people.alice);
    expect(await reply(api, people.alice, personal, "Read the notes [[fake:tool *fixture_read {}]]")).toContain("The team's notes are ready.");
    expect(mcp.calls).toEqual(["fixture_read"]);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => (await people.alice.json("GET", "/api/baskule/plugins")).plugins.find(p => p.id === pluginId)?.on, { message: "the member's switch is saved" }).toBe(false);
    await reply(api, people.alice, personal, "Read them again [[fake:tool *fixture_read {}]]");
    expect(mcp.calls, "a switched-off plugin makes no call").toEqual(["fixture_read"]);
  } finally {
    await removePlugin(api, name);
    await adminContext.close(); await memberContext.close(); await mcp.close();
  }
});

test("a service without automatic registration waits for the admin's OAuth client, then each member signs in as themselves", { tag: ["@feature:plugins"] }, async ({ browser, stack, people, api }) => {
  const oauth = await fakeOAuth();
  oauth.state.dcr = false;
  const adminContext = await browser.newContext(optionsFor());
  const memberContext = await browser.newContext(optionsFor());
  const adminPage = await adminContext.newPage();
  const memberPage = await memberContext.newPage();
  const name = `Private files ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await signIn(adminPage, api.admin, stack);
    await reviewServer(adminPage, stack, { name, url: oauth.resource, signIn: "Each person signs in with their own account" });
    const card = adminPage.getByRole("form", { name: /^Set up sign-in to / });
    await expect(card).toBeVisible();
    await expect(card.locator("output")).toHaveText(/\/api\/baskule\/plugins\/oauth\/callback$/);
    await card.scrollIntoViewIfNeeded();
    await adminPage.screenshot({ path: test.info().outputPath("plugin-review-oauth-client.png") });
    const pluginId = await addReviewed(adminPage);
    await expect(adminPage.getByText("Needs setup", { exact: true })).toBeVisible();

    await signIn(memberPage, people.alice, stack);
    await memberPage.goto(`${stack.urls.front}/settings/plugins`);
    const row = memberPage.getByRole("group", { name, exact: true });
    await expect(row.getByText("Not ready yet, ask an administrator", { exact: true })).toBeVisible();
    await expect(memberPage.getByRole("link", { name: `Sign in to ${name}`, exact: true })).toHaveCount(0);

    const setup = adminPage.getByRole("form", { name: /^Set up sign-in to / });
    await setup.getByLabel("Client ID", { exact: true }).fill("fake-client");
    await setup.getByLabel("Client secret", { exact: true }).fill("fake-secret");
    await setup.getByRole("button", { name: "Save OAuth client", exact: true }).click();
    await expect(adminPage.getByText(/OAuth client\./).first()).toBeVisible();
    await expect.poll(async () => (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.find(p => p.id === pluginId)?.status, { message: "the saved client finishes the setup" }).toBe("ready");
    await adminPage.screenshot({ path: test.info().outputPath("plugin-oauth-client-saved.png") });

    oauth.state.identity = "alice";
    await memberPage.reload();
    const back = memberPage.waitForURL(url => url.pathname === "/settings/plugins" && url.searchParams.has("connection"), { waitUntil: "commit" });
    await memberPage.getByRole("link", { name: `Sign in to ${name}`, exact: true }).click();
    await back;
    expect(new URL(memberPage.url()).searchParams.get("connection"), new URL(memberPage.url()).search).toBe("connected");
    await expect(row.getByText(/^Connected/)).toBeVisible();
    await memberPage.screenshot({ path: test.info().outputPath("plugin-member-connected.png") });

    expect(await reply(api, people.bob, api.personalSpace(people.bob), "Look it up [[fake:tool *fixture_lookup {}]]")).not.toContain("private fixture document");
    expect(oauth.calls, "a member who never signed in makes no vendor call").toHaveLength(0);
    expect(await reply(api, people.alice, api.personalSpace(people.alice), "Look it up [[fake:tool *fixture_lookup {}]]")).toContain("private fixture document");
    expect(oauth.calls).toHaveLength(1);
    expect(oauth.calls[0]).toMatchObject({ identity: "alice" });

    await memberPage.getByRole("button", { name: `Disconnect ${name}`, exact: true }).click();
    await memberPage.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(memberPage.getByRole("link", { name: `Sign in to ${name}`, exact: true })).toBeVisible();
  } finally {
    await removePlugin(api, name);
    await api.admin.json("DELETE", `/api/baskule/admin/oauth-clients?issuer=${encodeURIComponent(oauth.issuer)}`).catch(() => {});
    await adminContext.close(); await memberContext.close(); await oauth.close();
  }
});
