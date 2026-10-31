// (a) The admin signs in (bootstrap account), creates Alice with a temporary password and Bob with an invitation
// link, creates the team space "Acme" and adds both. Alice signs in with the temporary password; Bob accepts the
// invitation. Independent: it uses its own people (`<run>ui`); the other specs use the API-created fixture world.
import { expect, test } from "@playwright/test";

import { adminCreds, metric, names, newDevice, personApi, runId, shot, signInUI, waitShell } from "./lib";

const S = "01-admin-onboarding";

test("(a) admin onboarding: Alice (temporary password), Bob (invitation), team space Acme", { tag: ["@auth", "@admin"] }, async ({ browser }) => {
  const n = names(`${runId()}ui`);
  const admin = await newDevice(browser);
  const t0 = Date.now();
  await signInUI(admin.page, adminCreds());
  await shot(admin.page, S, "01-admin-home");

  // People → Users: Alice with a temporary password.
  await admin.page.goto("/admin/people/users");
  await admin.page.getByRole("button", { name: "Add person" }).click();
  await admin.page.getByRole("radio", { name: "Temporary password" }).or(admin.page.getByRole("button", { name: "Temporary password" })).first().click();
  await admin.page.getByLabel("Name", { exact: true }).fill(n.alice.name);
  await admin.page.getByLabel("Email").fill(n.alice.email);
  await admin.page.getByRole("dialog").getByRole("button", { name: "Add person" }).click();
  await expect(admin.page.getByText("was added")).toBeVisible();
  const temporary = await admin.page.getByLabel("Temporary password", { exact: true }).inputValue();
  expect(temporary.length).toBeGreaterThanOrEqual(8);
  await shot(admin.page, S, "02-alice-added");

  // Bob with an invitation link.
  await admin.page.getByRole("button", { name: "Add another" }).click();
  const invitationTab = admin.page.getByRole("radio", { name: "Invitation link" }).or(admin.page.getByRole("button", { name: "Invitation link" }));
  if (await invitationTab.count()) await invitationTab.first().click();
  await admin.page.getByLabel("Email").fill(n.bob.email);
  await admin.page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  await expect(admin.page.getByText("Invitation ready")).toBeVisible();
  const link = await admin.page.getByLabel("Invitation link", { exact: true }).inputValue();
  expect(link).toMatch(/\/invite#token=/);
  await admin.page.getByRole("button", { name: "Done" }).click();
  await expect(admin.page.getByText(n.alice.email).first()).toBeVisible();
  await shot(admin.page, S, "03-people");
  await admin.page.goto("/admin/people/invitations");
  await expect(admin.page.getByText(n.bob.email).first()).toBeVisible();

  // Bob accepts the invitation (fragment token: never sent to the server).
  const bob = await newDevice(browser);
  await bob.page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(bob.page.getByLabel("Email")).toHaveValue(n.bob.email);
  await bob.page.getByLabel("Your name").fill(n.bob.name);
  await bob.page.getByLabel("Password", { exact: true }).fill(n.bob.password);
  await bob.page.getByLabel("Confirm password").fill(n.bob.password);
  await shot(bob.page, S, "04-bob-invitation");
  await bob.page.getByRole("button", { name: "Create account" }).click();
  await bob.page.waitForURL((u) => u.pathname !== "/invite", { timeout: 30_000 });
  await waitShell(bob.page);
  await expect(bob.page.getByTestId("baskule-user-menu")).toContainText(n.bob.name);
  // The same link cannot be used twice.
  const again = await newDevice(browser);
  await again.page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(again.page.getByText(/Invitation unavailable|no longer valid|already been used/i).first()).toBeVisible();
  await again.context.close();

  // Team space Acme with Alice and Bob.
  await admin.page.goto("/admin/spaces/team");
  await admin.page.getByRole("button", { name: "New team space" }).click();
  await admin.page.getByLabel("Name").fill(n.acme);
  await admin.page.getByRole("button", { name: "Create space" }).click();
  await expect(admin.page.getByRole("dialog").getByText("Members (")).toBeVisible();
  for (const who of [n.alice, n.bob]) {
    await admin.page.getByRole("combobox", { name: "Person to add" }).click();
    await admin.page.getByRole("option", { name: new RegExp(who.name) }).click();
    await admin.page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(admin.page.getByRole("dialog").getByText(who.email)).toBeVisible();
  }
  await shot(admin.page, S, "05-acme-members");
  await admin.page.getByRole("button", { name: "Done" }).click();

  // Alice signs in with the temporary password: Personal + Acme, no Admin entry.
  const alice = await newDevice(browser);
  await signInUI(alice.page, { email: n.alice.email, password: temporary });
  await alice.page.getByTestId("baskule-user-menu").click();
  const items = await alice.page.getByRole("menuitem").allTextContents();
  expect(items.join("|")).not.toMatch(/Admin/);
  await alice.page.keyboard.press("Escape");
  await shot(alice.page, S, "06-alice-signed-in");

  // Alice changes the temporary password; both see Acme through the API.
  const aliceApi = await personApi({ email: n.alice.email, password: temporary });
  const pw = await aliceApi.post("/auth/change-password", { currentPassword: temporary, newPassword: n.alice.password, revokeOtherSessions: false });
  expect(pw.status).toBe(200);
  const am = (await aliceApi.get("/api/baskule/me")).json;
  const bm = (await (await personApi(n.bob)).get("/api/baskule/me")).json;
  const acme = am.spaces.find((s: any) => s.name === n.acme);
  expect(acme, "Alice is a member of Acme").toBeTruthy();
  expect(bm.spaces.map((s: any) => s.id)).toContain(acme.id);
  expect(am.spaces[0].kind).toBe("personal");
  metric(S, { onboardingMs: Date.now() - t0 });
  for (const d of [admin, bob, alice]) await d.context.close();
});
