// baskule: how plugins are named to people. Everything is a "plugin" that gives the assistant tools,
// skills or both; its source, credential mode and status are shown in plain words (the people
// reading them are not developers).
import type { SkillFieldError, SkillWarning } from "@t3tools/contracts/baskule-plugin-formats";
import type {
  CredentialMode,
  OmissionCode,
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

/** "Tools from 2 servers and 3 skills": what a plugin gives the assistant, in one line. */
export function includedSummary(contents: {
  readonly servers: ReadonlyArray<unknown>;
  readonly skills: ReadonlyArray<unknown>;
}): string {
  const tools = t("Tools from {{count}} server", {
    count: contents.servers.length,
    defaultValue_other: "Tools from {{count}} servers",
  });
  const skills = t("{{count}} skill", {
    count: contents.skills.length,
    defaultValue_other: "{{count}} skills",
  });
  if (contents.servers.length === 0) return skills;
  if (contents.skills.length === 0) return tools;
  return t("{{tools}} and {{skills}}", { tools, skills });
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

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** `owner/repo`, then the folder when the plugin is one folder of the repository. */
export function githubName(source: Extract<PluginSource, { type: "github" }>): string {
  const repo = source.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  return source.path ? `${repo}/${source.path}` : repo;
}

/** Where a plugin comes from, in one short line. Pins (commits, file hashes) stay out of it. */
export function sourceLabel(source: PluginSource): string {
  switch (source.type) {
    case "catalog":
      return t("Baskule catalog");
    case "github":
      return t("From {{repo}} on GitHub", { repo: githubName(source) });
    case "upload":
      return t("Uploaded file");
    case "custom":
      return t("Made in Baskule");
  }
}

export function serverHost(server: PluginServer): string {
  return hostOf(server.url);
}

export const CREDENTIAL_MODES: ReadonlyArray<CredentialMode> = [
  "none",
  "user-oauth",
  "organization",
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

/** Why Baskule leaves a part of a package out, in words for people who don't write plugins. */
export function omissionText(code: OmissionCode): string {
  switch (code) {
    case "claude_commands":
      return t("Commands for Claude Code. Baskule doesn't use these.");
    case "claude_agents":
      return t("Agents for Claude Code. Baskule doesn't use these.");
    case "hooks":
      return t("Hooks that run inside Claude Code. Baskule doesn't use these.");
    case "local_program":
      return t(
        "A program that runs on someone's computer. Baskule needs a web address; ask its maker whether it has one.",
      );
    case "invalid_server":
      return t("A server described in a way Baskule can't read.");
    case "skill_without_instructions":
      return t("A skill folder without instructions, so the assistant couldn't use it.");
    case "invalid_skill":
      return t("A skill whose name or description doesn't follow the skill rules.");
    case "skill_license":
      return t("A skill whose license doesn't allow using it here.");
    case "other_files":
      return t("Files that aren't part of a skill or a server.");
  }
}

/** Why a skill's name or description can't be saved, with the rule it breaks. */
export function skillFieldErrorText(error: SkillFieldError): string {
  switch (error) {
    case "name_format":
      return t("Use only lowercase letters, numbers and single hyphens, like call-prep.");
    case "name_too_long":
      return t("Use 64 characters at most.");
    case "name_taken":
      return t("Another skill in this plugin has this name.");
    case "description_empty":
      return t("Say what the skill does and when to use it.");
    case "description_too_long":
      return t("Use 1,024 characters at most.");
  }
}

/** What may not work outside Claude Code. Advice only: the skill can still be saved. */
export function skillWarningText(warning: SkillWarning): string {
  switch (warning) {
    case "slash_command":
      return t("This skill uses a slash command. Baskule may not have that command.");
    case "claude_only_tool":
      return t("This skill names a tool specific to Claude Code. It may need changing here.");
    case "software_install":
      return t("This skill asks to install software. The computer may need setup first.");
    case "secret_in_file":
      return t("This file may contain a password or key. Remove it before sharing the skill.");
  }
}

/** "Everyone" is created by the system: show its name in the reader's language. */
export function groupName(group: { readonly name: string; readonly builtin?: "everyone" }): string {
  return group.builtin === "everyone" ? t("Everyone") : group.name;
}
