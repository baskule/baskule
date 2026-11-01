import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures.mjs";
import { fakeMcp } from "../../platform/test/fixtures/mcp.mjs";

const folder = fileURLToPath(new URL("../../.run/plugins/mcp/", import.meta.url));

test("folder entry is configured in the UI, survives restart, and disappears after removal", { tag: ["@feature:plugins", "@profile:light"] }, async ({ browser, stack, stackCtl, api }) => {
  test.slow(); // Three celld restarts rebuild the real Worker and assets.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const name = `folder-crm-${crypto.randomUUID()}`;
  const file = `${folder}${name}.json`;
  const mcp = await fakeMcp({ key: "Bearer folder-journey-key" });
  let removed = false;
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { crm: { url: mcp.resource, headers: { Authorization: "${CRM_KEY}" } } } }));
    stackCtl.restart("celld");
    const listing = await api.admin.json("GET", "/api/baskule/admin/plugins");
    const plugin = listing.plugins.find(p => p.source.type === "folder" && p.source.path === `mcp/${name}.json`);
    expect(plugin).toBeTruthy();
    expect(listing.folder.problems).toEqual([]);
    expect(plugin.setup).toEqual([{ server: "crm", done: false }]);
    await context.addCookies(api.admin.cookie.split("; ").map(cookie => {
      const [name, ...value] = cookie.split("=");
      return { name, value: value.join("="), url: stack.urls.front };
    }));
    const url = `${stack.urls.front}/admin/plugins/installed/${plugin.id}`;
    await page.goto(url);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: /Everyone/ })).not.toBeChecked();
    await page.getByLabel("Key", { exact: true }).fill("Bearer folder-journey-key");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(page.getByRole("button", { name: "Replace key", exact: true })).toBeVisible();
    await page.getByRole("switch", { name: /Everyone/ }).click();
    await expect(page.getByRole("switch", { name: /Everyone/ })).toBeChecked();
    await page.getByRole("button", { name: "Show tools of crm", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Allow fixture_write", exact: true })).toBeChecked();
    await page.getByRole("switch", { name: "Allow fixture_write", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Allow fixture_write", exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: `Pause ${name}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Resume ${name}`, exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("folder-configured.png") });
    // Stop the browser's old sockets before restarting the same persisted stack.
    await page.goto("about:blank");
    stackCtl.restart("celld");
    const after = (await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.find(p => p.id === plugin.id);
    expect(after).toMatchObject({ enabled: false, setup: [{ server: "crm", done: true }], servers: [{ name: "crm", disabledTools: ["fixture_write"] }] });
    expect((await api.admin.json("GET", "/api/baskule/admin/groups")).groups.find(g => g.id === "everyone").plugins).toContain(plugin.id);
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Replace key", exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: /Everyone/ })).toBeChecked();
    await expect(page.getByRole("button", { name: `Resume ${name}`, exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("folder-after-restart.png") });
    await page.goto("about:blank");
    rmSync(file);
    stackCtl.restart("celld");
    removed = true;
    expect((await api.admin.json("GET", "/api/baskule/admin/plugins")).plugins.some(p => p.id === plugin.id)).toBe(false);
    expect((await api.admin.json("GET", "/api/baskule/admin/groups")).groups.find(g => g.id === "everyone").plugins).not.toContain(plugin.id);
    await page.goto(`${stack.urls.front}/admin/plugins/installed`);
    await expect(page.getByRole("heading", { name: /^Plugins/ })).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("folder-removed.png") });
  } finally {
    await context.close();
    rmSync(file, { force: true });
    if (!removed) stackCtl.restart("celld");
    await mcp.close();
  }
});
