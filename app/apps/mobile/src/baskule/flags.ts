/**
 * Baskule feature flags for the mobile client.
 *
 * The app keeps T3 Code's code paths; these flags only hide entry points that are outside Baskule's
 * scope (a ChatGPT-like chat app: chat list with new/archive/delete, thread view, files). Flip a flag to
 * bring an upstream feature back without touching the call sites.
 */
export const BASKULE_FLAGS = {
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
  /** Bottom tab bars (Chats/Settings); Settings opens from the header instead. */
  workspaceTabs: false,
  /** Model pickers; chats keep the model configured on the server. */
  modelSelection: false,
} as const;

/** The Settings pages Baskule ships while `extendedSettings` is off. */
const BASKULE_SETTINGS_ROUTES: ReadonlySet<string> = new Set([
  "Settings",
  "SettingsPassword",
  "SettingsAccountUsage",
  "SettingsPlugins",
  "SettingsArchive",
  "SettingsScheduledTasks",
  "SettingsScheduledTaskNew",
  "SettingsScheduledTaskEdit",
  "SettingsNotifications",
  "SettingsAppearance",
  "SettingsAbout",
  "SettingsOpenSourceLicenses",
  "SettingsOpenSourceLicense",
  "SettingsLegal",
]);

export function isMobileRouteEnabled(name: string): boolean {
  if (name.startsWith("Git") || name.startsWith("ThreadReview")) return BASKULE_FLAGS.sourceControl;
  if (name === "ThreadTerminal") return BASKULE_FLAGS.terminal;
  if (name === "ThreadDevicePreview") return BASKULE_FLAGS.devicePreviews;
  if (name === "ThreadBrowserPreview") return BASKULE_FLAGS.browser;
  if (name === "SettingsScheduledTaskBranch") return BASKULE_FLAGS.sourceControl;
  if (
    name === "SettingsScheduledTaskModel" ||
    name === "ThreadSettingsSheet" ||
    name === "NewTaskThreadSettings"
  )
    return BASKULE_FLAGS.modelSelection;
  if (name.startsWith("Settings") && !BASKULE_FLAGS.extendedSettings)
    return BASKULE_SETTINGS_ROUTES.has(name);
  if (name.startsWith("AddProject")) return BASKULE_FLAGS.projects;
  if (name === "NewTaskBranch") return BASKULE_FLAGS.sourceControl;
  return true;
}
