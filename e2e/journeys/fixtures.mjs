import { test as base, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const test = base.extend({
  // Playwright requires an object fixture parameter even when there are no dependencies.
  // eslint-disable-next-line no-empty-pattern
  stack: [async ({}, use, info) => {
    const profiles = new Set(info.tags.filter((t) => t.startsWith("@profile:")).map((t) => t.slice(9)));
    if (profiles.size > 1) throw new Error("A journey must select exactly one stack profile");
    const profile = [...profiles][0] ?? process.env.JOURNEY_PROFILE ?? "full";
    execFileSync(`${root}scripts/stack`, ["up", "--profile", profile], { stdio: "inherit", timeout: 600_000 });
    await use(JSON.parse(readFileSync(`${root}.run/stack/stack.json`, "utf8")));
  }, { timeout: 660_000 }],
  api: async ({ stack }, use) => {
    const api = createApi(stack);
    await use({ ...api, admin: await api.adminSession() });
  },
  people: async ({ api, browser }, use) => {
    const run = randomUUID();
    const alice = await api.person("Alice", run);
    const bob = await api.person("Bob", run);
    const team = await api.teamSpace(api.admin, `Team ${run}`, [alice, bob]);
    try { await use({ alice, bob, team, teamName: `Team ${run}` }); }
    finally {
      const closed = await Promise.allSettled(browser.contexts().map((context) => context.close()));
      const results = [];
      for (const id of [team, api.personalSpace(alice), api.personalSpace(bob)]) {
        try { results.push({ status: "fulfilled", value: await api.admin.json("POST", `/api/baskule/admin/spaces/${id}/stop`, {}) }); }
        catch (reason) { results.push({ status: "rejected", reason }); }
      }
      const failed = [...closed, ...results].filter((result) => result.status === "rejected");
      expect(failed, "Journey world cleanup failed").toEqual([]);
    }
  },
  fakeLlm: async ({ stack }, use) => {
    const url = `http://127.0.0.1:${stack.ports["fake-llm"]}`;
    await use({ requests: async () => (await fetch(`${url}/_fake/requests`)).json(), reset: async () => { await fetch(`${url}/_fake/reset`, { method: "POST" }); } });
  },
  stackCtl: async ({ stack }, use) => {
    await use({ restart: (service) => {
      if (!["celld", "computerd"].includes(service) || !stack.definition.services[service]) throw new Error(`Unavailable service: ${service}`);
      execFileSync(`${root}scripts/stack`, ["restart", service], { stdio: "inherit" });
    } });
  },
});
export { expect };
export const phoneOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true };

export async function signIn(page, person, stack) {
  await page.context().addCookies(person.cookie.split("; ").map((part) => {
    const i = part.indexOf("=");
    return { name: part.slice(0, i), value: part.slice(i + 1), url: stack.urls.front };
  }));
  await navigateApp(page, () => page.goto(stack.urls.front));
}

export async function navigateApp(page, navigate) {
  let networkChanged = false;
  const failed = (request) => { if (request.failure()?.errorText === "net::ERR_NETWORK_CHANGED") networkChanged = true; };
  page.on("requestfailed", failed);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await navigate(); }
      catch (error) {
        if (!networkChanged || attempt > 0 || !String(error).includes("net::ERR_NETWORK_CHANGED")) throw error;
        console.warn("Navigation hit ERR_NETWORK_CHANGED; repeating this navigation once");
        networkChanged = false;
        continue;
      }
      const ready = composer(page).or(page.getByRole("button", { name: "Expand composer", exact: true }));
      const loadError = page.getByRole("alert").filter({ hasText: "Baskule could not load" });
      await expect(ready.or(loadError).filter({ visible: true }).first()).toBeVisible({ timeout: 90_000 });
      if (!await loadError.isVisible() || !networkChanged || attempt > 0) break;
      // Shared-host interface changes can abort Chromium's bootstrap assets; retry only the navigation.
      console.warn("Bootstrap assets hit ERR_NETWORK_CHANGED; repeating this navigation once");
      networkChanged = false;
    }
    await expect(composer(page).or(page.getByRole("button", { name: "Expand composer", exact: true })).filter({ visible: true }).first()).toBeVisible();
  } finally { page.off("requestfailed", failed); }
}
export const composer = (page) => page.locator('[contenteditable="true"]').first();
export async function closeSidebar(page) {
  const drawer = page.getByRole("dialog", { name: "Threads", exact: true });
  if (await drawer.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  }
}
export async function openComposer(page) {
  await closeSidebar(page);
  const compact = page.getByRole("button", { name: "Expand composer", exact: true });
  await expect(composer(page).or(compact).filter({ visible: true }).first()).toBeVisible();
  if (!await composer(page).isVisible()) await compact.click();
  await expect(composer(page)).toBeVisible();
}
export const assistant = (page) => page.locator('[data-message-role="assistant"]').last();
export const row = (page, id) => page.locator(`[data-thread-id="${id}"]`);
export async function sidebar(page) {
  const toggle = page.getByRole("button", { name: "Toggle main sidebar", includeHidden: true }).first();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("baskule-new-chat")).toBeVisible();
  await expect(page.getByTestId("baskule-new-chat")).toBeInViewport({ ratio: 1 });
}
export async function sendMessage(page, text) {
  await openComposer(page);
  await composer(page).fill(text);
  await expect(page.getByRole("button", { name: /^(Submit message|Queue message)$/ })).toBeEnabled();
  await composer(page).press("Enter");
  await expect(page.locator('[data-message-role="user"]').filter({ hasText: text.replaceAll("`", "").slice(0, 24) }).last()).toBeVisible();
}
export async function startChat(page, text, space = "Personal") {
  await sidebar(page);
  const previous = page.url();
  const emptyDraft = /^\/draft\/[^/]+$/.test(new URL(previous).pathname) && (await composer(page).innerText()).trim() === "";
  if (!emptyDraft) {
    await page.getByTestId("baskule-new-chat").click();
    await expect(page).toHaveURL((url) => url.href !== previous && /^\/draft\/[^/]+$/.test(url.pathname));
  }
  await closeSidebar(page);
  const picker = page.getByRole("combobox", { name: "Run on", exact: true });
  await expect(picker).toBeVisible();
  if ((await picker.innerText()).trim() !== space) {
    await picker.click();
    await page.getByRole("option", { name: space, exact: true }).click();
  }
  await sendMessage(page, text);
  await expect(page).toHaveURL((url) => /^\/[^/]+\/[^/]+$/.test(url.pathname) && !url.pathname.startsWith("/draft/"));
  const id = new URL(page.url()).pathname.split("/").at(-1);
  await openComposer(page);
  return id;
}
export async function openMenu(page, id) {
  await sidebar(page);
  if (page.viewportSize().width >= 600) await row(page, id).hover();
  await row(page, id).getByTestId("baskule-chat-menu-button").click();
}
export async function menu(page, id, name) {
  await openMenu(page, id);
  await page.getByRole("button", { name, exact: true }).or(page.getByRole("menuitem", { name, exact: true })).last().click();
}
