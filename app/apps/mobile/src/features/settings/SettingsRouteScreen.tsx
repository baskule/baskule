import { useGT, useMessages } from "gt-react-native";
import {
  navigationCustomizationAvailable,
  overflowNavigationTabs,
} from "../layout/workspace/navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "../layout/workspace/navigation-tabs";
import { currentWorkspaceSelections } from "../layout/workspace/workspace-selection-store";
import { rememberedSettingsPage } from "../layout/workspace/workspace-tab-navigation";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EmptyState } from "../../components/ui/EmptyState";
import { useNavigationState } from "@react-navigation/native";
import { use, type ComponentProps } from "react";
import { Platform, View } from "react-native";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection, SettingsSidebarContext } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import type { SettingsPageTarget } from "./components/settings-page-targets";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { filterSettingsSections } from "./settings-search";
import { usePaneRole } from "../../components/ui/Pane";
import { BASKULE_FLAGS } from "../../baskule/flags";
import { signOutOfBaskule, useBaskuleSession } from "../../baskule/session";
import * as Dialog from "../../components/ui/Dialog";
import { useState } from "react";
import { openBaskuleManagement } from "../../baskule/management";

export function SettingsRouteScreen() {
  const list = useSettingsListPlacement();
  return <SettingsListScreen sidebar={list.sidebar} selected={list.selected} />;
}

/** The Settings list inside a workspace shell that draws its bar, title and search itself. */
export function WorkspaceSettingsList() {
  const list = useSettingsListPlacement();
  return (
    <SettingsSidebarContext value={list.sidebar ? { selected: list.selected } : null}>
      <View className="flex-1 bg-screen">
        <SettingsListContent />
      </View>
    </SettingsSidebarContext>
  );
}

function useSettingsListPlacement() {
  const sidebar = usePaneRole() === "sidebar";
  // The page open beside the list: the route right above the Settings tab's route. While
  // another tab is open this list stays mounted, hidden, and must keep showing the page Settings
  // reopens on; otherwise returning shows it unselected for a frame before the page arrives.
  const selected = useNavigationState((state) => {
    const list = state.routes.findIndex((route) => route.name === "Settings");
    return list < 0
      ? rememberedSettingsPage(currentWorkspaceSelections())
      : (state.routes[list + 1]?.name ?? null);
  });
  return { sidebar, selected };
}

function SettingsListContent() {
  return <LocalSettingsRouteScreen />;
}

export function SettingsListScreen(props: {
  readonly sidebar: boolean;
  readonly selected: string | null;
}) {
  const gt = useGT();
  const workspace = useWorkspaceTabs();
  const environmentMenu = useSettingsEnvironmentMenu();
  return (
    <SettingsSidebarContext value={props.sidebar ? { selected: props.selected } : null}>
      <View className="flex-1 bg-screen">
        <SettingsScreen
          title={gt("Settings")}
          workspaceRoot={props.sidebar}
          menus={environmentMenu ? [environmentMenu] : []}
          search={
            workspace
              ? {
                  value: workspace.state.tabs.settings.query,
                  onChangeText: (query) =>
                    workspace.dispatch({ type: "query", tab: "settings", query }),
                  placeholder: gt("Search settings"),
                }
              : undefined
          }
        >
          <SettingsListContent />
        </SettingsScreen>
      </View>
    </SettingsSidebarContext>
  );
}

type SettingsListRow = ComponentProps<typeof SettingsRow> & { readonly id: string };

interface SettingsListSection {
  readonly title?: string;
  readonly rows: readonly SettingsListRow[];
}

function LocalSettingsRouteScreen() {
  const gt = useGT();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountRows = useBaskuleAccountRows(Object.keys(savedConnectionsById).length);
  const signOut = useSignOutRow();
  const session = useBaskuleSession();
  return (
    <SettingsList
      connections={{ title: gt("Account"), rows: accountRows }}
      trailing={session.status === "signed-in" ? [{ rows: [signOut] }] : []}
    />
  );
}

function environmentsRow(label: string, count: number): SettingsListRow {
  return {
    id: "SettingsEnvironments",
    icon: "desktopcomputer",
    label,
    value: `${count}`,
    valuePosition: "trailing",
    target: "SettingsEnvironments",
  };
}

