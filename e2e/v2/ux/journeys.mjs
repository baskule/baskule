#!/usr/bin/env node
// Scripted UX journeys for the reviewer sub-agent (see BRIEF.md). Each step saves <n>-<name>.png (screenshot),
// <n>-<name>.txt (visible text + accessibility snapshot) in e2e/v2/artifacts/ux/<journey>/. A failing step is
// recorded (<n>-<name>.error.txt) and the journey goes on where it can: the reviewer sees what a user would.
//   node e2e/v2/ux/journeys.mjs [journey...]      env: E2E_BASE_URL, UX_RUN, E2E_CHROME
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const { chromium } = await import(path.join(ROOT, "e2e/node_modules/playwright/index.mjs"));
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:47090";
const RUN = process.env.UX_RUN ?? `ux${Date.now().toString(36).slice(-5)}`;
const OUT = path.join(ROOT, "e2e/v2/artifacts/ux");
const env = readFileSync(path.join(ROOT, "deploy/v2/.env"), "utf8");
const envGet = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) ?? [])[1] ?? "";
const ADMIN = { email: envGet("ADMIN_EMAIL") || "admin@baskule.local", password: envGet("ADMIN_PASSWORD") };
const P = {
  carol: { name: "Carol Martin", email: `carol-${RUN}@example.test`, password: `carol-${RUN}-password` },
  dan: { name: "Dan Lefebvre", email: `dan-${RUN}@example.test`, password: `dan-${RUN}-password` },
  team: `Marketing ${RUN}`,
};
const state = {};

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/usr/bin/google-chrome" });
const log = [];

function journey(name) {
  const dir = path.join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return async function step(page, label, fn) {
    n++;
    const base = path.join(dir, `${String(n).padStart(2, "0")}-${label}`);
    try {
      if (fn) await fn();
    } catch (e) {
      writeFileSync(`${base}.error.txt`, String(e?.stack ?? e));
      log.push(`${name}/${label}: ERROR ${String(e?.message ?? e).split("\n")[0]}`);
    }
    try {
      await page.screenshot({ path: `${base}.png`, animations: "disabled" });
      const text = await page.evaluate(() => document.body.innerText);
      const aria = await page.locator("body").ariaSnapshot().catch(() => "");
      writeFileSync(`${base}.txt`, `RUN: ${RUN}\nCAPTURED: ${new Date().toISOString()}\nURL: ${page.url()}\nVIEWPORT: ${JSON.stringify(page.viewportSize())}\n\n--- visible text ---\n${text}\n\n--- accessibility ---\n${aria}\n`);
    } catch (e) {
      log.push(`${name}/${label}: capture failed ${e}`);
    }
  };
}

async function device(kind = "desktop") {
  const ctx = await browser.newContext(
    kind === "phone"
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, baseURL: BASE, acceptDownloads: true }
      : { viewport: { width: 1440, height: 900 }, baseURL: BASE, acceptDownloads: true },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);
  return { ctx, page };
}

