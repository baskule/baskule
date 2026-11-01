/**
 * Baskule feature flags for the mobile client (architecture D12/D13).
 *
 * The app keeps T3 Code's code paths; these flags only hide entry points that are outside the alpha's
 * scope (a ChatGPT-like chat app: chat list with new/archive/delete, thread view, files). Flip a flag to
 * bring an upstream feature back without touching the call sites.
 */
export const BASKULE_FLAGS = {
  /** Pull requests tab, PR sheets and PR links. */
  pullRequests: false,
  /** Git branch/commit/worktree controls and diffs/review. */
  sourceControl: false,
  /** Thread terminal. */
  terminal: false,
  devicePreviews: false,
  browser: true,
  /** Settings pages other than the server connection (environments), appearance and about/licences. */
  extendedSettings: false,
  /** Project picker / add-project flows; new chats always go to the scratch ("No project") project. */
  projects: false,
  /** Runtime (approval/execution) mode picker in the thread settings sheet; the web hides it too. */
  executionModes: false,
} as const;

export function isMobileRouteEnabled(name: string): boolean {
  if (name.startsWith("PullRequest") || name === "ThreadPullRequests")
    return BASKULE_FLAGS.pullRequests;
  if (name.startsWith("Git") || name.startsWith("ThreadReview")) return BASKULE_FLAGS.sourceControl;
  if (name === "ThreadTerminal") return BASKULE_FLAGS.terminal;
  if (name === "ThreadDevicePreview") return BASKULE_FLAGS.devicePreviews;
  if (name === "ThreadBrowserPreview") return BASKULE_FLAGS.browser;
  return true;
}
