import { t } from "../../i18n";

import { HOSTED_APP_CHANNEL } from "~/branding";
import { isElectron } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { commandLabel } from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/diagnostics"
  | "/settings/appearance"
  | "/settings/chat"
  | "/settings/diffs"
  | "/settings/keybindings"
  | "/settings/snap-shot"
  | "/settings/providers"
  | "/settings/threads"
  | "/settings/browser"
  | "/settings/devices"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/worktrees"
  | "/settings/connections"
  | "/settings/access"
  | "/settings/maintenance"
  | "/settings/labs"
  | "/settings/about"
  | "/settings/archived";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly hasMacProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly managedTunnelActive?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  get "/settings/diagnostics"() {
    return t("Diagnostics");
  },
  get "/settings/projects"() {
    return t("Projects");
  },
  get "/settings/general"() {
    return t("General");
  },
  get "/settings/appearance"() {
    return t("Appearance");
  },
  get "/settings/chat"() {
    return t("Chat");
  },
  get "/settings/diffs"() {
    return t("Diffs & pull requests");
  },
  get "/settings/keybindings"() {
    return t("Keybindings");
  },
  get "/settings/snap-shot"() {
    return t("SnapShots");
  },
  get "/settings/providers"() {
    return t("Providers");
  },
  get "/settings/threads"() {
    return t("Threads");
  },
  get "/settings/browser"() {
    return t("Browser");
  },
  get "/settings/devices"() {
    return t("Devices");
  },
  get "/settings/scheduled-tasks"() {
    return t("Scheduled tasks");
  },
  get "/settings/source-control"() {
    return t("Source control");
  },
  get "/settings/worktrees"() {
    return t("Worktrees");
  },
  get "/settings/connections"() {
    return t("Environments");
  },
  get "/settings/access"() {
    return t("Sharing & access");
  },
  get "/settings/maintenance"() {
    return t("Maintenance");
  },
  get "/settings/labs"() {
    return t("Labs");
  },
  get "/settings/about"() {
    return t("About");
  },
  get "/settings/archived"() {
    return t("Archive");
  },
};

