// baskule: mock-front page checks at desktop 1440x900 and phone 390x844; no model spend.
// node apps/web/baskule-dev/shots.mjs [scenario ...]
// PNGs go to SHOTS_DIR or .run/web-mock/artifacts; broken checks and browser errors are reported.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { chromium } from "playwright";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const BASE = process.env.MOCK_URL ?? "http://127.0.0.1:47700";
const OUT = NodePath.resolve(
  process.env.SHOTS_DIR ?? NodePath.join(HERE, "../../../../.run/web-mock/artifacts"),
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
  // A space starts its T3 server on first use; allow for initialization.
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
    console.log(
      `  [module:${device}] ${url.origin}${url.pathname.slice(0, 300)} status=${response.status()} content-type=${contentType.slice(0, 100)}`,
    );
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
  await page.mouse.move(0, 0);
  const file = NodePath.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot ${NodePath.relative(process.cwd(), file)}`);
};

/** The first logos finished loading, or failed, so shots draw them. Lazy ones below stay unloaded. */
const logosLoaded = (page) =>
  page.waitForFunction(
    () => [...document.images].slice(0, 6).every((image) => image.complete),
    undefined,
    { timeout: 20_000 },
  );

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
      const fresh =
        (await (await page.request.get("/api/baskule/admin/settings")).json()).ai === null;
      await page.goto("/admin/ai/models");
      await page.getByLabel("Provider", { exact: true }).waitFor();
      if (fresh)
        check(
          await page.getByText("No AI provider yet", { exact: true }).isVisible(),
          `${device}: a new installation has no AI provider until an admin saves one`,
        );
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
      const stop = page.getByRole("button", { name: "Finish voice input" });
      const recording = page.getByRole("status", { name: "Recording" });
      await start.click();
      await recording.filter({ hasText: "0:01" }).waitFor();
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
      await recording.waitFor();
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
      await recording.filter({ hasText: "0:01" }).waitFor();
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

  /** Admin: browse, search, review and add, Google sign-in setup, installed, sources. Then a member's plugins. */
  async plugins(browser, device) {
    // Each device adds its own plugin: the mock keeps state between the two runs.
    const [pick, field, value] =
      device === "desktop"
        ? ["NetSuite", "NETSUITE_MCP_URL", "https://acme.suitetalk.api.netsuite.com/mcp"]
        : ["Calendly", null, null];
    const fits = async (page, what) =>
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${device}: ${what} fits the viewport`,
      );
    const admin = await newPage(browser, device);
    const page = admin.page;
    try {
      await signIn(page, "admin");
      const listed = await (await page.request.get("/api/baskule/admin/plugins")).json();
      for (const plugin of listed.plugins.filter((entry) => entry.displayName === pick))
        await page.request.delete(`/api/baskule/admin/plugins/${plugin.id}`);

      await page.goto("/admin/plugins/browse");
      await page.getByRole("heading", { name: "Recommended", exact: true }).waitFor();
      check(
        (await page.getByRole("heading", { name: "Sales & CRM", exact: true }).count()) === 1 &&
          (await page
            .getByRole("heading", { name: "More apps from Composio", exact: true })
            .count()) === 1,
        `${device}: browse lists recommended plugins, categories and Composio apps`,
      );
      await logosLoaded(page);
      await fits(page, "browse");
      await shot(page, `${device}-plugins-browse`);

      await page.getByRole("searchbox", { name: "Search plugins" }).fill("google");
      await page.getByRole("link", { name: "Add Google Calendar", exact: true }).waitFor();
      await logosLoaded(page);
      check(
        (await page.getByRole("heading", { name: "Recommended", exact: true }).count()) === 0,
        `${device}: search replaces the sections with ranked results`,
      );
      await shot(page, `${device}-plugins-search`);
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("");
      await page.getByRole("button", { name: "Finance", exact: true }).click();
      await page.getByRole("link", { name: "Add Stripe", exact: true }).waitFor();
      await logosLoaded(page);
      check(
        (await page
          .getByRole("button", { name: "Finance", exact: true })
          .getAttribute("aria-pressed")) === "true",
        `${device}: a category chip filters the catalog`,
      );
      await shot(page, `${device}-plugins-category`);

      await page.getByRole("button", { name: "All", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search plugins" }).fill(pick);
      await page.getByRole("link", { name: `Add ${pick}`, exact: true }).click();
      const add = page.getByRole("button", { name: "Add plugin", exact: true });
      await add.waitFor();
      await page.getByRole("radio", { name: "Only people in some groups", exact: true }).click();
      await page.getByRole("checkbox", { name: "Sales" }).click();
      if (field) await page.getByLabel(field, { exact: true }).fill(value);
      await fits(page, "plugin review");
      await shot(page, `${device}-plugins-review`);
      await add.click();
      await page.waitForURL((url) => /^\/admin\/plugins\/installed\/[^/]+$/.test(url.pathname));
      await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
      const added = (
        await (await page.request.get("/api/baskule/admin/plugins")).json()
      ).plugins.find((entry) => entry.displayName === pick);
      check(
        added?.access.kind === "groups" &&
          added.access.groups.join() === "g-sales" &&
          added.status === "ready" &&
          (!field || added.servers[0].variables[0].set),
        `${device}: adding saves who can use it and the values it needs`,
      );

      await page.goto("/admin/plugins/installed/gmail");
      const card = page.getByRole("form", { name: "Set up sign-in to Google" });
      await card.waitFor();
      const callback = await card.locator("output").textContent();
      check(
        callback === `${BASE}/api/baskule/plugins/oauth/callback` &&
          (await card.getByLabel("Authorization parameters (optional)").inputValue()) ===
            "access_type=offline&prompt=consent" &&
          (await card
            .getByRole("link", { name: "Enable gmailmcp.googleapis.com" })
            .getAttribute("href")) ===
            "https://console.cloud.google.com/apis/library/gmailmcp.googleapis.com",
        `${device}: Google sign-in setup shows the callback URL, the API to enable and the default parameters`,
      );
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -80));
      await fits(page, "Google sign-in setup");
      await shot(page, `${device}-plugins-google-setup`);
      if (device === "phone") {
        await card
          .getByLabel("Client ID", { exact: true })
          .fill("1234-mock.apps.googleusercontent.com");
        await card.getByLabel("Client secret", { exact: true }).fill("mock-secret");
        await card.getByRole("button", { name: "Save OAuth client", exact: true }).click();
        await page.getByText("People sign in through your Google OAuth client.").waitFor();
        const gmail = (
          await (await page.request.get("/api/baskule/admin/plugins")).json()
        ).plugins.find((entry) => entry.id === "gmail");
        check(gmail?.status === "ready", `${device}: saving the Google client makes Gmail ready`);
      }

      await page.goto("/admin/plugins/installed");
      await page.getByRole("link", { name: "Gmail", exact: true }).waitFor();
      await fits(page, "installed plugins");
      await shot(page, `${device}-plugins-installed`);

      await page.goto("/admin/plugins/sign-in");
      await page.getByRole("heading", { name: "Plugin registries", exact: true }).waitFor();
      await logosLoaded(page);
      await fits(page, "sign-in and sources");
      await shot(page, `${device}-plugins-sign-in`);
    } finally {
      await admin.context.close();
    }

    const alice = await newPage(browser, device);
    try {
      await signIn(alice.page, "alice");
      await alice.page.goto("/settings/plugins");
      const linear = alice.page.getByRole("link", { name: "Sign in to Linear", exact: true });
      await linear.waitFor();
      check(
        (await linear.getAttribute("href")) ===
          "/api/baskule/plugins/linear/servers/linear/connect?returnTo=%2Fsettings%2Fplugins" &&
          (await alice.page.getByText("Connected as alice@baskule.test").count()) === 1 &&
          (await alice.page.getByRole("button", { name: /^Add|^Install/ }).count()) === 0,
        `${device}: a member sees switches and sign-ins, never install controls`,
      );
      await logosLoaded(alice.page);
      await fits(alice.page, "member plugins");
      await shot(alice.page, `${device}-plugins-member`);
      const toggle = alice.page.getByRole("switch", { name: "Use Linear", exact: true });
      await toggle.click();
      await alice.page.waitForFunction(
        async () =>
          (await (await fetch("/api/baskule/plugins")).json()).plugins.find(
            (p) => p.id === "linear",
          )?.on === false,
      );
      await toggle.click();
      await linear.click();
      await alice.page.getByText("Your account is connected.").waitFor();
      check(
        new URL(alice.page.url()).search === "" &&
          (await alice.page
            .getByRole("button", { name: "Disconnect Linear", exact: true })
            .count()) === 1,
        `${device}: signing in comes back connected and cleans the address`,
      );
      await alice.page.getByRole("button", { name: "Disconnect Linear", exact: true }).click();
      await alice.page
        .getByRole("alertdialog")
        .getByRole("button", { name: /Disconnect|Confirm|OK/ })
        .click();
      await linear.waitFor();
    } finally {
      await alice.context.close();
    }
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
    const download = page.getByRole("link", { name: "Download", exact: true });
    check(
      (await download.getAttribute("href")) ===
        "https://github.com/baskule/baskule/releases/download/v0.5.0/Baskule-0.5.0-x64.AppImage",
      `${device}: app download points to the running version's GitHub release asset`,
    );
    check(
      await page.getByText("Apps · version 0.5.0", { exact: true }).isVisible(),
      `${device}: apps show the running version`,
    );
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
    // Settings is a modal over the chat; sign out from the sidebar behind it.
    await page.goto("/");
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
  executablePath: process.env.CHROME,
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
