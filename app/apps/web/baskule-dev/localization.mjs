// The localization seam: browser detection, explicit override, live updates, persistence and layout.
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const baseURL = process.env.MOCK_URL ?? "http://127.0.0.1:47850";
const out = join(root, ".run/localization/screenshots");
const catalog = async (locale) =>
  JSON.parse(await readFile(join(root, `app/packages/shared/src/locales/${locale}.json`), "utf8"));
await mkdir(out, { recursive: true });
const deadline = Date.now() + 30_000;
while (true) {
  try {
    await fetch(`${baseURL}/api/baskule/me`, { signal: AbortSignal.timeout(1000) });
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const browser = await chromium.launch({ headless: true });
try {
  for (const [hostLanguage, expected] of [
    ["fr-CA", "fr"],
    ["es-MX", "es"],
    ["de-AT", "de"],
    ["nl-BE", "nl"],
    ["it-CH", "it"],
    ["ja-JP", "en"],
  ]) {
    const context = await browser.newContext({ baseURL, locale: hostLanguage });
    try {
      const page = await context.newPage();
      await page.goto("/login");
      await page.waitForFunction(
        (language) => document.documentElement.lang === language,
        expected,
      );
      await page
        .getByRole("heading", {
          name: expected === "en" ? "Sign in" : (await catalog(expected))["Sign in"],
          exact: true,
        })
        .waitFor();
      console.log(`PASS ${hostLanguage} detects ${expected}`);
    } finally {
      await context.close();
    }
  }

  const context = await browser.newContext({
    baseURL,
    locale: "en-GB",
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .getByText("Use system language", { exact: true })
      .waitFor();
    await page.screenshot({ path: join(out, "english-desktop.png") });
    await page.getByLabel("Email", { exact: true }).fill("draft@baskule.test");
    await page.getByLabel("Password", { exact: true }).fill("draft-password");
    await page.getByRole("combobox", { name: "Language", exact: true }).click();
    await page.getByRole("option", { name: "Français", exact: true }).click();
    const french = await catalog("fr");
    await page.getByRole("heading", { name: french["Sign in"], exact: true }).waitFor();
    if (
      (await page.getByLabel(french.Email, { exact: true }).inputValue()) !== "draft@baskule.test"
    )
      throw new Error("Language switch lost the email draft");
    if ((await page.getByLabel(french.Password, { exact: true }).inputValue()) !== "draft-password")
      throw new Error("Language switch lost the password draft");
    await page.getByLabel(french.Email, { exact: true }).fill("");
    await page.getByLabel(french.Password, { exact: true }).fill("");
    await page.screenshot({ path: join(out, "french-desktop.png") });
    await page.reload();
    await page.getByRole("heading", { name: french["Sign in"], exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(out, "french-phone.png") });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
      throw new Error("French phone layout overflows");
    await page.getByRole("combobox", { name: french.Language, exact: true }).click();
    await page.getByRole("option", { name: "Deutsch", exact: true }).click();
    const german = await catalog("de");
    await page.getByRole("heading", { name: german["Sign in"], exact: true }).waitFor();
    await page.screenshot({ path: join(out, "german-phone.png") });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
      throw new Error("German phone layout overflows");
    await page.evaluate(() => window.dispatchEvent(new Event("languagechange")));
    if ((await page.evaluate(() => document.documentElement.lang)) !== "de")
      throw new Error("System update replaced an explicit selection");
    await page.getByRole("combobox", { name: german.Language, exact: true }).click();
    await page.getByRole("option", { name: german["Use system language"], exact: true }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    console.log(
      "PASS live override, draft preservation, restart persistence, reset to system and phone layouts",
    );
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
