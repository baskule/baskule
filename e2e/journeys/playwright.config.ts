import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["**/*.spec.mjs", "**/*.spec.ts"],
  outputDir: "../../.run/journeys/results",
  reporter: [["list"], ["html", { outputFolder: "../../.run/journeys/report", open: "never" }]],
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "phone", testIgnore: "**/chat-contracts.spec.mjs", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    launchOptions: { executablePath: process.env.E2E_CHROME, args: ["--no-sandbox"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
