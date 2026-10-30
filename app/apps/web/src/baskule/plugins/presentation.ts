import { t } from "../../i18n";
// baskule: how plugins are named to people. Everything is a "plugin"; its kind, source and
// credential mode are shown in plain words (the people reading them are not developers).
import type {
  CredentialMode,
  PluginKind,
  PluginServer,
  PluginSource,
} from "@t3tools/contracts/baskule-plugins";
import { BookOpenTextIcon, PackageIcon, PlugIcon, type LucideIcon } from "lucide-react";

export const PLUGIN_KINDS: ReadonlyArray<PluginKind> = ["mcp", "skill", "bundle"];

export const KIND_ICONS: Record<PluginKind, LucideIcon> = {
  mcp: PlugIcon,
  skill: BookOpenTextIcon,
  bundle: PackageIcon,
};

export function kindLabel(kind: PluginKind): string {
  switch (kind) {
    case "mcp":
      return t("Connector · MCP");
    case "skill":
      return t("Skill");
    case "bundle":
      return t("Bundle");
  }
}

/** The kind filter's plural labels. */
export function kindFilterLabel(kind: PluginKind): string {
  switch (kind) {
    case "mcp":
      return t("Connectors");
    case "skill":
      return t("Skills");
    case "bundle":
      return t("Bundles");
  }
}

export function registryLabel(registry: string): string {
  switch (registry) {
    case "mcp":
      return t("Official MCP Registry");
    case "anthropic-knowledge-work":
      return t("Anthropic work plugins");
    case "anthropic-skills":
      return t("Anthropic example skills");
    case "claude-plugins":
      return t("Claude plugin directory");
    case "codex-plugins":
      return t("OpenAI Codex plugins");
    default:
      return registry;
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
    case "registry":
      return t("From {{registry}}", { registry: registryLabel(source.registry) });
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

/** User modes act as the person whose turn it is. The backend requires `personal` for them. */
export const isPersonalCredential = (mode: CredentialMode) =>
  mode === "user-oauth" || mode === "login-identity";

export const CREDENTIAL_MODES: ReadonlyArray<CredentialMode> = [
  "none",
  "organization",
  "user-oauth",
  "login-identity",
];

export function credentialLabel(mode: CredentialMode): string {
  switch (mode) {
    case "none":
      return t("No sign-in needed");
    case "organization":
      return t("Organization key");
    case "user-oauth":
      return t("Each person connects their own account");
    case "login-identity":
      return t("Each person's sign-in account");
  }
}

export function credentialDescription(mode: CredentialMode): string {
  switch (mode) {
    case "none":
      return t("Works as soon as it is turned on.");
    case "organization":
      return t("You enter one key here. Everyone who uses it shares that key.");
    case "user-oauth":
      return t("People connect their account in Settings → Plugins. It acts as them.");
    case "login-identity":
      return t("Uses the Google or Microsoft account people sign in with. It acts as them.");
  }
}

/** "Everyone" is created by the system: show its name in the reader's language. */
export function groupName(group: { readonly name: string; readonly builtin?: "everyone" }): string {
  return group.builtin === "everyone" ? t("Everyone") : group.name;
}
