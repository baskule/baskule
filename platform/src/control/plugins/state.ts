import type { AdminPlugin, MemberConnection, PluginCallError, PluginCategory, PluginOrigin, PluginPreview, PluginVariable, ProviderId, ServerAuth, ServerSetup } from "../../../../app/packages/contracts/src/baskule-plugins";
import { VARIABLE } from "./package";

export interface StoredServer {
  id: string;
  name: string;
  /** May hold `${VAR}` placeholders filled from the administrator's values. */
  url: string;
  transport: "streamable-http" | "sse";
  /** Header templates; never returned to clients. */
  headers: Record<string, string>;
  auth: ServerAuth;
  variables: PluginVariable[];
}

export interface StoredPlugin {
  name: string;
  displayName: string;
  description: string;
  logo: string | null;
  homepage: string | null;
  category: PluginCategory | null;
  origin: PluginOrigin;
  digest: string;
  servers: StoredServer[];
  skills: { name: string; description: string }[];
  skipped: PluginPreview["skipped"];
}

export interface SetupFacts { values: ReadonlySet<string>; clients: ReadonlySet<string>; providers: ReadonlySet<ProviderId> }

export function serverSetup(server: StoredServer, facts: SetupFacts): ServerSetup {
  const missing = server.variables.filter(v => !facts.values.has(v.name)).map(v => v.name);
  if (missing.length) return { state: "needs_values", variables: missing };
  const auth = server.auth;
  if (auth.kind === "oauth" && auth.registration === "client" && auth.issuer && !facts.clients.has(auth.issuer)) return { state: "needs_oauth_client", issuer: auth.issuer };
  if (auth.kind === "provider" && !facts.providers.has(auth.provider)) return { state: "needs_provider", provider: auth.provider };
  return { state: "ready" };
}

export function pluginStatus(enabled: boolean, setups: ServerSetup[]): AdminPlugin["status"] {
  if (!enabled) return "paused";
  return setups.every(s => s.state === "ready") ? "ready" : "needs_setup";
}

export interface ConnectionRow { state: "connected" | "expired"; account: string | null; connectedAt: number }

export function memberConnection(auth: ServerAuth, setup: ServerSetup, row: ConnectionRow | undefined): MemberConnection {
  if (setup.state !== "ready") return { state: "unavailable" };
  if (auth.kind === "none" || auth.kind === "headers") return { state: "not_required" };
  if (!row) return { state: "not_connected" };
  if (row.state === "expired") return { state: "expired" };
  return { state: "connected", account: row.account, connectedAt: new Date(row.connectedAt).toISOString() };
}

export interface CallFacts {
  user: { banned: boolean } | null;
  member: boolean;
  access: boolean;
  plugin: { enabled: boolean; ready: boolean } | null;
  server: { auth: ServerAuth } | null;
  on: boolean;
  connection: ConnectionRow | null;
}

/** Rechecked on every tool call; the turn author's own connection is the only one ever used. */
export function callDecision(facts: CallFacts): PluginCallError | null {
  if (!facts.user || facts.user.banned || !facts.member || !facts.plugin || !facts.server || !facts.access) return "not_allowed";
  if (!facts.plugin.enabled || !facts.on) return "plugin_off";
  if (!facts.plugin.ready) return "setup_incomplete";
  const kind = facts.server.auth.kind;
  if (kind === "none" || kind === "headers") return null;
  if (!facts.connection) return "sign_in_required";
  if (facts.connection.state === "expired") return "sign_in_expired";
  return null;
}

export const callMessage = (error: PluginCallError, name: string): string => ({
  plugin_off: `${name} is turned off. Turn it on in Settings → Plugins, or ask an administrator.`,
  not_allowed: "This plugin is not available to you here.",
  setup_incomplete: `An administrator needs to finish setting up ${name}.`,
  sign_in_required: `Sign in to ${name} in Settings → Plugins, then try again.`,
  sign_in_expired: `Your ${name} sign-in expired. Sign in again in Settings → Plugins, then try again.`,
  unavailable: `${name} is unavailable right now. Try again in a moment.`,
})[error];

export const fill = (template: string, values: Readonly<Record<string, string>>) => template.replace(VARIABLE, (_, name: string) => values[name] ?? "");