async function signIn(page, who) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  for (let i = 0; i < 8; i++) {
    await page.getByRole("button", { name: "Sign in" }).click();
    if (await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 12_000 }).then(() => true, () => false)) break;
    await page.waitForTimeout(10_000); // no-fixed-sleep-allow: Back off between bounded sign-in attempts after rate limiting.
  }
  await page.locator('[contenteditable="true"], [data-testid="baskule-user-menu"]').first().waitFor({ timeout: 90_000 });
}
const composer = (page) => page.locator('[contenteditable="true"]').first();
async function send(page, text) {
  await composer(page).click();
  await composer(page).fill(text);
  await page.keyboard.press("Enter");
}
async function openNewChat(page) {
  const previous = page.url();
  // The app legitimately reuses an empty draft; do not queue another async scratch-project lookup.
  const empty = /^\/draft\/[^/]+$/.test(new URL(previous).pathname) && (await composer(page).innerText()).trim() === "";
  if (!empty) {
    await page.getByTestId("baskule-new-chat").click();
    await page.waitForURL((url) => url.href !== previous && /^\/draft\/[^/]+$/.test(url.pathname), { timeout: 90_000 });
  }
  await composer(page).waitFor({ state: "visible" });
}
async function pickSpace(page, name) {
  await page.getByRole("combobox", { name: "Run on", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

const journeys = {
  async "admin-onboarding"() {
    const step = journey("admin-onboarding");
    const { ctx, page } = await device();
    await step(page, "login-page", () => page.goto("/"));
    await step(page, "signed-in-home", () => signIn(page, ADMIN));
    await step(page, "user-menu", () => page.getByTestId("baskule-user-menu").click());
    await page.keyboard.press("Escape");
    await step(page, "admin-people", () => page.goto("/admin/people/users"));
    await step(page, "add-person-dialog", () => page.getByRole("button", { name: "Add person" }).click());
    await step(page, "temporary-password-filled", async () => {
      await page.getByRole("radio", { name: "Temporary password" }).or(page.getByRole("button", { name: "Temporary password" })).first().click();
      await page.getByLabel("Name", { exact: true }).fill(P.carol.name);
      await page.getByLabel("Email").fill(P.carol.email);
    });
    await step(page, "person-added", async () => {
      await page.getByRole("dialog").getByRole("button", { name: "Add person" }).click();
      await page.getByText("was added").waitFor();
      state.carolTemp = await page.getByLabel("Temporary password", { exact: true }).inputValue();
    });
    await step(page, "invitation-created", async () => {
      await page.getByRole("button", { name: "Add another" }).click();
      const tab = page.getByRole("radio", { name: "Invitation link" }).or(page.getByRole("button", { name: "Invitation link" }));
      if (await tab.count()) await tab.first().click();
      await page.getByLabel("Email").fill(P.dan.email);
      await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
      await page.getByText("Invitation ready").waitFor();
      state.danLink = await page.getByLabel("Invitation link", { exact: true }).inputValue();
    });
    await step(page, "people-list", () => page.getByRole("button", { name: "Done" }).click());
    await step(page, "admin-invitations", () => page.getByRole("link", { name: "Invitations" }).click());
    await step(page, "spaces-tab", () => page.getByRole("link", { name: "Team spaces" }).click());
    await step(page, "new-team-space", async () => {
      await page.getByRole("button", { name: "New team space" }).click();
      await page.getByLabel("Name").fill(P.team);
      await page.getByRole("button", { name: "Create space" }).click();
      await page.getByRole("dialog").getByText("Members (").waitFor();
    });
    await step(page, "member-added", async () => {
      await page.getByRole("combobox", { name: "Person to add" }).click();
      await page.getByRole("option").filter({ hasText: P.carol.email }).click();
      await page.getByRole("button", { name: "Add", exact: true }).click();
    });
    await step(page, "spaces-after", () => page.getByRole("button", { name: "Done" }).click());
    await step(page, "health-tab", async () => {
      await page.getByRole("link", { name: "Overview" }).click();
      await page.getByText("Spaces awake", { exact: true }).waitFor();
    });
    await ctx.close();
  },

  async "member-first-chat"() {
    const step = journey("member-first-chat");
    const { ctx, page } = await device();
    await step(page, "invitation-page", () => page.goto(state.danLink.replace(/^https?:\/\/[^/]+/, "")));
    await step(page, "invitation-filled", async () => {
      await page.getByLabel("Your name").fill(P.dan.name);
      await page.getByLabel("Password", { exact: true }).fill(P.dan.password);
      await page.getByLabel("Confirm password").fill(P.dan.password);
    });
    await step(page, "first-landing", async () => {
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL((u) => u.pathname !== "/invite");
      await composer(page).waitFor({ timeout: 90_000 });
    });
    await step(page, "available-spaces", async () => {
      const picker = page.getByRole("combobox", { name: "Run on", exact: true });
      // A new invitee with only Personal has no redundant space selector.
      if (await picker.count()) await picker.click();
    });
    await page.keyboard.press("Escape");
    await step(page, "first-question-sent", () => send(page, "What should I prepare for my first week? [[fake:text Here is a short checklist for your first week: meet your team, read the handbook, set up your accounts.]]"));
    await step(page, "first-answer", () => page.getByText("Here is a short checklist").last().waitFor({ timeout: 90_000 }));
    await step(page, "user-menu", () => page.getByTestId("baskule-user-menu").click());
    await page.keyboard.press("Escape");
    await step(page, "desktop-app-settings", () => page.goto("/settings/desktop"));
    await ctx.close();
    // Carol: first sign-in with the temporary password.
    const c = await device();
    await step(c.page, "carol-temporary-password-signin", () => signIn(c.page, { email: P.carol.email, password: state.carolTemp }));
    await c.ctx.close();
  },

  async "team-collaboration"() {
    const step = journey("team-collaboration");
    const carol = await device();
    const admin = await device();
    await signIn(carol.page, { email: P.carol.email, password: state.carolTemp });
    await signIn(admin.page, ADMIN);
    await step(carol.page, "carol-new-chat-in-team", async () => {
      await openNewChat(carol.page);
      await pickSpace(carol.page, P.team);
    });
    await step(carol.page, "carol-long-run", async () => {
      await send(carol.page, "Draft our launch announcement [[fake:long 300]] [[fake:delay 40]]");
      await carol.page.locator('[data-message-role="assistant"]').last().waitFor();
    });
    await step(admin.page, "admin-sees-team-chat", async () => {
      await admin.page.getByRole("button", { name: /Draft our launch/ }).first().click();
      await admin.page.locator('[data-message-role="assistant"]').last().waitFor();
    });
    await step(admin.page, "admin-queues-message", () => send(admin.page, "Please add a short French version [[fake:text Version française ajoutée.]]"));
    await step(carol.page, "carol-sees-queue", () => carol.page.getByText(/Please add a short French version/).first().waitFor());
    await step(carol.page, "both-answered", () => carol.page.getByText("Version française ajoutée.").last().waitFor({ timeout: 120_000 }));
    await step(admin.page, "admin-final", () => admin.page.getByText("Version française ajoutée.").last().waitFor());
    await carol.ctx.close();
    await admin.ctx.close();
  },

  async "file-round-trip"() {
    const step = journey("file-round-trip");
    const { ctx, page } = await device();
    await signIn(page, { email: P.dan.email, password: P.dan.password });
    await step(page, "new-chat", () => openNewChat(page));
    await step(page, "file-attached", async () => {
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach files" }).click()]);
      await chooser.setFiles({ name: "budget.csv", mimeType: "text/csv", buffer: Buffer.from("item,amount\nads,1200\nevents,800\n") });
    });
    await step(page, "task-running", async () => {
      await composer(page).click();
      await page.keyboard.press("End");
      await page.keyboard.insertText('Summarise the budget into a report [[fake:tool shell {"command":"printf \'# Budget\\n\\nTotal: 2000\\n\' > report.md && echo written report.md"}]]');
      await page.keyboard.press("Enter");
      await page.locator('[data-message-role="user"]').last().waitFor();
    });
    await step(page, "task-done", () => page.getByText(/Done: shell=/).last().waitFor({ timeout: 180_000 }));
    await step(page, "files-panel", async () => {
      await page.getByRole("button", { name: "Toggle right panel" }).click();
      await page.getByRole("treeitem", { name: "report.md" }).waitFor({ timeout: 60_000 });
    });
    await step(page, "file-preview", () => page.getByRole("treeitem", { name: "report.md" }).click());
    await step(page, "downloaded", async () => {
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download file" }).click()]);
      await dl.path();
    });
    await ctx.close();
  },

  async "schedule-setup"() {
    const step = journey("schedule-setup");
    const { ctx, page } = await device();
    await signIn(page, { email: P.dan.email, password: P.dan.password });
    await step(page, "scheduled-tasks-page", async () => {
      await page.getByTestId("baskule-user-menu").click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    });
    await step(page, "new-schedule", async () => {
      const b = page.getByRole("button", { name: /new|add|create/i }).first();
      await b.click();
    });
    await step(page, "schedule-form-filled", async () => {
      const box = page.getByRole("textbox").first();
      await box.fill("Every Monday, summarise last week's news about our market");
    });
    await ctx.close();
  },

  async "phone-layout"() {
    const step = journey("phone-layout");
    const { ctx, page } = await device("phone");
    await step(page, "login", async () => {
      await page.goto("/login");
      await page.getByLabel("Email").waitFor();
      await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    });
    await step(page, "home", () => signIn(page, { email: P.dan.email, password: P.dan.password }));
    await step(page, "drawer", () => page.getByRole("button", { name: "Toggle main sidebar" }).first().click());
    await step(page, "chat-open", async () => {
      await page.getByRole("button", { name: /first week|budget|report/i }).first().click();
      await page.locator('[contenteditable="true"]').first().waitFor();
    });
    await step(page, "composer-typing", async () => {
      const expand = page.getByRole("button", { name: "Expand composer", exact: true });
      if (await expand.isVisible()) await expand.click();
      await composer(page).fill("A question from my phone");
    });
    await step(page, "files-panel", () => page.getByRole("button", { name: "Toggle right panel" }).click());
    await ctx.close();
    const adm = await device("phone");
    await signIn(adm.page, ADMIN);
    await step(adm.page, "admin-home", () => adm.page.goto("/admin"));
    await step(adm.page, "admin-health", () => adm.page.getByRole("link", { name: /^Overview/ }).click());
    await adm.ctx.close();
  },
};

const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(journeys)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const t0 = Date.now();
  try {
    await fn();
    log.push(`${name}: done in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (e) {
    log.push(`${name}: ABORTED ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
await browser.close();
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "journeys.log"), `run: ${RUN}\ncompleted: ${new Date().toISOString()}\n` + log.join("\n") + "\n");
writeFileSync(path.join(OUT, "people.json"), JSON.stringify({ run: RUN, carol: P.carol.email, dan: P.dan.email, team: P.team }, null, 2));
console.log(log.join("\n"));
console.log(`artifacts: ${OUT}`);