function SettingsList(props: {
  readonly connections: SettingsListSection;
  readonly trailing?: ReadonlyArray<SettingsListSection>;
}) {
  const gt = useGT();
  const m = useMessages();
  // UIKit's scroll-edge material takes the scroll view's own color; like the chat list, match
  // the sidebar's surface so the bar doesn't darken over content at rest.
  // Grouped cards only lift off the screen surface; the drawer is as dark as they are.
  const listSurface = use(SettingsSidebarContext) ? "bg-drawer" : "bg-screen";
  const insets = useSafeAreaInsets();
  // UIKit insets the scroll view by its column's safe area, which this context can report as 0.
  const bottomSafeArea = useNativeColumnLayoutMetrics()?.safeArea.bottom ?? insets.bottom;
  const workspace = useWorkspaceTabs();
  const query = workspace?.state.tabs.settings.query ?? "";
  const overflowRows = useOverflowRows();
  const indexSections = useSettingsIndexSections();
  const sections = filterSettingsSections(
    [{ rows: overflowRows }, props.connections, ...indexSections, ...(props.trailing ?? [])],
    query,
    m,
  );

  return (
    <View collapsable={false} className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className={`flex-1 ${listSurface}`}
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          // The workspace's clearance keeps the last row above its search field and keyboard.
          paddingBottom:
            Platform.OS === "ios"
              ? Math.max(Math.max(bottomSafeArea, 18) + 18, workspace?.bottomClearance ?? 0) -
                bottomSafeArea
              : Math.max(Math.max(insets.bottom, 18) + 18, workspace?.bottomClearance ?? 0),
        }}
      >
        {sections.length ? (
          sections.map((section, index) => (
            <SettingsSection key={section.title ?? `untitled-${index}`} title={section.title}>
              {section.rows.map(({ id, ...row }) => (
                <SettingsRow key={id} {...row} />
              ))}
            </SettingsSection>
          ))
        ) : (
          <EmptyState
            variant="plain"
            title={gt("No results")}
            detail={gt("No settings match “{query}”.", { query: query.trim() })}
          />
        )}
      </ScrollView>
    </View>
  );
}

// baskule: the person, their server and what they manage natively. The server address is chosen
// on the sign-in screen: a session belongs to one server, so changing it means signing out first.
function useBaskuleAccountRows(spaceCount: number): SettingsListRow[] {
  const gt = useGT();
  const session = useBaskuleSession();
  if (session.status !== "signed-in") return [];
  const me = session.me;
  const anonymous = session.kind === "anonymous";
  const account: SettingsListRow[] = [
    {
      id: "account",
      icon: "person.crop.circle",
      label: me.user.name || gt("Signed in"),
      value: anonymous
        ? gt("Shared test workspace")
        : `${me.user.email}${me.user.role === "admin" ? ` · ${gt("admin", { $context: "account role" })}` : ""}`,
    },
    {
      id: "server",
      icon: "server.rack",
      label: me.organization.name || gt("Server"),
      value: session.serverUrl,
    },
  ];
  if (BASKULE_FLAGS.extendedSettings)
    return [...account, environmentsRow(gt("Spaces"), spaceCount)];
  if (anonymous) return account;
  return [
    ...account,
    ...(me.authentication.password
      ? [
          {
            id: "SettingsPassword",
            icon: "lock.fill" as const,
            label: gt("Change password"),
            target: "SettingsPassword" as const,
          },
        ]
      : []),
    {
      id: "SettingsAccountUsage",
      icon: "chart.bar.xaxis",
      label: gt("Usage and limits"),
      target: "SettingsAccountUsage",
    },
    {
      id: "SettingsPlugins",
      icon: "link",
      label: gt("Plugins"),
      target: "SettingsPlugins",
    },
  ];
}

function useSignOutRow(): SettingsListRow {
  const gt = useGT();
  const session = useBaskuleSession();
  const anonymous = session.status === "signed-in" && session.kind === "anonymous";
  return {
    id: "sign-out",
    icon: "arrow.right",
    label: anonymous ? gt("Disconnect") : gt("Sign out"),
    onPress: () =>
      Dialog.confirm({
        title: anonymous ? gt("Disconnect?") : gt("Sign out?"),
        message: anonymous
          ? gt("Return to server selection. The shared workspace stays on the server.")
          : gt("This phone forgets your session. Your chats stay on the server."),
        confirmText: anonymous ? gt("Disconnect") : gt("Sign out"),
        destructive: true,
        onConfirm: () => void signOutOfBaskule(),
      }),
  };
}