/** Sidebar order. A group without a heading is set apart by space alone. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: string | null;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  {
    heading: null,
    paths: [
      "/settings/general",
      "/settings/appearance",
      "/settings/chat",
      "/settings/diffs",
      "/settings/keybindings",
      "/settings/snap-shot",
    ],
  },
  {
    get heading() {
      return t("Agents");
    },
    paths: [
      "/settings/providers",
      "/settings/threads",
      "/settings/browser",
      "/settings/devices",
      "/settings/scheduled-tasks",
    ],
  },
  {
    get heading() {
      return t("Code");
    },
    paths: ["/settings/projects", "/settings/source-control", "/settings/worktrees"],
  },
  {
    get heading() {
      return t("Connections");
    },
    paths: ["/settings/connections", "/settings/access"],
  },
  {
    heading: null,
    paths: ["/settings/maintenance", "/settings/labs", "/settings/about", "/settings/archived"],
  },
];

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    get title() {
      return commandLabel(command);
    },
    to: "/settings/keybindings" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: credentials
          ? t("{{label}} accounts and token", { label: definition.label })
          : t("{{label}} credentials", { label: definition.label }),
        to: "/settings/source-control" as const,
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    get title() {
      return t("Keep worktrees with local changes");
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    get title() {
      return t("Delete now");
    },
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["storage cleanup run now results report removed kept failed"],
  },
  {
    id: "storage-worktrees",
    get title() {
      return t("Worktree cleanup");
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "disk storage delete deleted archived threads old inactive merged unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    get title() {
      return t("Worktree location");
    },
    to: "/settings/worktrees",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    get title() {
      return t("Artifacts and logs");
    },
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["disk storage browser screenshots captures rotated logs cleanup retention"],
  },
  {
    id: "project-defaults",
    get title() {
      return t("Project defaults and overrides");
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    get title() {
      return t("Project overview");
    },
    to: "/settings/projects",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    get title() {
      return t("Default model");
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["new thread project provider reasoning effort"],
  },
  {
    id: "default-permissions",
    get title() {
      return t("Permissions");
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    get title() {
      return t("Color scheme");
    },
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    get title() {
      return t("Themes");
    },
    to: "/settings/appearance",
    searchTerms: ["appearance colors palette custom import"],
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    get title() {
      return t("Contrast");
    },
    to: "/settings/appearance",
    searchTerms: ["colors borders interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    get title() {
      return t("Glass opacity");
    },
    to: "/settings/appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "diff-color-scheme",
    get title() {
      return t("Diff colors");
    },
    to: "/settings/diffs",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    get title() {
      return t("Chat width");
    },
    to: "/settings/appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "thread-details-items",
    title: t("Thread details"),
    to: "/settings/appearance",
    searchTerms: [
      "customize show hide panel card environment editor scripts branch pull request git changes servers automations lineage usage limits 5 hour weekly quota tokens context window",
    ],
  },
  {
    id: "effort-display",
    title: t("Effort display"),
    to: "/settings/appearance",
    searchTerms: ["reasoning effort thinking bars graph word label level composer"],
  },
  {
    id: "math-rendering",
    get title() {
      return t("Render math");
    },
    to: "/settings/appearance",
    searchTerms: ["latex tex katex equations formulas markdown"],
  },
  {
    id: "panel-animations",
    get title() {
      return t("Panel animations");
    },
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    get title() {
      return t("Environment identification");
    },
    to: "/settings/appearance",
    searchTerms: ["dev nightly latest channel artwork pill label hide none"],
    targetId: "appearance-interface",
  },
  {
    id: "interface-font",
    get title() {
      return t("Interface font");
    },
    to: "/settings/appearance",
    searchTerms: ["typography family size system sans"],
  },
  {
    id: "prompt-font",
    get title() {
      return t("Prompt font");
    },
    to: "/settings/appearance",
    searchTerms: ["typography family size composer input"],
  },
  {
    id: "code-font",
    get title() {
      return t("Code font");
    },
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace code blocks diffs file previews"],
  },
  {
    id: "terminal-font",
    get title() {
      return t("Terminal font");
    },
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace output"],
  },
  {
    id: "separate-fonts",
    get title() {
      return t("Separate fonts");
    },
    to: "/settings/appearance",
    searchTerms: ["typography advanced prompt code terminal font family size individually"],
  },
  {
    id: "font-smoothing",
    get title() {
      return t("Font smoothing");
    },
    to: "/settings/appearance",
    searchTerms: ["typography text grayscale anti aliasing macos thin"],
    macOnly: true,
  },
  {
    id: "word-wrap",
    get title() {
      return t("Word wrap");
    },
    to: "/settings/appearance",
    searchTerms: ["long lines code blocks diffs file previews"],
  },
  {
    id: "composer-context",
    get title() {
      return t("Composer context");
    },
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    get title() {
      return t("Project grouping");
    },
    to: "/settings/general",
    searchTerms: ["combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    get title() {
      return t("Project order");
    },
    to: "/settings/general",
    searchTerms: ["sort projects sidebar manual created recent"],
  },
  {
    id: "snooze-options",
    title: t("Snooze options"),
    to: "/settings/threads",
    searchTerms: ["snooze presets times later tonight tomorrow next week remind"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "snooze-limited-threads",
    get title() {
      return t("Snooze until limits reset");
    },
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    get title() {
      return t("Resume after usage limits");
    },
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset recover continue"],
  },
  {
    id: "working-shelf",
    get title() {
      return t("Working section");
    },
    to: "/settings/general",
    searchTerms: ["hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "boring-sidebar",
    title: t("Boring sidebar (group by project)"),
    to: "/settings/labs",
    searchTerms: ["beta folders project tree legacy old classic sidebar"],
  },
  {
    id: "boring-sidebar-multiline",
    title: t("Two-line folder rows"),
    to: "/settings/labs",
    searchTerms: ["beta boring sidebar folder rows multiline branch pull request details"],
  },
  {
    id: "guest-links",
    get title() {
      return t("Guest links");
    },
    to: "/settings/labs",
    scope: "environment",
    searchTerms: ["beta share guest invite link teammate watch t3 connect tunnel"],
  },
  {
    id: "auto-settle-inactive-threads",
    get title() {
      return t("Auto-settle inactive threads");
    },
    to: "/settings/threads",
    searchTerms: ["sidebar inactivity days no activity automatically"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "auto-settle-merged-threads",
    get title() {
      return t("Auto-settle merged threads");
    },
    to: "/settings/threads",
    searchTerms: ["pull request merge closed automatically sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "keep-threads-with-pull-requests",
    get title() {
      return t("Keep threads with a PR");
    },
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["pull request inactivity auto-settle merge close sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    get title() {
      return t("Days of inactivity before auto-settle");
    },
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["thread timeout activity sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    get title() {
      return t("Thread notifications");
    },
    to: "/settings/general",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    id: "in-app-notifications",
    get title() {
      return t("In-app notifications");
    },
    to: "/settings/general",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    id: "time-format",
    get title() {
      return t("Time format");
    },
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    get title() {
      return t("Response streaming");
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "hide-whitespace-changes",
    get title() {
      return t("Hide whitespace changes");
    },
    to: "/settings/diffs",
    searchTerms: ["diff ignore spaces edits default"],
  },
  {
    id: "default-diff-file-state",
    get title() {
      return t("Default diff file state");
    },
    to: "/settings/diffs",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    get title() {
      return t("Diff layout");
    },
    to: "/settings/diffs",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    get title() {
      return t("Proactive panels");
    },
    to: "/settings/diffs",
    searchTerms: ["automatically open diff pull request pr right panel agent completion"],
  },
  {
    id: "skills-in-slash-menu",
    get title() {
      return t("Show skills in slash menu");
    },
    to: "/settings/chat",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    get title() {
      return t("Rich text composer");
    },
    to: "/settings/chat",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "send-shortcut",
    get title() {
      return t("Send shortcut");
    },
    to: "/settings/chat",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    get title() {
      return t("Follow-up behavior");
    },
    to: "/settings/chat",
    searchTerms: ["queue steer running turn send default behavior composer"],
  },
  {
    id: "provider-update-checks",
    get title() {
      return t("Provider update checks");
    },
    to: "/settings/maintenance",
    searchTerms: ["installed cli versions newer available opencode"],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    get title() {
      return t("Continue threads after restarts");
    },
    to: "/settings/maintenance",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    get title() {
      return t("Background activity");
    },
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    get title() {
      return t("New threads");
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    get title() {
      return t("Submodules");
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree t3.json"],
  },
  {
    id: "start-from-origin",
    get title() {
      return t("Start from remote");
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: ["new worktrees start remote origin latest fetched branch local"],
  },
  {
    id: "add-project-starts-in",
    get title() {
      return t("Add project starts in");
    },
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "unpin-confirmation",
    get title() {
      return t("Unpin confirmation");
    },
    to: "/settings/general",
    searchTerms: ["ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    get title() {
      return t("Archive confirmation");
    },
    to: "/settings/general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    get title() {
      return t("Delete confirmation");
    },
    to: "/settings/general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    get title() {
      return t("Quit shortcut");
    },
    to: "/settings/general",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    get title() {
      return t("Text generation model");
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles source control content default provider"],
  },
  {
    id: "thread-title-instructions",
    get title() {
      return t("Thread title instructions");
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles prompt custom style naming rename regenerate"],
  },
  {
    id: "app-version",
    get title() {
      return t("Version");
    },
    to: "/settings/about",
    searchTerms: ["about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    get title() {
      return t("Update track");
    },
    to: "/settings/about",
    searchTerms: ["release channel stable latest nightly prerelease"],
    releaseChannelOnly: true,
  },
  {
    id: "cli-command",
    get title() {
      return t("t3 command");
    },
    to: "/settings/about",
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "mobile-app",
    get title() {
      return t("Mobile app");
    },
    to: "/settings/about",
    searchTerms: ["phone tablet iPhone iPad iOS Android App Store Google Play QR"],
  },
  {
    id: "privacy-policy",
    get title() {
      return t("Privacy policy");
    },
    to: "/settings/about",
    searchTerms: ["telemetry analytics usage data tracking legal opt out"],
  },
  {
    id: "telemetry-export",
    get title() {
      return t("OpenTelemetry export");
    },
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    get title() {
      return t("Diagnostics");
    },
    to: "/settings/maintenance",
    searchTerms: ["logs traces processes resource history failures spans cpu memory"],
  },
  {
    id: "open-source-licenses",
    get title() {
      return t("Open source licenses");
    },
    to: "/settings/about",
  },
  {
    id: "legacy-plan-mode",
    get title() {
      return t("Plan mode (legacy)");
    },
    to: "/settings/labs",
    searchTerms: ["build plan composer old"],
  },
  {
    id: "legacy-context-window-indicator",
    get title() {
      return t("Context window indicator (legacy)");
    },
    to: "/settings/labs",
    searchTerms: ["composer meter usage tokens circle old"],
  },
  {
    id: "keybindings",
    get title() {
      return t("Keybindings");
    },
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "snap-shot-enabled",
    get title() {
      return t("SnapShots");
    },
    searchTerms: ["window capture screenshot"],
    to: "/settings/snap-shot",
  },
  {
    id: "snap-shot-accessibility",
    get title() {
      return t("Include app text");
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: [
      "capture accessibility data text UI structure elements privacy omit agent context",
    ],
  },
  {
    id: "snap-shot-shortcut",
    get title() {
      return t("Capture shortcut");
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-sound",
    get title() {
      return t("Capture sound");
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-flash",
    get title() {
      return t("Capture flash");
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-animations",
    get title() {
      return t("Capture animations");
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "providers",
    get title() {
      return t("Providers");
    },
    to: "/settings/providers",
    searchTerms: [
      "agents cli opencode sign in sign out install subscription instances authentication api key models configuration binary path config directory endpoint arguments environment variables display name accent color custom favorite hidden auto compact",
    ],
  },
  {
    id: "provider-health-check-interval",
    get title() {
      return t("Health check interval");
    },
    to: "/settings/providers",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    providerSettingsOnly: true,
  },
  {
    id: "agent-browser-access",
    get title() {
      return t("Agent browser access");
    },
    to: "/settings/browser",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "device-hosts",
    get title() {
      return t("Device hosts");
    },
    to: "/settings/devices",
    searchTerms: ["ssh remote simulator emulator ios android mac mini identity key connection"],
  },
  {
    id: "agent-device-access",
    get title() {
      return t("Agent device access");
    },
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: ["allow simulator emulator ios android drive tools sessions"],
  },
  {
    id: "device-hub",
    get title() {
      return t("Device hub");
    },
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: ["simulator emulator ios android install start"],
  },
  {
    id: "device-platform-support",
    get title() {
      return t("Simulator support");
    },
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: ["xcode android studio sdk avd runtime"],
  },
  {
    id: "browser-profiles",
    get title() {
      return t("Browser profiles");
    },
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    id: "browser-default-profile",
    get title() {
      return t("Default browser profile");
    },
    to: "/settings/browser",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    get title() {
      return t("Default browser viewport");
    },
    to: "/settings/browser",
    searchTerms: ["preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    get title() {
      return t("Default browser zoom");
    },
    to: "/settings/browser",
    searchTerms: ["preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    get title() {
      return t("Default browser appearance");
    },
    to: "/settings/browser",
    searchTerms: ["preview color scheme light dark system os"],
  },
  {
    id: "browser-recording-frame-rate",
    get title() {
      return t("Browser recording frame rate");
    },
    to: "/settings/browser",
  },
  {
    id: "browser-recording-key-presses",
    get title() {
      return t("Show key presses in recordings");
    },
    to: "/settings/browser",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    get title() {
      return t("Show mouse presses in recordings");
    },
    to: "/settings/browser",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
  },
  {
    id: "browser-link-target",
    get title() {
      return t("Open links in");
    },
    to: "/settings/browser",
    searchTerms: ["links default browser in-app browser external open"],
  },
  {
    id: "browser-search-engine",
    get title() {
      return t("Search engine");
    },
    to: "/settings/browser",
    searchTerms: ["address bar duckduckgo google bing brave kagi ecosia custom"],
  },
  {
    id: "pull-request-links-open-in-app",
    get title() {
      return t("Open pull requests in T3 Code");
    },
    to: "/settings/diffs",
    searchTerms: [
      `pr links ${SOURCE_CONTROL_HOST_LABELS} browser external click default pull request view panel`,
    ],
  },
  {
    id: "browser-auto-show-floating-preview",
    get title() {
      return t("Auto-show floating preview");
    },
    to: "/settings/browser",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
  },
  {
    id: "automatic-pull",
    get title() {
      return t("Automatically pull");
    },
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "remove-agent-credits-on-merge",
    get title() {
      return t("Remove agent credits when merging");
    },
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      `pull request ${SOURCE_CONTROL_HOST_LABELS} squash co-authored-by attribution generated`,
    ],
  },
  {
    id: "pull-request-merge-method",
    get title() {
      return t("Default merge method");
    },
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["pull request merge squash rebase last selected"],
  },
  {
    id: "source-control",
    get title() {
      return t("Source control");
    },
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    get title() {
      return t("Git fetch interval");
    },
    to: "/settings/maintenance",
    targetId: "background-activity",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    get title() {
      return t("Worktree branch naming");
    },
    to: "/settings/worktrees",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    get title() {
      return t("Source control writing style");
    },
    to: "/settings/source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions change descriptions request titles",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    get title() {
      return t("Follow change request templates");
    },
    to: "/settings/source-control",
    searchTerms: ["repository pr pull request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    get title() {
      return t("Source control writer model");
    },
    to: "/settings/source-control",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guides",
    get title() {
      return t("Review guides (beta)");
    },
    to: "/settings/source-control",
    searchTerms: ["pull request pr guided review guide tour beta experimental"],
    environmentOnly: true,
  },
  {
    id: "review-guide-model",
    get title() {
      return t("Review guide model");
    },
    to: "/settings/source-control",
    // Hidden until review guides are on, so a search lands on the switch that shows it.
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide brief maintainer"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guide-instructions",
    get title() {
      return t("Review guide instructions");
    },
    to: "/settings/source-control",
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide preferences taste prompt custom"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    get title() {
      return t("Actions");
    },
    to: "/settings/projects",
    searchTerms: ["commands scripts setup run dev server checkout worktree t3.json import"],
  },
  {
    id: "environment-icon",
    get title() {
      return t("Environment icon");
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    get title() {
      return t("Local environment");
    },
    to: "/settings/connections",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    get title() {
      return t("Network access");
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    get title() {
      return t("Tailscale HTTPS");
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    get title() {
      return t("WSL backend");
    },
    to: "/settings/access",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    get title() {
      return t("T3 Connect");
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["managed tunnel cloud other devices remote"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    get title() {
      return t("Hold webhooks while offline");
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["webhook automations offline queue mailbox t3 connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    get title() {
      return t("Publish agent activity");
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    get title() {
      return t("This machine");
    },
    to: "/settings/access",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
    ],
  },
  {
    id: "remote-environments",
    get title() {
      return t("Environments");
    },
    to: "/settings/connections",
    searchTerms: ["add pair backend host code ssh config agent tunnel saved t3 connect"],
  },
  {
    id: "load-balancing",
    get title() {
      return t("Load balancing");
    },
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "pull-request-routing",
    get title() {
      return t("Pull request sharing");
    },
    to: "/settings/connections",
    searchTerms: [
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
  {
    id: "archive",
    get title() {
      return t("Archived threads");
    },
    to: "/settings/archived",
    searchTerms: ["restore reopen deleted history projects"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/appearance": null,
  "/settings/chat": null,
  "/settings/diffs": null,
  "/settings/snap-shot": null,
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/threads": null,
  "/settings/browser": null,
  "/settings/devices": null,
  "/settings/source-control": "environment-defaults",
  "/settings/worktrees": "project-defaults",
  "/settings/connections": "connections",
  "/settings/access": "connections",
  "/settings/scheduled-tasks": null,
  "/settings/maintenance": null,
  "/settings/labs": null,
  "/settings/about": null,
  "/settings/archived": "project-defaults",
};

const RENAMED_SETTINGS_PATHS: Readonly<Record<string, SettingsPath>> = {
  "/settings/integrations": "/settings/browser",
  "/settings/storage": "/settings/maintenance",
  "/settings/beta": "/settings/labs",
};
const SPLIT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/source-control",
  "/settings/connections",
  ...Object.keys(RENAMED_SETTINGS_PATHS),
]);
// Section anchors that moved but are not search results themselves.
const MOVED_SECTION_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  "authorized-clients": "/settings/access",
  "legacy-features": "/settings/labs",
  "text-generation": "/settings/threads",
  about: "/settings/about",
};

/** Where an old settings link now lives. Its anchor finds the page its row moved to. */
export function movedSettingsPath(pathname: string, hash: string): SettingsPath | null {
  if (!SPLIT_SETTINGS_PATHS.has(pathname)) return null;
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = hash
    ? (items.find((item) => item.id === hash) ?? items.find((item) => item.targetId === hash))
    : undefined;
  const to =
    anchored?.to ?? MOVED_SECTION_ANCHORS[hash] ?? RENAMED_SETTINGS_PATHS[pathname] ?? null;
  return to === pathname ? null : to;
}

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected.map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.macProviderSettingsOnly || availability.hasMacProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.releaseChannelOnly || isElectron || HOSTED_APP_CHANNEL !== null) &&
      (!item.macOnly || isMacPlatform(platform)) &&
      (!item.windowsOnly || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

// These rows only exist with separate fonts on, so a search jump to one turns them on.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
]);

export function isAdvancedTypographyTarget(targetId: string): boolean {
  return ADVANCED_TYPOGRAPHY_TARGET_IDS.has(targetId);
}

/**
 * Opens the persisted section a search result lives in before jumping to it, so
 * its row is mounted to scroll to. The terminal reads the same flag, so it must
 * stay on after the jump.
 */
export function revealSettingsSearchTarget(targetId: string): void {
  if (isAdvancedTypographyTarget(targetId)) {
    writeLocalStorageValue(TYPOGRAPHY_ADVANCED_STORAGE_KEY, true, false, Schema.Boolean);
  }
}
