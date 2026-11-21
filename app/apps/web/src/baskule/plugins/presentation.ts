import { m as resolveMessage } from "../../i18n/messages";
import { msg } from "gt-react";
// baskule: how plugins are named to people: categories, sources, sign-in needs and setup states,
// in plain words, plus the catalog search.
import type {
  CatalogEntry,
  CatalogSource,
  PluginCategory,
  PluginOrigin,
  ProviderId,
  ServerAuth,
  ServerSetup,
  SkippedKind,
} from "@t3tools/contracts/baskule-plugins";



export function categoryLabel(category: PluginCategory): string {
  switch (category) {
    case "productivity":
      return resolveMessage(msg("Productivity"));
    case "communication":
      return resolveMessage(msg("Communication"));
    case "sales":
      return resolveMessage(msg("Sales & CRM"));
    case "marketing":
      return resolveMessage(msg("Marketing"));
    case "finance":
      return resolveMessage(msg("Finance"));
    case "people":
      return resolveMessage(msg("Recruiting & HR"));
    case "design":
      return resolveMessage(msg("Design"));
    case "code":
      return resolveMessage(msg("Developer"));
    case "data":
      return resolveMessage(msg("Data"));
    case "ops":
      return resolveMessage(msg("Security & Ops"));
  }
}

export function providerName(provider: ProviderId): string {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- marketplace brand names
  return provider === "composio" ? "Composio" : "Pipedream";
}

export function sourceName(source: CatalogSource): string {
  switch (source) {
    case "anthropic":
      return "Anthropic";
    case "anthropic-work":
      return resolveMessage(msg("Anthropic knowledge work"));
    case "cursor":
      return "Cursor";
    case "xai":
      return "xAI";
    default:
      return providerName(source);
  }
}

/** The pinned source on GitHub, or null for servers added by address and hosted apps. */
export function originHref(origin: PluginOrigin): string | null {
  if (origin.kind !== "registry" && origin.kind !== "github") return null;
  const repo = origin.repo.replace(/\.git$/, "");
  return origin.path ? `${repo}/tree/${origin.sha}/${origin.path}` : `${repo}/tree/${origin.sha}`;
}

/** What each person needs before the assistant can use one server. */
export function authText(auth: ServerAuth): string {
  switch (auth.kind) {
    case "none":
      return resolveMessage(msg("No sign-in needed"));
    case "headers":
      return resolveMessage(msg("Uses one key for your organization"));
    case "oauth":
      return resolveMessage(msg("Each person signs in with their own account"));
    case "provider":
      return resolveMessage(msg("Each person connects their account on {provider}"), {
        provider: providerName(auth.provider),
      });
  }
}

export function setupText(setup: ServerSetup): string {
  switch (setup.state) {
    case "ready":
      return resolveMessage(msg("Ready"));
    case "needs_values":
      return resolveMessage(msg("Needs values"));
    case "needs_oauth_client":
      return resolveMessage(msg("Needs sign-in setup"));
    case "needs_provider":
      return resolveMessage(msg("Needs {provider}"), {
        provider: providerName(setup.provider),
      });
  }
}

export function skippedText(kind: SkippedKind): string {
  switch (kind) {
    case "local_program":
      return resolveMessage(msg("a program that runs on someone's computer"));
    case "editor_only":
      return resolveMessage(msg("a part that works only in its maker's app"));
    case "invalid_server":
      return resolveMessage(msg("a server Baskule can't read"));
    case "invalid_skill":
      return resolveMessage(msg("a skill that doesn't follow the skill rules"));
    case "unsupported_transport":
      return resolveMessage(msg("a server that uses an unsupported connection"));
    case "blank_server":
      return resolveMessage(msg("a server its publisher left without an address"));
  }
}

/** A site whose icon can stand in for a missing logo. GitHub would give every plugin one mark. */
export function pluginSite(entry: {
  readonly homepage: string | null;
  readonly domains?: ReadonlyArray<string>;
}): string | null {
  const domain = entry.domains?.[0]?.replace(/^https?:\/\//, "");
  if (domain) return `https://${domain}`;
  try {
    return entry.homepage && !new URL(entry.homepage).hostname.endsWith("github.com")
      ? entry.homepage
      : null;
  } catch {
    return null;
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Every query word starts a word of the text, or the text with its separators removed. */
export function matchesWordPrefixes(text: string, query: string): boolean {
  const wanted = words(query);
  const found = words(text);
  const compact = found.join("");
  return wanted.every(
    (term) => compact.startsWith(term) || found.some((word) => word.startsWith(term)),
  );
}

/** 2 when the name starts with the query, 1 for another match, 0 for none. */
export function searchScore(entry: CatalogEntry, query: string): number {
  if (matchesWordPrefixes(`${entry.displayName} ${entry.name}`, query)) return 2;
  const text = [
    entry.displayName,
    entry.name,
    entry.description,
    entry.category ?? "",
    entry.category ? categoryLabel(entry.category) : "",
    ...entry.keywords,
    ...entry.domains,
  ].join(" ");
  return matchesWordPrefixes(text, query) ? 1 : 0;
}
