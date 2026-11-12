// Bindings and vars of the `baskule` Worker (platform/wrangler.json). All values are strings (celld vars).
export interface Env {
  CONTROL: DurableObjectNamespace;
  SPACE: DurableObjectNamespace;

  /** Comma-separated exact origins allowed for state-changing requests and WS upgrades, besides the request's own. */
  PUBLIC_ORIGINS?: string;
  /** First-boot bootstrap (ignored once an admin exists). */
  SETUP_TOKEN?: string;
  /** Validated installation-owned auth.json, resolved at deploy time. */
  AUTH_CONFIG?: string;
  /** Optional Better Auth secret; when empty ControlCell generates one at first boot and keeps it in its own SQLite. */
  AUTH_SECRET?: string;
  /** Sign-in rate limit (Better Auth): "0" disables it (tests). */
  AUTH_RATE_LIMIT?: string;

  COMPUTERD_URL?: string;
  COMPUTERD_TOKEN?: string;
}

/** The public asset worker forwards backend routes through celld's native service binding. */
export interface WebEnv {
  ASSETS: Fetcher;
  BACKEND: Fetcher;
}
