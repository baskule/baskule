export type PluginSource =
  | { type: "catalog" }
  | { type: "url"; url: string }
  | { type: "git"; repo: string; ref: string; path?: string }
  | { type: "archive"; sha256: string };
export type CredentialMode = "none" | "organization" | "user-oauth";
export interface OAuthRecipe {
  scopes?: string[];
  params?: Record<string, string>;
  resource?: false;
  resourceUrl?: string;
  staticClient?: true;
}
export interface PluginServer {
  name: string;
  url: string;
  credential: CredentialMode;
  oauth?: OAuthRecipe;
  transport?: "streamable-http" | "sse";
}
export interface Plugin {
  id: string;
  vendor: string;
  name: string;
  description: string;
  icon?: string;
  source: PluginSource;
  skills: { name: string; description: string }[];
  servers: PluginServer[];
  ignored: string[];
  enabled: boolean;
  createdAt: string;
}
export interface AdminPlugin extends Plugin {
  setup: { server: string; done: boolean }[];
  vendorConfigured: boolean;
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
export type PluginInstallInput =
  | { catalog: string; groups: string[] }
  | { source: Exclude<PluginSource, { type: "catalog" }>; archive?: string; name?: string; groups: string[] };
export interface PluginPatch {
  name?: string;
  description?: string;
  icon?: string;
  enabled?: boolean;
  servers?: (Pick<PluginServer, "name" | "credential" | "oauth"> & Partial<Pick<PluginServer, "url" | "transport">>)[];
}
export type PluginStatus = "unavailable" | "needs_setup" | "connect" | "reconnect" | "ready";
export interface MemberPlugin {
  id: string;
  name: string;
  description: string;
  icon?: string;
  skills: { name: string; description: string }[];
  status: PluginStatus;
  servers: { name: string; credential: CredentialMode; status: PluginStatus }[];
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
  servers: (PluginServer & { pluginId: string; pluginName: string; catalogUserId: string; privateNetwork: boolean })[];
  skills: { pluginId: string; name: string; description: string; files: PluginFile[] }[];
}
export type PluginCredential =
  | { headers: Record<string, string>; expiresAt: number }
  | { error: PluginCallError };

export type PluginCallError = Exclude<PluginStatus, "ready">;

export const PLUGIN_ERROR_CODES = [
  "address_not_allowed",
  "catalog_unknown",
  "catalog_not_available",
  "already_installed",
  "not_editable",
  "archive_hash_mismatch",
  "archive_required",
  "builtin_group",
  "connection_failed",
  "connection_not_allowed",
  "consent_denied",
  "duplicate_plugin_path",
  "duplicate_skill_name",
  "empty_plugin",
  "empty_plugin_archive",
  "forbidden",
  "group_exists",
  "invalid_archive",
  "invalid_authorization_metadata",
  "invalid_commit",
  "invalid_group",
  "invalid_json",
  "invalid_oauth_client",
  "invalid_oauth_code",
  "invalid_oauth_resource",
  "invalid_oauth_state",
  "invalid_oauth_token",
  "invalid_plugin_input",
  "invalid_plugin_manifest",
  "invalid_resource_metadata",
  "invalid_return_url",
  "invalid_secret_headers",
  "no_remote_servers",
  "not_found",
  "not_oauth_server",
  "not_organization_server",
  "oauth_client_configuration_required",
  "oauth_grant_expired",
  "oauth_issuer_mismatch",
  "oauth_issuer_changed",
  "vendor_unknown",
  "oauth_registration_failed",
  "oauth_resource_mismatch",
  "oauth_scope_missing",
  "oauth_unavailable",
  "plugin_links_unsupported",
  "plugin_not_found",
  "plugin_server_required",
  "plugin_skill_file_too_large",
  "plugin_source_changed",
  "plugin_source_unavailable",
  "plugin_storage_limit",
  "plugin_too_large",
  "plugin_tree_too_large",
  "proprietary_plugin",
  "too_many_plugin_files",
  "unknown_plugin_server",
  "unsafe_plugin_path",
  "unsupported_archive",
  "unsupported_git_host",
  "unsupported_plugin_version",
  "user_not_found",
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];
