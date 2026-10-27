// Bindings and vars of the `baskule` Worker (platform/wrangler.json). All values are strings (celld vars).
export interface Env {
  CONTROL: DurableObjectNamespace;
  SPACE: DurableObjectNamespace;
  ASSETS: Fetcher;

  /** Comma-separated exact origins allowed for state-changing requests and WS upgrades, besides the request's own. */
  PUBLIC_ORIGINS?: string;
  /** First-boot bootstrap (ignored once an admin exists). */
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_NAME?: string;
  /** Validated installation-owned auth.json, resolved at deploy time. */
  AUTH_CONFIG?: string;
  /** Optional Better Auth secret; when empty ControlCell generates one at first boot and keeps it in its own SQLite. */
  AUTH_SECRET?: string;
  /** Sign-in rate limit (Better Auth): "0" disables it (tests). */
  AUTH_RATE_LIMIT?: string;

  COMPUTERD_URL?: string;
  COMPUTERD_TOKEN?: string;
}
