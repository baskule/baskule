// baskule: shared product flags for the Alpha UI and hosted front-session build.
// Upstream integration points use these flags; product behavior lives under baskule/.
export const BASKULE_UI =
  (import.meta.env as unknown as Record<string, string | undefined>).VITE_BASKULE_UI !== "0";

export const BASKULE_APP_NAME = "Baskule";

const env = import.meta.env as unknown as Record<string, string | undefined>;

/**
 * Hosted multi-user build (VITE_BASKULE_HOSTED=1): the bundle is served by the Baskule
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
