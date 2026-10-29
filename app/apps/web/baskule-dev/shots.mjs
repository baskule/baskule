// baskule: page checks + screenshots of the Baskule views against the mock front (up.sh).
// Desktop 1440x900 and phone 390x844. Writes PNGs to .run/wp-e/artifacts/ (or SHOTS_DIR),
// fails on a broken check, and prints console errors from the page.
//   node apps/web/baskule-dev/shots.mjs            all scenarios
//   node apps/web/baskule-dev/shots.mjs login admin  some of them
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { chromium } from "playwright";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const BASE = process.env.MOCK_URL ?? "http://127.0.0.1:47700";
const OUT = NodePath.resolve(
  process.env.SHOTS_DIR ?? NodePath.join(HERE, "../../../../.run/wp-e/artifacts"),
);
NodeFS.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  },
};
const ACCOUNTS = {
  admin: ["admin@baskule.test", "baskule-admin"],
  alice: ["alice@baskule.test", "baskule-alice"],
  bob: ["bob@baskule.test", "baskule-bob"],
};

const failures = [];
const check = (condition, message) => {
  if (!condition) {
    failures.push(message);
    console.error(`  FAIL ${message}`);
  } else console.log(`  ok   ${message}`);
};

async function newPage(browser, device) {
  const context = await browser.newContext({ ...VIEWPORTS[device], baseURL: BASE });
  const page = await context.newPage();
  // The shared host boots a T3 server per space on first use (about 5 CPU-s each).
  page.setDefaultTimeout(90_000);
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|Failed to load resource/.test(message.text())) {
      console.log(`  [console:${device}] ${message.text().slice(0, 300)}`);
    }
  });
  page.on("pageerror", (error) =>
    console.log(`  [pageerror:${device}] ${error.message.slice(0, 300)}`),
  );
  let failedModules = 0;
  page.on("response", (response) => {
    if (response.request().resourceType() !== "script" || failedModules >= 5) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (response.ok() && /(?:java|ecma)script|wasm/i.test(contentType)) return;
    failedModules++;
    const url = new URL(response.url());
    console.log(`  [module:${device}] ${url.origin}${url.pathname.slice(0, 300)} status=${response.status()} content-type=${contentType.slice(0, 100)}`);
  });
  return { context, page };
}

async function signIn(page, who) {
  const [email, password] = ACCOUNTS[who];
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  // Navigating while the signed-in app still loads its modules aborts them.
  // The phone drawer mounts the user menu only when opened: wait for the app shell instead.
  await page
    .locator('[data-sidebar-control], [data-testid="baskule-user-menu"]')
    .first()
    .waitFor({ state: "attached", timeout: 60_000 });
}

