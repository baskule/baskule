import { t } from "../i18n";
// baskule: the T3 settings pages Baskule keeps. 0.1: archived chats. 0.2 hosted: also scheduled
// tasks and their webhooks (thin-server scope 3), which T3 keeps under settings. 0.4 hosted: usage and plugins.
import { BASKULE_HOSTED } from "./flags";

// Getters, so a title follows a language switch.
const PAGES: Readonly<Record<string, string>> = {
  get "/settings/account"() {
    return t("Account");
  },
  get "/settings/spaces"() {
    return t("Spaces");
  },
  get "/settings/archived"() {
    return t("Archived chats");
  },
  get "/settings/general"() {
    return t("Settings");
  },
  get "/settings/usage"() {
    return t("Usage");
  },
  get "/settings/plugins"() {
    return t("Plugins");
  },
  get "/settings/scheduled-tasks"() {
    return t("Scheduled tasks");
  },
};
const HOSTED_ONLY = new Set([
  "/settings/account",
  "/settings/spaces",
  "/settings/usage",
  "/settings/plugins",
  "/settings/scheduled-tasks",
]);

/** Pages of Baskule's own, outside T3's settings scopes (environment, project). */
export function isBaskuleOwnSettingsPage(pathname: string): boolean {
  return (
    pathname === "/settings/general" ||
    (BASKULE_HOSTED &&
      ["/settings/account", "/settings/spaces", "/settings/usage", "/settings/plugins"].includes(
        pathname,
      ))
  );
}

export function isBaskuleSettingsPage(pathname: string): boolean {
  return pathname in PAGES && (BASKULE_HOSTED || !HOSTED_ONLY.has(pathname));
}

export function baskuleSettingsTitle(pathname: string): string {
  return PAGES[pathname] ?? t("Settings");
}
