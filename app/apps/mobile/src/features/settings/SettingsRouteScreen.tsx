import { useTranslation, t } from "../../i18n";

import {
  navigationCustomizationAvailable,
  overflowNavigationTabs,
} from "../workspace/navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "../workspace/navigation-tabs";
import { currentWorkspaceSelections } from "../workspace/workspace-selection-store";
import { rememberedSettingsPage } from "../workspace/workspace-tab-navigation";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { use, type ComponentProps } from "react";
import { Platform, View } from "react-native";
import { useWorkspaceSurface } from "../workspace/useWorkspaceSurface";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection, SettingsSidebarContext } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import type { SettingsPageTarget } from "./components/settings-page-targets";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { filterSettingsSections } from "./settings-search";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { BASKULE_FLAGS } from "../../baskule/flags";
import { signOutOfBaskule, useBaskuleSession } from "../../baskule/session";
import * as Dialog from "../../components/ui/Dialog";
import { useState } from "react";
import type { BaskuleManagementDestination } from "@t3tools/contracts/baskule";
import { openBaskuleManagement } from "../../baskule/management";

export function SettingsRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const inSidebar = use(NativePrimaryColumnContext) !== null && layout.usesSplitView;
  // The page open beside the list: the route right above the Settings tab's route. While
  // another tab is open this list stays mounted, hidden, and must keep showing the page Settings
  // reopens on; otherwise returning shows it unselected for a frame before the page arrives.
  const selected = useNavigationState((state) => {
    const list = state.routes.findIndex((route) => route.name === "Settings");
    return list < 0
      ? rememberedSettingsPage(currentWorkspaceSelections())
      : (state.routes[list + 1]?.name ?? null);
  });
  return <SettingsListScreen sidebar={inSidebar} selected={selected} />;
}

export function SettingsListScreen(props: {
  readonly sidebar: boolean;
  readonly selected: string | null;
}) {
  const t = useTranslation();
  const surface = useWorkspaceSurface();
  const workspace = useWorkspaceTabs();
  const inSidebar = props.sidebar;
  const selected = props.selected;
  const sidebar = inSidebar ? { selected } : null;
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <SettingsSidebarContext value={sidebar}>
      <View className={`flex-1 ${inSidebar ? surface.className : "bg-screen"}`}>
        <SettingsEnvironmentFilterHeader />
        {Platform.OS === "android" ? (
          <SettingsScreen
            title={t("Settings")}
            workspaceRoot={inSidebar}
            trailing={<AndroidSettingsEnvironmentFilter />}
            search={
              workspace
                ? {
                    value: workspace.state.tabs.settings.query,
                    onChangeText: (query) =>
                      workspace.dispatch({ type: "query", tab: "settings", query }),
                    placeholder: t("Search settings"),
                  }
                : undefined
            }
          >
            {content}
          </SettingsScreen>
        ) : (
          content
        )}
      </View>
    </SettingsSidebarContext>
  );
}

type SettingsListRow = ComponentProps<typeof SettingsRow> & { readonly id: string };

interface SettingsListSection {
  readonly title?: string;
  readonly rows: readonly SettingsListRow[];
}

function ConfiguredSettingsRouteScreen() {
  const t = useTranslation();
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountLabel = !isLoaded
    ? "Checking"
    : !isSignedIn
      ? "Sign in"
      : (user?.primaryEmailAddress?.emailAddress ?? "Signed in");

  return (
    <SettingsList
      connections={{
        title: t("Connections"),
        rows: [
          {
            id: "account",
            icon: "person.crop.circle",
            label: t("T3 Account"),
            value: accountLabel,
            disabled: !isLoaded,
            onPress: () => navigation.navigate("SettingsAuth"),
          },
          environmentsRow(t("Environments"), Object.keys(savedConnectionsById).length),
          {
            id: "SettingsNotifications",
            icon: "bell.badge",
            label: t("Notifications"),
            target: "SettingsNotifications",
          },
        ],
      }}
    />
  );
}

function LocalSettingsRouteScreen() {
  const t = useTranslation();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountRows = useBaskuleAccountRows(Object.keys(savedConnectionsById).length);
  return <SettingsList connections={{ title: t("Account"), rows: accountRows }} />;
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

function SettingsList(props: { readonly connections: SettingsListSection }) {
  const t = useTranslation();
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
    [{ rows: overflowRows }, props.connections, ...indexSections],
    query,
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
            title={t("No results")}
            detail={t("No settings match “{{query}}”.", { query: query.trim() })}
          />
        )}
      </ScrollView>
    </View>
  );
}

// baskule: the account (server, person, spaces) and sign-out. The server address is chosen on the
// sign-in screen: a session belongs to one server, so changing it means signing out first.
function useBaskuleAccountRows(spaceCount: number): SettingsListRow[] {
  const session = useBaskuleSession();
  if (session.status !== "signed-in") return [];
  const me = session.me;
  const anonymous = me?.authentication.mode === "anonymous";
  return [
    {
      id: "account",
      icon: "person.crop.circle",
      label: me?.user.name ?? t("Signed in"),
      value: anonymous
        ? t("Shared test workspace")
        : me
          ? `${me.user.email}${me.user.role === "admin" ? ` · ${t("admin")}` : ""}`
          : undefined,
    },
    {
      id: "server",
      icon: "server.rack",
      label: me?.organization.name ?? t("Server"),
      value: session.serverUrl,
    },
    environmentsRow(t("Spaces"), spaceCount),
    {
      id: "sign-out",
      icon: "arrow.right",
      label: anonymous ? t("Disconnect") : t("Sign out"),
      onPress: () =>
        Dialog.confirm({
          title: anonymous ? t("Disconnect?") : t("Sign out?"),
          message: anonymous
            ? t("Return to server selection. The shared workspace stays on the server.")
            : t("This phone forgets your session. Your chats stay on the server."),
          confirmText: anonymous ? t("Disconnect") : t("Sign out"),
          destructive: true,
          onConfirm: () => void signOutOfBaskule(),
        }),
    },
  ];
}

