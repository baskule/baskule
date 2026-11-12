import type { CatalogEntry } from "@t3tools/contracts/baskule-plugins";
import { expect, it } from "vite-plus/test";

import { originHref, searchScore } from "./presentation";

const entry = (overrides: Partial<CatalogEntry>): CatalogEntry => ({
  id: "cursor:x",
  source: "cursor",
  name: "x",
  displayName: "X",
  description: "",
  logo: null,
  homepage: null,
  domains: [],
  keywords: [],
  category: null,
  recommended: false,
  hasServers: true,
  skillCount: 0,
  installedPluginId: null,
  ...overrides,
});

it("ranks name matches above other word-prefix matches and ignores mid-word hits", () => {
  const calendar = entry({ name: "google-calendar", displayName: "Google Calendar" });
  const gmail = entry({
    name: "gmail",
    displayName: "Gmail",
    description: "Read Google mail.",
    domains: ["mail.google.com"],
  });
  const hubspot = entry({ name: "hubspot", displayName: "HubSpot", category: "sales" });
  expect(searchScore(calendar, "goo cal")).toBe(2);
  expect(searchScore(calendar, "googlecal")).toBe(2);
  expect(searchScore(gmail, "google")).toBe(1);
  expect(searchScore(gmail, "mail")).toBe(1);
  expect(searchScore(gmail, "oogle")).toBe(0);
  expect(searchScore(hubspot, "crm")).toBe(1);
  expect(searchScore(hubspot, "crm marketing")).toBe(0);
});

it("links a pinned GitHub source to the reviewed commit and folder", () => {
  expect(
    originHref({
      kind: "registry",
      registry: "cursor",
      repo: "https://github.com/cursor/plugins",
      path: "third_party/gmail",
      sha: "2eaf465",
    }),
  ).toBe("https://github.com/cursor/plugins/tree/2eaf465/third_party/gmail");
  expect(
    originHref({ kind: "github", repo: "https://github.com/acme/tools.git", sha: "abc" }),
  ).toBe("https://github.com/acme/tools/tree/abc");
  expect(originHref({ kind: "custom" })).toBeNull();
});
