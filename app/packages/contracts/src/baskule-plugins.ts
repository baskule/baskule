/** Plugin marketplaces read from GitHub. Fixed list; GitHub import covers any other repository. */
export const PLUGIN_REGISTRIES = ["anthropic", "anthropic-work", "cursor", "xai"] as const;
export type RegistryId = (typeof PLUGIN_REGISTRIES)[number];

/** Hosted app platforms an administrator can connect with their own account. Off until configured. */
export const PLUGIN_PROVIDERS = ["composio", "pipedream"] as const;
export type ProviderId = (typeof PLUGIN_PROVIDERS)[number];

export type CatalogSource = RegistryId | ProviderId;

export const PLUGIN_CATEGORIES = [
  "productivity",
  "communication",
  "sales",
  "marketing",
  "finance",
  "people",
  "design",
  "code",
  "data",
  "ops",
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/** Where an installed plugin came from. GitHub origins are pinned to the commit that was reviewed. */
export type PluginOrigin =
  | { kind: "registry"; registry: RegistryId; repo: string; path?: string; sha: string }
  | { kind: "github"; repo: string; path?: string; sha: string }
  | { kind: "custom" }
  | { kind: "provider"; provider: ProviderId; app: string };

export interface CatalogEntry {
  /** Stable across refreshes: `${source}:${repo}#${path}` for registries, `${provider}:${app}` for providers. */
  id: string;
  source: CatalogSource;
  name: string;
  displayName: string;
  description: string;
  /** Absolute https URL, pinned to a commit for registry entries. */
  logo: string | null;
  homepage: string | null;
  domains: string[];
  keywords: string[];
  category: PluginCategory | null;
  recommended: boolean;
  hasServers: boolean;
  skillCount: number;
  installedPluginId: string | null;
}

/** `GET /api/baskule/admin/catalog[?refresh=1]` */
export interface Catalog {
  entries: CatalogEntry[];
  /** Sources that failed on the last refresh; their previous entries stay listed. */
  unavailable: { source: CatalogSource; message: string }[];
  refreshedAt: string | null;
  providers: Record<ProviderId, boolean>;
}

/** A `${NAME}` placeholder in a server address or header. Header values are stored sealed. */
export interface PluginVariable {
  name: string;
  description?: string;
  secret: boolean;
  where: "url" | "header";
}

/** How members authenticate to one server. Detected when the plugin is previewed. */
export type ServerAuth =
  | { kind: "none" }
  /** Organization-wide header values the administrator provides once. */
  | { kind: "headers"; headers: string[] }
  /**
   * Each member signs in. `registration: "client"` means the authorization server refuses
   * dynamic registration, so an administrator registers one client for `issuer` first.
   * `issuer` is null when discovery failed at preview; sign-in retries discovery.
   */
  | { kind: "oauth"; issuer: string | null; registration: "dynamic" | "client" }
  /** Each member connects an account on the provider's hosted page. */
  | { kind: "provider"; provider: ProviderId; app: string };

export interface ServerPreview {
  name: string;
  url: string;
  transport: "streamable-http" | "sse";
  auth: ServerAuth;
  variables: PluginVariable[];
}

export type SkippedKind =
  | "local_program"
  | "editor_only"
  | "invalid_server"
  | "invalid_skill"
  | "unsupported_transport"
  /** The publisher left the address empty for each team to fill in, e.g. a pack's optional Gmail slot. */
  | "blank_server";

export interface PluginPreview {
  name: string;
  displayName: string;
  description: string;
  logo: string | null;
  homepage: string | null;
  category: PluginCategory | null;
  origin: PluginOrigin;
  /** Content digest; install fails with `plugin_changed` if the source no longer matches. */
  digest: string;
  servers: ServerPreview[];
  skills: { name: string; description: string; files: number }[];
  skipped: { kind: SkippedKind; subject: string }[];
}

export type PluginRef =
  | { kind: "catalog"; entryId: string }
  | { kind: "github"; url: string }
  | { kind: "custom"; server: CustomServerInput };

export interface CustomServerInput {
  displayName: string;
  description?: string;
  url: string;
  auth: "none" | "oauth" | "header";
  /** Required when `auth` is "header", e.g. `Authorization` or `X-API-Key`. */
  headerName?: string;
}

export type PluginAccess = { kind: "everyone" } | { kind: "groups"; groups: string[] };

/** Values keyed by server name, then variable name. Header values are sealed at rest. */
export type PluginValues = Record<string, Record<string, string>>;

/** `POST /api/baskule/admin/plugins/preview` */
export interface PluginPreviewRequest {
  ref: PluginRef;
}

/** `POST /api/baskule/admin/plugins` */
export interface PluginInstallRequest {
  ref: PluginRef;
  digest: string;
  access: PluginAccess;
  values: PluginValues;
  /** Names of the previewed servers to keep; omitted keeps every server. Packs list alternatives, e.g. several CRMs. */
  servers?: string[];
}

/** `PATCH /api/baskule/admin/plugins/:id`; omitted fields are unchanged. */
export interface PluginUpdateRequest {
  enabled?: boolean;
  access?: PluginAccess;
  values?: PluginValues;
}

export type ServerSetup =
  | { state: "ready" }
  | { state: "needs_values"; variables: string[] }
  | { state: "needs_oauth_client"; issuer: string }
  | { state: "needs_provider"; provider: ProviderId };

export interface AdminServer {
  id: string;
  name: string;
  url: string;
  auth: ServerAuth;
  variables: (PluginVariable & { set: boolean })[];
  setup: ServerSetup;
  connectedMembers: number;
}

export interface AdminPlugin {
  id: string;
  name: string;
  displayName: string;
  description: string;
  logo: string | null;
  homepage: string | null;
  category: PluginCategory | null;
  origin: PluginOrigin;
  /** False while an administrator has paused the plugin for everyone. */
  enabled: boolean;
  access: PluginAccess;
  servers: AdminServer[];
  skills: { name: string; description: string }[];
  installedAt: string;
  installedBy: string | null;
  /** "needs_setup" while any server's setup is not ready. */
  status: "ready" | "needs_setup" | "paused";
}

/** One pre-registered OAuth client per authorization server, shared by every plugin that uses it. */
export interface OAuthClientSetup {
  issuer: string;
  configured: boolean;
  clientId: string | null;
  hasSecret: boolean;
  scopes: string | null;
  authorizationParams: string | null;
  /** The redirect URI to register with the vendor. Shown before any field is filled. */
  callbackUrl: string;
  /** Server hosts that sign in through this issuer, e.g. `gmailmcp.googleapis.com`. */
  hosts: string[];
  usedBy: { pluginId: string; displayName: string }[];
}

/** `PUT /api/baskule/admin/oauth-clients`; an omitted secret keeps the stored one. */
export interface OAuthClientInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  authorizationParams?: string;
}

