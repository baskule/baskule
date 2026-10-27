// baskule: single switchboard for the Baskule Alpha 0.1 UI patches.
// Every upstream file touched by Baskule carries an `// baskule:` comment and
// consults this module, so the whole UI reduction can be reviewed (grep
// "baskule:") and reverted (flip BASKULE_UI to false) in one place.
// Strategy: configuration first, prune later — upstream code is hidden, never deleted.

/** Master switch. Build with VITE_BASKULE_UI=0 to get the upstream T3 Code UI back. */
export const BASKULE_UI =
  (import.meta.env as unknown as Record<string, string | undefined>).VITE_BASKULE_UI !== "0";

export const BASKULE_APP_NAME = "Baskule";
export const BASKULE_UPSTREAM_CREDIT = "Based on T3 Code (MIT)";
export const BASKULE_UPSTREAM_URL = "https://github.com/pingdotgg/t3code";

const env = import.meta.env as unknown as Record<string, string | undefined>;

/**
 * Alpha 0.2 multi-user build (VITE_BASKULE_HOSTED=1): the bundle is served by the Baskule
 * front, signs in with Better Auth and connects to one environment per space at `/s/<id>/`.
 * There is no primary environment (T3's "hosted" mode).
 */
export const BASKULE_HOSTED = BASKULE_UI && env.VITE_BASKULE_HOSTED === "1";

/** Individual switches; all derive from the master switch for now. */
export const baskule = {
  /** First-run wizard is never shown (B7). */
  skipFirstRun: BASKULE_UI,
  /** Sidebar: chat rows (pinned first, drag to reorder), New → scratch project, no settle/PR/branch. */
  flatChatSidebar: BASKULE_UI,
  /** Chat: no branch/worktree/diff/terminal/PR/mode/plan/editor/usage chrome. */
  plainChat: BASKULE_UI,
  /** No settings entry points, cloud/T3 Connect/sign-in, telemetry consent. */
  hideSettings: BASKULE_UI,
  /** Hosted multi-user mode (login, spaces as environments, admin). */
  hosted: BASKULE_HOSTED,
  /** Hidden folders in the files tree. */
  hiddenFileTreeEntries: (BASKULE_UI ? [".playwright-mcp"] : []) as readonly string[],
} as const;