const shot = async (page, name) => {
  const file = NodePath.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot ${NodePath.relative(process.cwd(), file)}`);
};

/** The prompt editor, expanded first where a phone shows it collapsed. */
async function openComposer(page) {
  const composer = page.locator('[contenteditable="true"]').first();
  const expand = page.getByRole("button", { name: "Expand composer" });
  await Promise.race([composer.waitFor(), expand.waitFor()]);
  if (await expand.isVisible()) await expand.click();
  await composer.click();
  return composer;
}

async function openSidebarOnPhone(page, device) {
  if (device !== "phone") return;
  await page.getByRole("button", { name: "Toggle main sidebar" }).first().click();
  await page.waitForTimeout(400);
}

const scenarios = {
  async settings(browser, device) {
    const { context, page } = await newPage(browser, device);
    try {
      await signIn(page, "admin");
      await page.goto("/admin/general/organization");
      await page.getByLabel("Organization name", { exact: true }).waitFor();
      await shot(page, `${device}-admin-organization`);
      await page.getByLabel("Organization name", { exact: true }).fill(`Settings test ${device}`);
      await page.getByRole("button", { name: "Save settings", exact: true }).click();
      await page.getByText("Organization settings saved", { exact: true }).waitFor();
      await page.goto("/admin/ai/models");
      await page.getByLabel("API key", { exact: true }).waitFor();
      await shot(page, `${device}-admin-models`);
      await page.getByLabel("Provider", { exact: true }).click();
      await page.getByRole("option", { name: "Custom", exact: true }).click();
      await page.getByLabel("API endpoint", { exact: true }).fill("https://custom.example.test/v1");
      await page.getByLabel("API key", { exact: true }).fill("mock-settings-key");
      await page.getByLabel("Model", { exact: true }).fill(`model-${device}`);
      await page.getByLabel("Display name", { exact: true }).fill("Custom model");
      // Saving waits for the connection check of the endpoint, key and model.
      await page.getByText("Connection works", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Save settings", exact: true }).click();
      await page.getByText("AI settings saved", { exact: true }).waitFor();
      const saved = await (await page.request.get("/api/baskule/admin/settings")).json();
      check(
        saved.organizationName === `Settings test ${device}` &&
          saved.ai.providerId === "custom" &&
          saved.ai.model.id === `model-${device}` &&
          saved.ai.model.pdf,
        `${device}: admin saves the organization and the model on their own pages`,
      );
      check(
        saved.apiKeyConfigured === true && !JSON.stringify(saved).includes("mock-settings-key"),
        `${device}: saved key stays private`,
      );
      await page.goto("/admin/general/organization");
      await page.getByLabel("Organization name", { exact: true }).waitFor();
      check(
        (await page.getByLabel("Organization name", { exact: true }).inputValue()) ===
          `Settings test ${device}`,
        `${device}: settings survive reload`,
      );
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${device}: settings fit the viewport`,
      );
    } finally {
      await context.close();
    }
  },
  /**
   * Against WP-C's real ControlCell (mock front in MOCK_CONTROL mode): admin onboarding.
   * Needs PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD; skipped otherwise.
   */
  async platform(browser, device) {
    const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;
    const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword || device !== "desktop") return;
    const stamp = Date.now().toString(36);
    const { context, page } = await newPage(browser, device);
    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    await page.getByTestId("baskule-user-menu").waitFor({ timeout: 60_000 });
    check(true, "platform: admin signs in through Better Auth");
    await page.goto("/admin/people/users");
    await page.getByRole("button", { name: "Add person" }).click();
    await page
      .getByRole("radio", { name: "Temporary password" })
      .or(page.getByRole("button", { name: "Temporary password" }))
      .first()
      .click();
    await page.getByLabel("Name", { exact: true }).fill(`Alice ${stamp}`);
    await page.getByLabel("Email").fill(`alice-${stamp}@baskule.test`);
    await page.getByRole("dialog").getByRole("button", { name: "Add person" }).click();
    await page.getByText("was added").waitFor();
    const temporary = await page.getByLabel("Temporary password", { exact: true }).inputValue();
    check(temporary.length >= 8, "platform: person created with a temporary password");
    await page.getByRole("button", { name: "Add another" }).click();
    await page.getByLabel("Email").fill(`bob-${stamp}@baskule.test`);
    await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
    await page.getByText("Invitation ready").waitFor();
    const link = await page.getByLabel("Invitation link", { exact: true }).inputValue();
    check(/\/invite#token=/.test(link), "platform: invitation link with a fragment token");
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByText(`alice-${stamp}@baskule.test`).first().waitFor();
    await shot(page, "platform-admin-people");
    await page.getByRole("link", { name: "Invitations" }).click();
    await page.getByText(`bob-${stamp}@baskule.test`).first().waitFor();
    // Team space with Alice.
    await page.getByRole("link", { name: "Team spaces" }).click();
    await page.getByRole("button", { name: "New team space" }).click();
    await page.getByLabel("Name").fill(`Acme ${stamp}`);
    await page.getByRole("button", { name: "Create space" }).click();
    await page.getByRole("dialog").getByText("Members (").waitFor();
    await page.getByRole("combobox", { name: "Person to add" }).click();
    await page.getByRole("option", { name: new RegExp(`Alice ${stamp}`) }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("dialog").getByText(`alice-${stamp}@baskule.test`).waitFor();
    check(true, "platform: team space created and member added");
    await shot(page, "platform-space-dialog");
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("link", { name: "Overview" }).click();
    await page.getByText("Spaces awake").waitFor();
    await page.waitForTimeout(4000);
    await shot(page, "platform-admin-overview");
    await context.close();
    // The invited person accepts.
    const invited = await newPage(browser, device);
    await invited.page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await invited.page.getByLabel("Your name").fill(`Bob ${stamp}`);
    await invited.page.getByLabel("Password", { exact: true }).fill("bob-password-1");
    await invited.page.getByLabel("Confirm password").fill("bob-password-1");
    await invited.page.getByRole("button", { name: "Create account" }).click();
    await invited.page.waitForURL((url) => url.pathname !== "/invite", { timeout: 20_000 });
    await invited.page.getByTestId("baskule-user-menu").waitFor({ timeout: 30_000 });
    check(
      (await invited.page.getByTestId("baskule-user-menu").textContent())?.includes(
        `Bob ${stamp}`,
      ),
      "platform: invitation accepted and signed in",
    );
    await invited.context.close();
    // Alice signs in with the temporary password.
    const alice = await newPage(browser, device);
    await alice.page.goto("/login");
    await alice.page.getByLabel("Email").fill(`alice-${stamp}@baskule.test`);
    await alice.page.getByLabel("Password").fill(temporary);
    await alice.page.getByRole("button", { name: "Sign in" }).click();
    await alice.page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    await alice.page.getByTestId("baskule-user-menu").click();
    const items = await alice.page.getByRole("menuitem").allTextContents();
    check(!items.some((item) => item.includes("Admin")), "platform: a member has no Admin entry");
    await shot(alice.page, "platform-member-menu");
    await alice.context.close();
  },

  async login(browser, device) {
    const { context, page } = await newPage(browser, device);
    await page.goto("/");
    await page.waitForURL(/\/login/);
    check(page.url().includes("/login"), `${device}: signed-out visit redirects to /login`);
    await shot(page, `${device}-login`);
    await page.getByLabel("Email").fill("alice@baskule.test");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    check(
      (await alert.textContent())?.includes("don't match"),
      `${device}: wrong password shows an error`,
    );
    await shot(page, `${device}-login-error`);
    await context.close();
  },

  async invite(browser, device) {
    const { context, page } = await newPage(browser, device);
    await page.goto("/invite#token=demo-invitation-token-0123456789");
    await page.getByLabel("Your name").waitFor();
    check(
      (await page.getByLabel("Email").inputValue()) === "erin@baskule.test",
      `${device}: invitation shows the invited email`,
    );
    check((await page.getByText("to Acme").count()) > 0, `${device}: invitation names the spaces`);
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await shot(page, `${device}-invite-errors`);
    await page.goto("/invite#token=not-a-valid-token-at-all-000");
    await page.getByText("Invitation unavailable").waitFor();
    await shot(page, `${device}-invite-invalid`);
    await context.close();
  },

  /** Voice input with Chrome's fake microphone: AI → Voice input, then record, stop, cancel and send. */
  async voice(browser, device) {
    const { context, page } = await newPage(browser, device);
    try {
      await context.grantPermissions(["microphone"]);
      await signIn(page, "admin");
      // Voice input is on, but without a key nobody can use it.
      const { organizationName, idleMinutes, ai, transcription } = await (
        await page.request.get("/api/baskule/admin/settings")
      ).json();
      await page.request.patch("/api/baskule/admin/settings", {
        data: { organizationName, idleMinutes, ai, transcription, transcriptionApiKey: "" },
      });
      await page.goto("/");
      await openComposer(page);
      check(
        (await page.getByRole("button", { name: "Start voice input" }).count()) === 0,
        `${device}: no microphone while no transcription key is saved`,
      );

      await page.goto("/admin/ai/voice");
      await page.getByText("Dictate messages", { exact: true }).waitFor();
      await page.getByLabel("API key", { exact: true }).fill("mock-voice-key");
      await page.getByRole("button", { name: "Save settings", exact: true }).click();
      await page.getByText("Voice input settings saved", { exact: true }).first().waitFor();
      await shot(page, `${device}-admin-voice-input`);
      const saved = await (await page.request.get("/api/baskule/admin/settings")).json();
      check(
        saved.transcriptionApiKeyConfigured === true &&
          saved.transcription.model === "gpt-transcribe" &&
          !JSON.stringify(saved).includes("mock-voice-key"),
        `${device}: admin saves the transcription key, which stays private`,
      );
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${device}: voice input settings fit the viewport`,
      );

      const uploads = async () =>
        (await (await page.request.get("/api/baskule/__mock/transcriptions")).json()).uploads;
      await page.goto("/");
      const composer = await openComposer(page);
      await composer.pressSequentially("Hello", { delay: 5 });
      const start = page.getByRole("button", { name: "Start voice input" });
      const stop = page.getByRole("button", { name: "Stop and insert" });
      await start.click();
      await page.getByRole("timer").filter({ hasText: "0:01" }).waitFor();
      await shot(page, `${device}-composer-recording`);
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${device}: the recording controls fit the composer`,
      );
      const before = (await uploads()).length;
      await stop.click();
      await page
        .locator('[contenteditable="true"]', { hasText: "Hello dictated words" })
        .first()
        .waitFor();
      await start.waitFor();
      const recorded = await uploads();
      check(
        (await composer.innerText()).trim() === "Hello dictated words" &&
          recorded.length === before + 1 &&
          /^audio\//.test(recorded.at(-1)?.type ?? "") &&
          recorded.at(-1).bytes > 0,
        `${device}: stop uploads the recording and appends the transcript (${recorded.at(-1)?.type})`,
      );
      await shot(page, `${device}-composer-transcribed`);

      await start.click();
      await page.getByRole("timer").waitFor();
      await page.keyboard.press("Escape");
      await start.waitFor();
      check(
        (await uploads()).length === before + 1 &&
          (await composer.innerText()).trim() === "Hello dictated words",
        `${device}: cancel discards the recording and keeps the prompt`,
      );

      await composer.focus();
      await start.click();
      await stop.waitFor();
      await page.keyboard.press("Escape");
      await start.waitFor();
      check(
        (await uploads()).length === before + 1 &&
          (await composer.innerText()).trim() === "Hello dictated words",
        `${device}: Escape in the message box discards the recording`,
      );

      await start.click();
      await page.getByRole("timer").filter({ hasText: "0:01" }).waitFor();
      await page.getByRole("button", { name: "Submit message" }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/draft") && url.pathname !== "/", {
        timeout: 60_000,
      });
      await page
        .getByText("Hello dictated words dictated words", { exact: true })
        .first()
        .waitFor({ timeout: 60_000 });
      check(
        (await uploads()).length === before + 2,
        `${device}: send while recording sends the prompt with the transcript`,
      );
      await shot(page, `${device}-composer-sent`);
    } finally {
      await context.close();
    }
  },

  async admin(browser, device) {
    const { context, page } = await newPage(browser, device);
    await signIn(page, "admin");
    await page.goto("/admin");
    // The admin pop-up opens on its first page; its nav (an icon rail on phones) lists the others.
    await page.waitForURL(/\/admin\/general\/overview$/);
    check(true, `${device}: /admin opens General → Overview`);
    await shot(page, `${device}-admin-home`);
    await page
      .getByRole("navigation", { name: "Admin", exact: true })
      .getByRole("link", { name: "Users" })
      .click();
    await page.waitForURL(/\/admin\/people\/users$/);
    await page.getByRole("button", { name: "Options for Carol Petit" }).waitFor();
    check(
      (await page.getByRole("button", { name: "Options for Ada Admin" }).count()) > 0,
      `${device}: admin lists people`,
    );
    await shot(page, `${device}-admin-users`);
    await page.getByRole("button", { name: "Options for Bob Durand" }).click();
    await page.waitForTimeout(250);
    await shot(page, `${device}-admin-person-menu`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add person" }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("Email").fill("eve@baskule.test");
    await shot(page, `${device}-admin-add-person`);
    await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
    await page.getByText("Invitation ready").waitFor();
    const link = await page.getByLabel("Invitation link", { exact: true }).inputValue();
    check(
      /\/invite#token=/.test(link),
      `${device}: invitation link carries the token in the fragment`,
    );
    await shot(page, `${device}-admin-person-added`);
    await page.getByRole("button", { name: "Done" }).click();
    // Deep links open a page directly, sidebar or not.
    await page.goto("/admin/people/invitations");
    await page.getByText("eve@baskule.test").first().waitFor();
    check(
      (await page.getByText("erin@baskule.test").count()) > 0,
      `${device}: admin lists pending invitations on their own page`,
    );
    await shot(page, `${device}-admin-invitations`);
    await page
      .getByRole("navigation", { name: "Admin", exact: true })
      .getByRole("link", { name: "Team spaces" })
      .click();
    await page.waitForURL(/\/admin\/spaces\/team$/);
    await page.getByRole("button", { name: "New team space" }).waitFor();
    await shot(page, `${device}-admin-team-spaces`);
    await page.getByRole("button", { name: "Manage" }).first().click();
    await page.getByRole("dialog").getByText("Members (").waitFor();
    await page.waitForTimeout(400);
    await shot(page, `${device}-space-dialog`);
    await page.getByRole("button", { name: "Done" }).click();
    await page.goto("/admin/general/overview");
    await page.getByText("Spaces awake").waitFor();
    await page.waitForTimeout(500);
    await shot(page, `${device}-admin-overview`);
    await page.goto("/admin/general/authentication");
    await page.getByText("Email and password").waitFor();
    await shot(page, `${device}-admin-authentication`);
    await page.goto("/admin/nowhere/at-all");
    await page.waitForURL((url) => url.pathname !== "/admin/nowhere/at-all");
    check(
      new URL(page.url()).pathname.startsWith("/admin"),
      `${device}: an unknown admin page goes back to the admin home`,
    );
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${device}: admin pages fit the viewport`,
    );
    await context.close();
  },

  /**
   * Usage and limits: the admin dashboard and its CSV, a daily token limit, the overview summary
   * and suggested prices; then Alice near her limit (85 %) and Bob past it, in the composer.
   * The mock's figures are fixed for today (mock-server.mjs TODAY_TOKENS).
   */
  async usage(browser, device) {
    const admin = await newPage(browser, device);
    const { page } = admin;
    try {
      await signIn(page, "admin");
      await page.goto("/admin/ai/usage");
      const people = page.getByRole("table", { name: "Usage per person" });
      await people.getByText("alice@baskule.test").waitFor();
      await shot(page, `${device}-admin-usage`);
      await people.getByRole("button", { name: "Tokens" }).click();
      check(
        (await people.locator('th[aria-sort="descending"]').textContent())?.includes("Tokens"),
        `${device}: the people table sorts by tokens`,
      );
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download this table as CSV" }).click(),
      ]);
      const csv = NodeFS.readFileSync(await download.path(), "utf8");
      check(
        download.suggestedFilename().startsWith("usage-people-") &&
          csv.includes("Person,Email,Cost (USD),Tokens,Chats,Messages") &&
          csv.includes("alice@baskule.test"),
        `${device}: CSV export of the table on screen`,
      );
      await page.getByRole("switch", { name: "Limit usage" }).click();
      await page.getByRole("switch", { name: "Daily limit" }).click();
      await page.getByLabel("Tokens per person").first().fill("2M");
      await page.getByRole("button", { name: "Save limits" }).click();
      await page.getByText("Limits saved and applied", { exact: true }).waitFor();
      await page.getByTestId("usage-limit-daily").scrollIntoViewIfNeeded();
      await shot(page, `${device}-admin-limits`);
      const saved = await (await page.request.get("/api/baskule/admin/usage/limits")).json();
      check(
        saved.enabled === true &&
          saved.rules.length === 1 &&
          saved.rules[0].window === "daily" &&
          saved.rules[0].tokens === 2_000_000,
        `${device}: admin turns on a daily limit of 2M tokens`,
      );
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${device}: usage dashboard fits the viewport`,
      );
      await page.goto("/admin/general/overview");
      await page.getByText("Usage this month", { exact: true }).waitFor();
      await shot(page, `${device}-admin-overview`);
      await page.goto("/admin/ai/models");
      // The settings scenario may leave a custom endpoint, whose prices are entered. Not saved.
      await page.getByLabel("Provider", { exact: true }).click();
      await page.getByRole("option", { name: "Mistral", exact: true }).click();
      await page.getByText("$0.68", { exact: true }).waitFor();
      check(
        (await page.getByRole("spinbutton", { name: "Input" }).count()) === 0,
        `${device}: a built-in model shows its catalog prices, read-only`,
      );
      await page.getByText("Price", { exact: true }).scrollIntoViewIfNeeded();
      await shot(page, `${device}-admin-model-prices`);

      const alice = await newPage(browser, device);
      try {
        await signIn(alice.page, "alice");
        await alice.page.goto("/settings/usage");
        await alice.page.getByRole("meter", { name: "Daily limit" }).waitFor();
        check(
          (await alice.page.getByText("85% used", { exact: true }).count()) === 1,
          `${device}: Settings → Usage shows the daily limit at 85%`,
        );
        await shot(alice.page, `${device}-usage-settings`);
        await alice.page.goto("/");
        await alice.page.getByText("What can I help with?").waitFor({ timeout: 90_000 });
        await alice.page.getByText(/^85% used · Resets /).waitFor({ timeout: 30_000 });
        check(true, `${device}: the composer shows a limit that is close`);
        await shot(alice.page, `${device}-composer-near-limit`);
      } finally {
        await alice.context.close();
      }
      const bob = await newPage(browser, device);
      try {
        await signIn(bob.page, "bob");
        await bob.page.getByText("What can I help with?").waitFor({ timeout: 90_000 });
        await bob.page
          .getByText("Daily limit reached", { exact: true })
          .waitFor({ timeout: 30_000 });
        check(
          (await bob.page.getByText(/^You can send messages again /).count()) > 0,
          `${device}: the composer says when a reached limit resets`,
        );
        await shot(bob.page, `${device}-composer-limit-reached`);
      } finally {
        await bob.context.close();
      }
    } finally {
      // Later scenarios expect nobody to be limited.
      await page.request
        .put("/api/baskule/admin/usage/limits", { data: { enabled: false, rules: [] } })
        .catch(() => undefined);
      await admin.context.close();
    }
  },

  /** Admin: catalog, add and review, set up, groups. Then a person's plugins and a space owner's setting. */
  async plugins(browser, device) {
    // Each device adds its own catalog entry and group: the mock keeps state between the two runs.
    const pick = device === "desktop" ? "Notion" : "Linear";
    const groupName = `Support ${device}`;
    const admin = await newPage(browser, device);
    const page = admin.page;
    await signIn(page, "admin");
    await page.goto("/admin/plugins/catalog");
    await page.getByRole("button", { name: `Add ${pick}` }).waitFor();
    check(
      (await page.getByText("Official MCP Registry").count()) > 0,
      `${device}: catalog results show their source`,
    );
    await shot(page, `${device}-plugins-catalog`);
    await page.getByRole("searchbox", { name: "Search plugins" }).fill("offline");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText(/didn't answer/).waitFor();
    check(true, `${device}: a registry that does not answer is reported, not fatal`);
    await page.getByRole("searchbox", { name: "Search plugins" }).fill(pick.toLowerCase());
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText(`Results for “${pick.toLowerCase()}”`).waitFor();
    await page.getByRole("button", { name: `Add ${pick}` }).click();
    const review = page.getByRole("dialog", { name: `${pick} was added` });
    await review.waitFor();
    check(
      (await review.getByText("1 connector").count()) === 1,
      `${device}: adding shows what the plugin contains`,
    );
    await page.waitForTimeout(300);
    await shot(page, `${device}-plugins-review`);
    await review.getByRole("button", { name: "Set it up" }).click();
    await page.waitForURL(/\/admin\/plugins\/installed\/[^/]+$/);
    await page.getByRole("heading", { name: pick, level: 1 }).waitFor();
    const installedId = new URL(page.url()).pathname.split("/").at(-1);
    let inventory = await (await page.request.get("/api/baskule/admin/plugins")).json();
    check(
      inventory.plugins.some((plugin) => plugin.id === installedId && !plugin.enabled),
      `${device}: an added plugin starts turned off`,
    );
    await page.getByRole("switch", { name: `Everyone can use ${pick}` }).click();
    await page.getByRole("switch", { name: `${pick} is on` }).click();
    await page
      .getByRole("switch", { name: `${pick} is on`, checked: true, disabled: false })
      .waitFor();
    inventory = await (await page.request.get("/api/baskule/admin/plugins")).json();
    const groups = (await (await page.request.get("/api/baskule/admin/groups")).json()).groups;
    check(
      inventory.plugins.some((plugin) => plugin.id === installedId && plugin.enabled) &&
        groups.find((group) => group.builtin === "everyone").plugins.includes(installedId),
      `${device}: the admin turns it on and grants it to Everyone`,
    );
    await shot(page, `${device}-plugins-detail`);

    await page.goto("/admin/plugins/installed");
    await page.getByRole("link", { name: "Brave Search" }).first().waitFor();
    await shot(page, `${device}-plugins-installed`);
    await page.getByRole("link", { name: "Brave Search" }).first().click();
    await page.getByLabel("Key", { exact: true }).fill(`Bearer mock-secret-${device}`);
    await page.getByRole("button", { name: "Save key" }).click();
    await page.getByText("Key saved").first().waitFor();
    check(
      !JSON.stringify(
        await (await page.request.get("/api/baskule/admin/plugins")).json(),
      ).includes("mock-secret"),
      `${device}: an organization key is write-only`,
    );
    await shot(page, `${device}-plugins-key`);

    await page.goto("/admin/plugins/catalog");
    await page.getByRole("button", { name: "Add your own" }).click();
    const own = page.getByRole("dialog", { name: "Add your own plugin" });
    await own.getByRole("button", { name: "Git repository" }).click();
    await own.getByLabel("Repository").fill("https://github.com/acme/plugins");
    await own.getByLabel("Commit").fill("abc123");
    check(
      (await own.getByText("Enter the full commit ID: 40 letters and digits.").count()) === 1,
      `${device}: a short commit is explained before sending`,
    );
    await own.getByLabel("Commit").fill("0123456789abcdef0123456789abcdef01234567");
    await own.getByLabel("Folder (optional)").fill(`skills/handbook-${device}`);
    await shot(page, `${device}-plugins-add-own`);
    await own.getByRole("button", { name: "Add plugin" }).click();
    const ownReview = page.getByRole("dialog", { name: `handbook-${device} was added` });
    await ownReview.waitFor();
    await ownReview.getByRole("button", { name: "Remove it" }).click();
    await ownReview.waitFor({ state: "hidden" });
    inventory = await (await page.request.get("/api/baskule/admin/plugins")).json();
    check(
      !inventory.plugins.some((plugin) => plugin.name === `handbook-${device}`),
      `${device}: a plugin added from a git repository can be discarded after review`,
    );

    await page.goto("/admin/people/groups");
    await page.getByRole("link", { name: "Everyone", exact: true }).waitFor();
    await shot(page, `${device}-groups`);
    await page.getByRole("button", { name: "New group" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill(groupName);
    await page.getByRole("button", { name: "Create group" }).click();
    await page.getByRole("heading", { name: groupName, level: 1 }).waitFor();
    await page.getByRole("combobox", { name: "Person to add" }).click();
    await page.getByRole("option", { name: /Bob Durand/ }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Remove Bob Durand from the group" }).waitFor();
    await page.getByRole("switch", { name: `${groupName} can use Sales` }).click();
    await page.getByRole("switch", { name: `${groupName} can use Sales`, checked: true }).waitFor();
    await shot(page, `${device}-group-detail`);
    await page.goto("/admin/people/groups/everyone");
    await page.getByText("Everyone always includes every person").waitFor();
    check(
      (await page.getByRole("button", { name: "Delete group…" }).count()) === 0,
      `${device}: Everyone can't be deleted`,
    );
    await page.goto("/admin/people/users");
    await page.getByRole("button", { name: "Options for Bob Durand" }).click();
    check(
      (await page.getByRole("menuitemcheckbox", { name: "Can create team spaces" }).count()) === 0,
      `${device}: space creation is no longer a per-person switch`,
    );
    await page.keyboard.press("Escape");
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${device}: plugin admin pages fit the viewport`,
    );
    await admin.context.close();

    const bob = await newPage(browser, device);
    await signIn(bob.page, "bob");
    await bob.page.goto("/settings/plugins");
    await bob.page.getByRole("switch", { name: "Use Google Drive" }).waitFor();
    check(
      (await bob.page.getByRole("switch", { name: "Use Sales" }).count()) === 1,
      `${device}: a person sees the plugins their groups allow`,
    );
    // The mock keeps Bob's choice from the other device's run.
    const drive = bob.page.getByRole("switch", { name: "Use Google Drive" });
    if (!(await drive.isChecked())) await drive.click();
    await bob.page.getByRole("switch", { name: "Use Google Drive", checked: true }).waitFor();
    // The mock keeps the connection from the other device's run.
    const connectButton = bob.page.getByRole("button", { name: "Connect your account" });
    if (await connectButton.count()) {
      await connectButton.click();
      await bob.page.waitForURL((url) => url.pathname === "/settings/plugins" && !url.search);
    }
    await bob.page.getByRole("button", { name: "Disconnect" }).waitFor();
    check(true, `${device}: connecting an account returns to Settings → Plugins, connected`);
    await shot(bob.page, `${device}-settings-plugins`);
    await bob.context.close();

    const alice = await newPage(browser, device);
    await signIn(alice.page, "alice");
    await openSidebarOnPhone(alice.page, device);
    await alice.page.getByTestId("baskule-user-menu").click();
    await alice.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await alice.page.getByRole("link", { name: "Spaces", exact: true }).click();
    // Acme is Alice's only team space; it follows her personal space.
    await alice.page.getByRole("button", { name: "Manage", exact: true }).last().click();
    const personal = alice.page.getByRole("switch", { name: "Allow personal-account plugins" });
    await personal.waitFor();
    check(
      !(await personal.isChecked()),
      `${device}: personal-account plugins start off in a team space`,
    );
    await personal.click();
    await alice.page
      .getByRole("switch", { name: "Allow personal-account plugins", checked: true })
      .waitFor();
    const settings = await (
      await alice.page.request.get("/api/baskule/spaces/acme/plugins")
    ).json();
    check(
      settings.personalPluginsAllowed === true,
      `${device}: a space owner allows personal accounts`,
    );
    await alice.page
      .getByRole("dialog")
      .getByText("Plugins", { exact: true })
      .scrollIntoViewIfNeeded();
    await shot(alice.page, `${device}-space-plugins`);
    await personal.click();
    await alice.context.close();
  },

  async passwords(browser, device) {
    const { context, page } = await newPage(browser, device);
    await signIn(page, "admin");
    const response = await page.request.post("/api/baskule/admin/users/u-carol/reset-link", {
      headers: { origin: BASE },
    });
    const { url } = await response.json();
    await openSidebarOnPhone(page, device);
    await page.getByTestId("baskule-user-menu").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Change password", exact: true }).click();
    await page.getByLabel("Current password").fill("wrong-one");
    await page.getByLabel("New password", { exact: true }).fill("new-password-1");
    await page.getByLabel("Confirm new password").fill("new-password-1");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await page.getByRole("alert").waitFor();
    check(
      (await page.getByRole("alert").textContent())?.includes("not right"),
      `${device}: a wrong current password is reported`,
    );
    await shot(page, `${device}-change-password`);
    await context.close();
    const reset = await newPage(browser, device);
    await reset.page.goto(url.replace(/^https?:\/\/[^/]+/, ""));
    await reset.page.getByLabel("New password", { exact: true }).fill("carol-new-password");
    await reset.page.getByLabel("Confirm password").fill("carol-new-password");
    await reset.page.getByRole("button", { name: "Change password" }).click();
    await reset.page.getByText("Password changed").waitFor();
    check(true, `${device}: a reset link sets a new password`);
    await shot(reset.page, `${device}-reset-password-done`);
    await reset.context.close();
  },

  async apps(browser, device) {
    const { context, page } = await newPage(browser, device);
    await signIn(page, "bob");
    await page.goto("/settings/desktop");
    await page.getByText("Baskule for Linux").first().waitFor();
    await shot(page, `${device}-apps`);
    await page.getByRole("button", { name: "Show QR for another device", exact: true }).click();
    const link = await page
      .getByRole("textbox", { name: "Connection link", exact: true })
      .inputValue();
    check(
      /\/link#code=[\w-]{20,}$/.test(link),
      `${device}: Connect a device shows a one-time link`,
    );
    await page
      .locator("svg title", { hasText: "Sign-in link for another device" })
      .waitFor({ state: "attached" });
    await shot(page, `${device}-apps-connect`);
    const other = await newPage(browser, device);
    await other.page.goto(link);
    await other.page.getByRole("button", { name: "Confirm connection", exact: true }).waitFor();
    await other.page.waitForFunction(() => window.location.hash === "");
    check(
      (await other.page.request.get("/api/baskule/me")).status() === 401,
      `${device}: opening a connection link waits for confirmation before signing in`,
    );
    await other.page.getByRole("button", { name: "Confirm connection", exact: true }).click();
    await other.page.waitForURL((url) => url.pathname === "/");
    const me = await other.page.evaluate(async () => (await fetch("/api/baskule/me")).json());
    check(me.user?.email === ACCOUNTS.bob[0], `${device}: the link signs another browser in`);
    await other.page.goto(link);
    await other.page.getByRole("button", { name: "Confirm connection", exact: true }).click();
    await other.page
      .getByRole("alert")
      .filter({ hasText: "This connection link is not valid, has expired or was already used." })
      .waitFor();
    check(true, `${device}: a used link is refused`);
    await other.context.close();
    await openSidebarOnPhone(page, device);
    await page.getByTestId("baskule-user-menu").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    check(true, `${device}: sign out returns to /login`);
    await page.goto("/admin");
    await page.waitForURL(/\/login/);
    check(page.url().includes("next=%2Fadmin"), `${device}: deep link keeps next after sign-in`);
    await context.close();
  },
};

const wanted = process.argv.slice(2);
const devices = (process.env.SHOTS_DEVICES ?? "desktop,phone").split(",");
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  // A generated tone instead of a real microphone, granted without a prompt (voice scenario).
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    for (const device of devices) {
      console.log(`${name} (${device})`);
      try {
        await run(browser, device);
      } catch (error) {
        failures.push(`${name}/${device}: ${error.message.split("\n")[0]}`);
        console.error(`  ERROR ${error.message.split("\n")[0]}`);
      }
    }
  }
} finally {
  await browser.close();
}
console.log(
  failures.length === 0
    ? "all checks passed"
    : `${failures.length} failure(s):\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
