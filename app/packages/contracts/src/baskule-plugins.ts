export type PluginKind = "mcp" | "skill" | "bundle";
export type PluginSource =
  | { type: "registry"; registry: string; id: string; version?: string }
  | { type: "url"; url: string }
  | { type: "git"; repo: string; ref: string; path?: string }
  | { type: "archive"; sha256: string };
export type CredentialMode = "none" | "organization" | "user-oauth" | "login-identity";
export interface PluginServer {
  name: string;
  url: string;
  credential: CredentialMode;
  personal: boolean;
  oauth?: { scopes: string[] };
  loginIdentity?: { provider: "google" | "microsoft"; scopes: string[]; audience: string };
  transport?: "streamable-http" | "sse";
}
export interface Plugin {
  id: string;
  kind: PluginKind;
  name: string;
  description: string;
  icon?: string;
  source: PluginSource;
  /** Concrete, immutable source behind a registry selection. */
  resolvedSource?: Exclude<PluginSource, { type: "registry" }>;
  skills: { name: string; description: string }[];
  servers: PluginServer[];
  ignored: string[];
  enabled: boolean;
  createdAt: string;
}
export interface Group {
  id: string;
  name: string;
  builtin?: "everyone";
  members: string[];
  permissions: { canCreateSpaces: boolean };
  plugins: string[];
}
export type GroupInput = Omit<Group, "id" | "builtin">;
export interface SpacePluginSettings {
  personalPluginsAllowed: boolean;
  disabled: string[];
}
export interface PluginSearchResult {
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  source: Extract<PluginSource, { type: "registry" }>;
  license?: string;
}
export interface PluginSearchResponse {
  results: PluginSearchResult[];
  failures: { registry: string; error: "unavailable" }[];
}
export interface PluginInstallInput {
  source: PluginSource;
  /** Base64 ZIP or tar.gz bytes, required only for archive sources; hash is verified. */
  archive?: string;
  name?: string;
}
export interface PluginPatch {
  name?: string;
  description?: string;
  icon?: string;
  enabled?: boolean;
  servers?: (Pick<PluginServer, "name" | "credential" | "personal" | "oauth" | "loginIdentity"> & Partial<Pick<PluginServer, "url" | "transport">>)[];
}
export type PluginConnectionState =
  | "connected"
  | "not_required"
  | "configured"
  | "needs_configuration"
  | "needs_connection";
export interface UserPlugin extends Plugin {
  userEnabled: boolean;
  connections: { server: string; state: PluginConnectionState }[];
}
export interface PluginSecretInput {
  server: string;
  /** null deletes the secret. Values are never returned by a public API. */
  headers: Record<string, string> | null;
}
export interface PluginFile {
  /** Relative to this skill's directory; never absolute or containing '..'. */
  path: string;
  content: string;
  encoding: "base64";
}
export interface SpacePlugins {
  /** Catalog discovery uses an allowed member; tool calls always use the turn author. */
  servers: (PluginServer & { pluginId: string; catalogUserId: string; privateNetwork: boolean })[];
  skills: { pluginId: string; name: string; description: string; files: PluginFile[] }[];
}
export type PluginCredential =
  | { headers: Record<string, string>; expiresAt: number }
  | { error: "not_allowed" | "not_enabled" | "needs_connection"; connectUrl?: string };
export type PluginUseDecision =
  | { allowed: true }
  | { allowed: false; error: "not_allowed" | "not_enabled" };