function useSettingsIndexSections(): SettingsListSection[] {
  const gt = useGT();
  const session = useBaskuleSession();
  const [opening, setOpening] = useState(false);
  const openAdministration = () =>
    Dialog.confirm({
      title: gt("Open administration in the browser?"),
      message: gt(
        "Administration is only available in the browser. It signs in independently and stays signed in when you sign out of this phone.",
      ),
      confirmText: gt("Open browser"),
      onConfirm: () => {
        setOpening(true);
        void openBaskuleManagement("/admin")
          .catch((error: unknown) =>
            Dialog.alert(
              gt("Could not open the browser"),
              error instanceof Error ? error.message : gt("Try again."),
            ),
          )
          .finally(() => setOpening(false));
      },
    });
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    selectedProject && scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          groupKey: selectedProject.key,
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? gt("Unavailable project"));
  const page = (
    target: SettingsPageTarget,
    icon: SettingsListRow["icon"],
    label: string,
    extra?: Pick<SettingsListRow, "disabled" | "value">,
  ): SettingsListRow => ({ id: target, icon, label, target, ...extra });
  const serverPage = (target: SettingsPageTarget, icon: SettingsListRow["icon"], label: string) =>
    page(target, icon, label, { disabled: noServerTargets });
  if (!BASKULE_FLAGS.extendedSettings) {
    const admin = session.status === "signed-in" && session.me.user.role === "admin";
    return [
      {
        title: gt("Chats"),
        rows: [
          page("SettingsScheduledTasks", "clock", gt("Scheduled tasks")),
          page("SettingsNotifications", "bell.badge", gt("Notifications")),
        ],
      },
      {
        title: gt("App"),
        rows: [
          page("SettingsAppearance", "paintbrush", gt("Appearance")),
          page("SettingsVoice", "mic", gt("Voice")),
          page("SettingsAbout", "info.circle", gt("About")),
        ],
      },
      ...(admin
        ? [
            {
              title: gt("Administration"),
              rows: [
                {
                  id: "manage-admin",
                  icon: "gearshape" as const,
                  label: gt("Administration"),
                  value: gt("Opens in the browser"),
                  disabled: opening,
                  onPress: () => openAdministration(),
                },
              ],
            },
          ]
        : []),
      { rows: [page("SettingsArchive", "archivebox", gt("Archived chats"))] },
    ];
  }
  // The same pages and groups as Settings on web, minus what mobile has no setting for.
  return [
    {
      rows: [
        page("SettingsOrganization", "gearshape", gt("General")),
        page("SettingsAppearance", "paintbrush", gt("Appearance")),
        page("SettingsVoice", "mic", gt("Voice")),
        page("SettingsFollowUp", "bubble.left.and.bubble.right", gt("Chat")),
        ...(navigationCustomizationAvailable()
          ? [page("SettingsNavigation", "line.3.horizontal", gt("Navigation tabs"))]
          : []),
        page("SettingsKeyboard", "keyboard", gt("Keyboard")),
      ],
    },
    {
      title: gt("Agents"),
      rows: [
        serverPage("SettingsProviderAccounts", "person.crop.circle", gt("Providers")),
        serverPage("SettingsThreads", "text.bubble", gt("Threads")),
        page("SettingsScheduledTasks", "clock", gt("Scheduled tasks")),
      ],
    },
    {
      title: gt("Code"),
      rows: [
        page(
          "SettingsProjectOverview",
          "folder",
          gt("Projects"),
          selectedProjectKey !== null ? { value: projectLabel } : undefined,
        ),
        serverPage(
          "SettingsEnvironmentSourceControl",
          "arrow.triangle.branch",
          gt("Source control"),
        ),
        serverPage("SettingsWorktrees", "square.on.square", gt("Worktrees")),
      ],
    },
    {
      rows: [
        serverPage("SettingsEnvironmentMaintenance", "arrow.clockwise", gt("Maintenance")),
        page("SettingsLabs", "flask", gt("Labs")),
        page("SettingsAbout", "info.circle", gt("About")),
        page("SettingsArchive", "archivebox", gt("Archive")),
      ],
    },
  ];
}

function useOverflowRows(): SettingsListRow[] {
  const m = useMessages();
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const tabs =
    Platform.OS === "android" && layout.usesSplitView ? [] : overflowNavigationTabs(order, hidden);
  const selectTab = useSelectWorkspaceTab();
  return tabs
    .filter((tab) => tab === "threads" || tab === "usage")
    .map((tab) => ({
      id: tab,
      icon: NAVIGATION_TAB_ICONS[tab],
      label: m(WORKSPACE_TAB_LABELS[tab]),
      onPress: () => selectTab(tab),
    }));
}
