// (l) Phone viewport (390x844): sign-in page, drawer with spaces and chats, a chat, files, admin; nothing overflows
// horizontally and the main controls are reachable.
import { expect, test, type Page } from "@playwright/test";

import { adminCreds, ensureSidebar, newDevice, shot, signInUI, startChat, toggleFiles, waitAnswer, waitComposer, world } from "./lib";

const S = "12-phone";

async function noHorizontalOverflow(page: Page, what: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${what}: page wider than the screen`).toBeLessThanOrEqual(iw + 1);
}

test("(l) phone layout: sign-in, drawer, chat, files, admin", { tag: ["@ui", "@phone"] }, async ({ browser }) => {
  const w = await world();
  const p = await newDevice(browser, "phone");
  await p.page.goto("/");
  await expect(p.page).toHaveURL(/\/login/);
  await expect(p.page.getByLabel("Email")).toBeVisible();
  await expect(p.page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await shot(p.page, S, "01-login");
  await noHorizontalOverflow(p.page, "login");
  await signInUI(p.page, w.alice);
  await waitComposer(p.page);
  await shot(p.page, S, "02-home");
  await noHorizontalOverflow(p.page, "home");
  await ensureSidebar(p.page);
  await expect(p.page.getByTestId("baskule-user-menu")).toBeVisible();
  await shot(p.page, S, "03-drawer");
  await p.page.keyboard.press("Escape");
  await expect(p.page.getByTestId("baskule-new-chat")).toBeHidden();
  await startChat(p.page, `Phone check [[fake:tool shell {"command":"echo phone > phone.txt && echo ok"}]]`, "Personal");
  await waitAnswer(p.page, /Done: shell=ok/, 180_000);
  await shot(p.page, S, "04-chat");
  await noHorizontalOverflow(p.page, "chat");
  await toggleFiles(p.page, true);
  await expect(p.page.getByRole("treeitem", { name: "phone.txt" })).toBeVisible({ timeout: 60_000 });
  await shot(p.page, S, "05-files");
  await p.context.close();

  const adm = await newDevice(browser, "phone");
  await signInUI(adm.page, adminCreds());
  await adm.page.goto("/admin");
  await adm.page.getByRole("link", { name: /^Users/ }).click();
  await expect(adm.page.getByRole("button", { name: "Add person" })).toBeVisible();
  await shot(adm.page, S, "06-admin");
  await noHorizontalOverflow(adm.page, "admin");
  await adm.context.close();
});