function useSettingsIndexSections(): SettingsListSection[] {
  const session = useBaskuleSession();
  const [opening, setOpening] = useState(false);
  const open = (destination: BaskuleManagementDestination) =>
    Dialog.confirm({
      title: t("Open in browser?"),
      message: t(
        "Manage your Baskule account in the browser. It signs in independently and stays signed in when you sign out of this phone.",
      ),
      confirmText: t("Open browser"),
      onConfirm: () => {
        setOpening(true);
        void openBaskuleManagement(destination)
          .catch((error: unknown) =>
            Dialog.alert(
              t("Could not open settings"),
              error instanceof Error ? error.message : t("Try again."),
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
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  const page = (
    target: SettingsPageTarget,
    icon: SettingsListRow["icon"],
    label: string,
    extra?: Pick<SettingsListRow, "disabled" | "value">,
  ): SettingsListRow => ({ id: target, icon, label, target, ...extra });
  const serverPage = (target: SettingsPageTarget, icon: SettingsListRow["icon"], label: string) =>
    page(target, icon, label, { disabled: noServerTargets });
  // baskule: the rest is read-only app info.
  if (!BASKULE_FLAGS.extendedSettings) {
    return [
      {
        title: t("Manage in browser"),
        rows: [
          {
            id: "manage-account",
            icon: "person.crop.circle",
            label: t("Change password"),
            disabled: opening,
            onPress: () => open("/settings/password"),
          },
          {
            id: "manage-spaces",
            icon: "desktopcomputer",
            label: t("Manage spaces"),
            disabled: opening,
            onPress: () => open("/settings/spaces"),
          },
          {
            id: "manage-plugins",
            icon: "link",
            label: t("Plugins and connected accounts"),
            disabled: opening,
            onPress: () => open("/settings/plugins"),
          },
          {
            id: "manage-usage",
            icon: "chart.bar.xaxis",
            label: t("Usage and limits"),
            disabled: opening,
            onPress: () => open("/settings/usage"),
          },
          ...(session.status === "signed-in" && session.me.user.role === "admin"
            ? [
                {
                  id: "manage-admin",
                  icon: "gearshape" as const,
                  label: t("Administration"),
                  disabled: opening,
                  onPress: () => open("/admin"),
                },
              ]
            : []),
        ],
      },
      {
        title: t("Chats"),
        rows: [
          page("SettingsArchive", "archivebox", t("Archived chats")),
          page("SettingsScheduledTasks", "clock", t("Scheduled tasks")),
          page("SettingsNotifications", "bell.badge", t("Notifications")),
        ],
      },
      {
        title: t("App"),
        rows: [
          page("SettingsAppearance", "gearshape", t("General")),
          page("SettingsAbout", "info.circle", t("About")),
        ],
      },
    ];
  }
  // The same pages and groups as Settings on web, minus what mobile has no setting for.
  return [
    {
      rows: [
        page("SettingsOrganization", "gearshape", t("General")),
        page("SettingsAppearance", "paintbrush", t("Appearance")),
        page("SettingsFollowUp", "bubble.left.and.bubble.right", t("Chat")),
        ...(navigationCustomizationAvailable()
          ? [page("SettingsNavigation", "line.3.horizontal", t("Navigation tabs"))]
          : []),
        ...(Platform.OS === "ios"
          ? [
              page("SettingsKeyboard", "keyboard", t("Keyboard")),
              page("SettingsMicrophone", "mic", t("Microphone")),
            ]
          : []),
      ],
    },
    {
      title: t("Agents"),
      rows: [
        serverPage("SettingsProviderAccounts", "person.crop.circle", t("Providers")),
        serverPage("SettingsThreads", "text.bubble", t("Threads")),
        page("SettingsScheduledTasks", "clock", t("Scheduled tasks")),
      ],
    },
    {
      title: t("Code"),
      rows: [
        page(
          "SettingsProjectOverview",
          "folder",
          t("Projects"),
          selectedProjectKey !== null ? { value: projectLabel } : undefined,
        ),
        serverPage(
          "SettingsEnvironmentSourceControl",
          "arrow.triangle.branch",
          t("Source control"),
        ),
        serverPage("SettingsWorktrees", "square.on.square", t("Worktrees")),
      ],
    },
    {
      rows: [
        serverPage("SettingsEnvironmentMaintenance", "arrow.clockwise", t("Maintenance")),
        page("SettingsLabs", "sparkles", t("Labs")),
        page("SettingsAbout", "info.circle", t("About")),
        page("SettingsArchive", "archivebox", t("Archive")),
      ],
    },
  ];
}

function useOverflowRows(): SettingsListRow[] {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const tabs =
    Platform.OS === "android" && layout.usesSplitView ? [] : overflowNavigationTabs(order, hidden);
  const selectTab = useSelectWorkspaceTab();
  return tabs.map((tab) => ({
    id: tab,
    icon: NAVIGATION_TAB_ICONS[tab],
    label: WORKSPACE_TAB_LABELS[tab],
    onPress: () => selectTab(tab),
  }));
}