/** Authorization parameters an issuer needs for refresh tokens, applied when the admin leaves them empty. */
export const ISSUER_DEFAULT_PARAMS: Record<string, string> = {
  "https://accounts.google.com": "access_type=offline&prompt=consent",
};

export type ProviderSettings = {
  composio: { configured: boolean };
  pipedream: {
    configured: boolean;
    projectId: string | null;
    environment: "production" | "development" | null;
  };
};

/** `PUT /api/baskule/admin/plugin-providers/:provider`; credentials are verified before they are stored. */
export type ProviderInput =
  | { provider: "composio"; apiKey: string }
  | {
      provider: "pipedream";
      clientId: string;
      clientSecret: string;
      projectId: string;
      environment: "production" | "development";
    };

/** `GET /api/baskule/admin/plugins` */
export interface AdminPluginList {
  plugins: AdminPlugin[];
  oauthClients: OAuthClientSetup[];
  providers: ProviderSettings;
}

export type MemberConnection =
  | { state: "not_required" }
  | { state: "not_connected" }
  | { state: "connected"; account: string | null; connectedAt: string }
  | { state: "expired" }
  /** The administrator has not finished this server's setup. */
  | { state: "unavailable" };

export interface MemberPlugin {
  id: string;
  displayName: string;
  description: string;
  logo: string | null;
  category: PluginCategory | null;
  /** The member's own switch. Defaults to on. */
  on: boolean;
  /** False while paused by an administrator. */
  enabled: boolean;
  servers: { id: string; name: string; connection: MemberConnection }[];
  skillCount: number;
}

/** `GET /api/baskule/plugins` */
export interface MemberPluginList {
  plugins: MemberPlugin[];
}

/** `PUT /api/baskule/plugins/:id` */
export interface MemberPluginUpdate {
  on: boolean;
}

/** Runtime payload in `/_baskule/settings`: what the agent of one space can use. */
export interface SpacePlugins {
  servers: {
    pluginId: string;
    serverId: string;
    name: string;
    displayName: string;
    listAs: string | null;
  }[];
  skills: PluginFile[];
}

export interface PluginFile {
  path: string;
  base64: string;
}

/** `POST /_baskule/plugin-credential` */
export interface PluginCredentialRequest {
  spaceId: string;
  userId: string;
  pluginId: string;
  serverId: string;
}

export type PluginCredential =
  | {
      ok: true;
      url: string;
      headers: Record<string, string>;
      network: "public" | "private";
      transport: ServerPreview["transport"];
    }
  | { ok: false; error: PluginCallError; message: string };

export type PluginCallError =
  | "plugin_off"
  | "not_allowed"
  | "setup_incomplete"
  | "sign_in_required"
  | "sign_in_expired"
  | "unavailable";

export const PLUGIN_ERROR_CODES = [
  "invalid_request",
  "plugin_not_found",
  "server_not_found",
  "plugin_changed",
  "plugin_exists",
  "plugin_empty",
  "plugin_too_large",
  "source_unreadable",
  "source_not_github",
  "invalid_server",
  "missing_values",
  "invalid_oauth_client",
  "oauth_client_required",
  "oauth_failed",
  "provider_not_configured",
  "provider_rejected",
  "provider_unavailable",
  "group_not_found",
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];
