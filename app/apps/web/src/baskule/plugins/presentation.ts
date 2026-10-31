// baskule: how plugins are named to people. Everything is a "plugin" that gives the assistant tools,
// skills or both; its source, credential mode and status are shown in plain words (the people
// reading them are not developers).
import type {
  CredentialMode,
  PluginServer,
  PluginSource,
  PluginStatus,
} from "@t3tools/contracts/baskule-plugins";
import { BookOpenTextIcon, PackageIcon, PlugIcon, type LucideIcon } from "lucide-react";

import { t } from "../../i18n";

/** What a plugin gives the assistant. Derived from what it contains; plugins store no kind. */
export type PluginContentsKind = "tools" | "skills" | "both";

export function contentsKind(plugin: {
  readonly servers: ReadonlyArray<unknown>;
  readonly skills: ReadonlyArray<unknown>;
}): PluginContentsKind {
  if (plugin.servers.length === 0) return "skills";
  return plugin.skills.length > 0 ? "both" : "tools";
}

export const CONTENTS_ICONS: Record<PluginContentsKind, LucideIcon> = {
  tools: PlugIcon,
  skills: BookOpenTextIcon,
  both: PackageIcon,
};

export function contentsLabel(kind: PluginContentsKind): string {
  switch (kind) {
    case "tools":
      return t("Tools");
    case "skills":
      return t("Skills");
    case "both":
      return t("Tools and skills");
  }
}

/** The only five things a person is told about a plugin or one of its servers. */
export function statusText(status: PluginStatus, name: string): string {
  switch (status) {
    case "unavailable":
      return t("Not available to you");
    case "needs_setup":
      return t("Your administrator needs to finish setting it up");
    case "connect":
      return t("Connect your {{name}} account", { name });
    case "reconnect":
      return t("Reconnect your {{name}} account", { name });
    case "ready":
      return t("Ready");
  }
}

const shortCommit = (ref: string) => ref.slice(0, 7);
const repoName = (repo: string) =>
  repo.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Where a plugin comes from, in one short line. */
export function sourceLabel(source: PluginSource): string {
  switch (source.type) {
    case "catalog":
      return t("Baskule catalog");
    case "url":
      return t("Added by address: {{host}}", { host: hostOf(source.url) });
    case "git":
      return t("From {{repo}} at {{commit}}", {
        repo: repoName(source.repo),
        commit: shortCommit(source.ref),
      });
    case "archive":
      return t("Uploaded file");
  }
}

export function serverHost(server: PluginServer): string {
  return hostOf(server.url);
}

export const CREDENTIAL_MODES: ReadonlyArray<CredentialMode> = [
  "none",
  "organization",
  "user-oauth",
];

export function credentialLabel(mode: CredentialMode): string {
  switch (mode) {
    case "none":
      return t("No sign-in needed");
    case "organization":
      return t("Organization key");
    case "user-oauth":
      return t("Each person connects their own account");
  }
}

export function credentialDescription(mode: CredentialMode): string {
  switch (mode) {
    case "none":
      return t("Works with nothing to set up.");
    case "organization":
      return t("You enter one key here. Everyone who uses it shares that key.");
    case "user-oauth":
      return t("People connect their account in Settings → Plugins. It acts as them.");
  }
}

/** "Everyone" is created by the system: show its name in the reader's language. */
export function groupName(group: { readonly name: string; readonly builtin?: "everyone" }): string {
  return group.builtin === "everyone" ? t("Everyone") : group.name;
}
