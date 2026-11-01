import { expect, test } from "@playwright/test";
import { computerStatus, newDevice, shot, signInBrowser, startChat, waitAnswer, waitComposer, world } from "./lib";

test("admin health shows the real running computer phase and count", { tag: ["@admin", "@computer"] }, async ({ browser }) => {
  const w = await world();
  const member = await newDevice(browser);
  await signInBrowser(member.page, w.alice);
  await waitComposer(member.page);
  await startChat(member.page, 'Health check [[fake:tool shell {"command":"echo health-ready"}]]', "Personal");
  await waitAnswer(member.page, /Done: shell=health-ready/);
  expect(computerStatus(w.alice.personal).phase).toBe("ready");
  const admin = await newDevice(browser);
  await signInBrowser(admin.page, { ...w.admin, name: "Admin" });
  const response = admin.page.waitForResponse(r => r.url().includes("/api/baskule/admin/spaces?status=live") && r.ok());
  await admin.page.goto("/admin/general/overview");
  const payload = await (await response).json();
  const personal = payload.spaces.find((s: any) => s.id === w.alice.personal);
  expect(personal.status.computer.phase).toBe("ready");
  const running = payload.spaces.filter((s: any) => ["ready", "starting"].includes(s.status?.computer?.phase)).length;
  expect(running).toBeGreaterThan(0);
  const count = admin.page.getByText("Computers running", { exact: true }).locator("..");
  await expect(count).toHaveText(`Computers running${running}`);
  await expect(admin.page.getByText("Computer running", { exact: true }).first()).toBeVisible();
  await shot(admin.page, "16-admin-health", "01-real-computer-state");
  console.log(`admin health: ${running} actual running/starting computers; Alice phase ready`);
  await member.context.close();
  await admin.context.close();
});
