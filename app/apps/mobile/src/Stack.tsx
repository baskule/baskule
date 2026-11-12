import { t, useTranslation } from "./i18n";
import { BASKULE_FLAGS, isMobileRouteEnabled } from "./baskule/flags";

import { isDraftThreadRoute } from "./features/threads/thread-route-state";
import { ComponentCatalogScreen } from "./features/development/ComponentCatalogScreen";

import { createWorkspaceStackNavigator } from "./features/layout/createWorkspaceStackNavigator";
import {
  createPathConfigForStaticNavigation,
  getPathFromState,
  NavigationState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import { createNativeStackScreen } from "@react-navigation/native-stack";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "./components/ui/AppText";
import { androidWorkspaceDestinationAnimation } from "./lib/android-workspace-navigation";
import { getCompactBrandHeaderOptions } from "./features/layout/workspace/brand-header-options";
import { WorkspaceConnectionStatusProvider } from "./features/home/WorkspaceConnectionTitle";
import { WorkspaceRootScreen } from "./features/layout/workspace/WorkspaceRootScreen";
import {
  recordHomeFocus,
  recordHomeTransitionEnd,
  recordHomeTransitionStart,
} from "./features/home/home-route-visibility";
import { AndroidWorkspaceTabsProvider } from "./features/layout/workspace/AndroidWorkspaceTabsProvider";

import {
  RenderErrorBoundary,
  RenderFailureView,
  type RenderFailureProps,
} from "./components/RenderErrorBoundary";
import { ArchivedThreadsRouteScreen } from "./features/archive/ArchivedThreadsRouteScreen";
import { ConnectOnboardingRouteScreen } from "./features/cloud/ConnectOnboardingRouteScreen";
import { AttachmentFileScreen } from "./features/files/AttachmentFileScreen";
import { ThreadFilesTreeScreen, ThreadFileScreen } from "./features/files/ThreadFilesRouteScreen";
import { AdaptiveWorkspaceLayout } from "./features/layout/AdaptiveWorkspaceLayout";
import {
  HardwareKeyboardCommandOverlay,
  HardwareKeyboardCommandProvider,
} from "./features/keyboard/HardwareKeyboardCommandProvider";
import { ReviewCommentComposerSheet } from "./features/review/ReviewCommentComposerSheet";
import { ReviewSheet } from "./features/review/ReviewSheet";
import { ThreadTerminalRouteScreen } from "./features/terminal/ThreadTerminalRouteScreen";
import { DevicePreviewRouteScreen } from "./features/devices/DevicePreviewRouteScreen";
import { BrowserPreviewRouteScreen } from "./features/browser/BrowserPreviewRouteScreen";
import { GitBranchesSheet } from "./features/threads/git/GitBranchesSheet";
import { GitCommitSheet } from "./features/threads/git/GitCommitSheet";
import { GitConfirmSheet } from "./features/threads/git/GitConfirmSheet";
import { GitOverviewSheet } from "./features/threads/git/GitOverviewSheet";

import { ThreadAgentsSheet } from "./features/threads/ThreadAgentsSheet";
import { ThreadBackgroundWorkSheet } from "./features/threads/ThreadBackgroundWorkSheet";
import { ThreadQueueSheet } from "./features/threads/ThreadQueueControl";
import {
  FullscreenThreadRouteScreen,
  ThreadRouteScreen,
} from "./features/threads/ThreadRouteScreen";
import { McpAppFullscreenScreen } from "./features/threads/McpAppFullscreenScreen";
import { ConnectionsRouteScreen } from "./features/connection/ConnectionsRouteScreen";
import { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import { AddProjectDestinationRoute } from "./features/projects/AddProjectDestinationRoute";
import { AddProjectLocalRoute } from "./features/projects/AddProjectLocalRoute";
import { AddProjectNewRoute } from "./features/projects/AddProjectNewRoute";
import { AddProjectRepositoryRoute } from "./features/projects/AddProjectRepositoryRoute";
import { AddProjectSourceRoute } from "./features/projects/AddProjectSourceRoute";
import {
  NewTaskBranchPickerRouteScreen,
  NewTaskEnvironmentPickerRouteScreen,
} from "./features/threads/NewTaskContextPickerScreens";
import {
  ExistingThreadSettingsRouteScreen,
  NewTaskThreadSettingsRouteScreen,
} from "./features/threads/ThreadSettingsSheet";
import { NewTaskFlowProvider } from "./features/threads/new-task-flow-provider";
import { newTaskFlowKey } from "./features/threads/new-task-flow-state";
import { NewTaskRouteScreen } from "./features/threads/NewTaskRouteScreen";
import { SettingsNavigationRouteScreen } from "./features/settings/SettingsNavigationRouteScreen";
import { SettingsAppearanceRouteScreen } from "./features/settings/SettingsAppearanceRouteScreen";
import { SettingsClientStorageRouteScreen } from "./features/settings/SettingsClientStorageRouteScreen";
import { SettingsDiagnosticsRouteScreen } from "./features/diagnostics/SettingsDiagnosticsRouteScreen";
import { SettingsProviderAccountsRouteScreen } from "./features/settings/SettingsProviderAccountsRouteScreen";
import { SettingsAuthRouteScreen } from "./features/settings/SettingsAuthRouteScreen";
import { SettingsEnvironmentDetailRouteScreen } from "./features/settings/SettingsEnvironmentDetailRouteScreen";
import { SettingsEnvironmentsRouteScreen } from "./features/settings/SettingsEnvironmentsRouteScreen";
import { SettingsFollowUpRouteScreen } from "./features/settings/SettingsFollowUpRouteScreen";
import {
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsThreadsRouteScreen,
  SettingsWorktreesRouteScreen,
  SettingsEnvironmentSourceControlRouteScreen,
} from "./features/settings/SettingsServerControlsRouteScreen";
import {
  SettingsScheduledTasksRouteScreen,
  SettingsScheduledTaskNewRouteScreen,
  SettingsScheduledTaskEditRouteScreen,
} from "./features/settings/SettingsScheduledTasksRouteScreen";
import {
  ScheduledTaskModelPickerRouteScreen,
  ScheduledTaskBranchPickerRouteScreen,
  ScheduledTaskThreadPickerRouteScreen,
} from "./features/settings/ScheduledTaskPickerScreens";
import { SettingsKeyboardRouteScreen } from "./features/settings/SettingsKeyboardRouteScreen";
import { SettingsLegalRouteScreen } from "./features/settings/SettingsLegalRouteScreen";
import { SettingsVoiceRouteScreen } from "./features/settings/SettingsVoiceRouteScreen";
import {
  SettingsOpenSourceLicenseRouteScreen,
  SettingsOpenSourceLicensesRouteScreen,
} from "./features/settings/SettingsOpenSourceLicensesRouteScreen";
import { SettingsProjectGroupingRouteScreen } from "./features/settings/SettingsProjectGroupingRouteScreen";
import { SettingsProjectOverviewRouteScreen } from "./features/settings/SettingsProjectOverviewRouteScreen";
import { UsageLimitAccountScreen } from "./features/usage/UsageLimitsPooled";
import { UsageRouteScreen } from "./features/usage/UsageRouteScreen";
import { SettingsAboutRouteScreen } from "./features/settings/SettingsAboutRouteScreen";
import {
  SettingsAccountUsageRouteScreen,
  SettingsPasswordRouteScreen,
  SettingsPluginsRouteScreen,
} from "./features/settings/BaskuleAccountSettingsScreens";
import { SettingsNotificationsRouteScreen } from "./features/settings/SettingsNotificationsRouteScreen";
import { SettingsRouteScreen } from "./features/settings/SettingsRouteScreen";
import { SettingsLabsRouteScreen } from "./features/settings/ThreadSettingsSections";
import { SettingsEnvironmentFilterProvider } from "./features/settings/settings-environment-filter";
import { openSettings, settingsOpenIn } from "./features/settings/settings-navigation";
import { DEFAULT_SETTINGS_PAGE } from "./features/layout/workspace/workspace-tab-navigation";
import {
  isWorkspaceOverlayRoute,
  registerPresentedRoutes,
} from "./features/layout/workspace-overlay-routes";
import { ShowcaseReadyMarker } from "./features/showcase/ShowcaseCaptureCoordinator";
import { immersiveRoute, modalRoute, pageRoute, sheetRoute } from "./features/layout/route-options";
import { deriveLayout } from "./lib/layout";
import { useNativeLayoutMetrics } from "./native/native-layout-metrics";
import { isPresentedRoute } from "./native/workspace-stack-projection";
import { workspaceDetailRouter } from "./features/layout/workspace/workspace-detail-selection";

const settingsPage = (title: string) => ({
  ...pageRoute({ title, itemStyle: "standard" }),
  get title() {
    return t(title);
  },
});

// Thread settings keep the Duo's vertical bar so cancel, search, filter and confirm sit in the
// rail. The picker stack spans the sheet so its header reaches the rail, and insets its content.
const THREAD_SETTINGS_ROUTE = sheetRoute({
  detent: "full",
  header: "none",
  android: "card",
  spansRail: true,
});

// Search sheets push on Android like the branch picker; a formSheet there leaves the list's
// header peeking above it once the keyboard opens.
const SEARCH_SHEET_ROUTE = sheetRoute({ detent: 0.75, android: "card", itemStyle: "editor" });

const SETTINGS_SCREENS = {
  Settings: createNativeStackScreen({
    if: () => isMobileRouteEnabled("Settings"),
    screen: SettingsRouteScreen,
    linking: "settings",
    options: {
      ...pageRoute({ itemStyle: "standard" }),
      get title() {
        return t("Settings");
      },
      ...(Platform.OS === "android" && BASKULE_FLAGS.workspaceTabs
        ? { animation: "none" as const }
        : {}),
      // Android draws its own app bar here. Hidden only from inside the screen, the native one
      // showed for the first frame of the Settings tab and pushed the page down.
      headerShown: Platform.OS !== "android",
      headerBackVisible: false,
    },
  }),
  SettingsPassword: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsPassword"),
    screen: SettingsPasswordRouteScreen,
    linking: "settings/password",
    options: {
      ...pageRoute({ itemStyle: "standard" }),
      get title() {
        return t("Change password");
      },
    },
  }),
  SettingsAccountUsage: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsAccountUsage"),
    screen: SettingsAccountUsageRouteScreen,
    linking: "settings/usage-limits",
    options: {
      ...pageRoute({ itemStyle: "standard" }),
      get title() {
        return t("Usage and limits");
      },
    },
  }),
  SettingsPlugins: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsPlugins"),
    screen: SettingsPluginsRouteScreen,
    linking: "settings/plugins",
    options: {
      ...pageRoute({ itemStyle: "standard" }),
      get title() {
        return t("Plugins");
      },
    },
  }),
  SettingsEnvironments: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsEnvironments"),
    screen: SettingsEnvironmentsRouteScreen,
    linking: "settings/environments",
    options: settingsPage("Environments"),
  }),
  SettingsEnvironmentDetail: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsEnvironmentDetail"),
    screen: SettingsEnvironmentDetailRouteScreen,
    linking: "settings/environments/:environmentId",
    options: settingsPage("Environment"),
  }),
  // Old links to New threads and Agent behavior open Threads, which absorbed them.
  SettingsEnvironmentNewThreads: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsEnvironmentNewThreads"),
    screen: SettingsThreadsRouteScreen,
    linking: "settings/new-threads",
    options: settingsPage("Threads"),
  }),
  SettingsEnvironmentSourceControl: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsEnvironmentSourceControl"),
    screen: SettingsEnvironmentSourceControlRouteScreen,
    linking: "settings/source-control",
    options: settingsPage("Source control"),
  }),
  SettingsEnvironmentAgentBehavior: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsEnvironmentAgentBehavior"),
    screen: SettingsThreadsRouteScreen,
    linking: "settings/agent-behavior",
    options: settingsPage("Threads"),
  }),
  SettingsWorktrees: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsWorktrees"),
    screen: SettingsWorktreesRouteScreen,
    linking: "settings/worktrees",
    options: settingsPage("Worktrees"),
  }),
  SettingsLabs: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsLabs"),
    screen: SettingsLabsRouteScreen,
    linking: "settings/labs",
    options: settingsPage("Labs"),
  }),
  SettingsProviderAccounts: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsProviderAccounts"),
    screen: SettingsProviderAccountsRouteScreen,
    linking: "settings/provider-accounts",
    options: settingsPage("Providers"),
  }),
  SettingsEnvironmentMaintenance: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsEnvironmentMaintenance"),
    screen: SettingsEnvironmentMaintenanceRouteScreen,
    linking: "settings/maintenance",
    options: settingsPage("Maintenance"),
  }),
  SettingsNotifications: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsNotifications"),
    screen: SettingsNotificationsRouteScreen,
    linking: "settings/notifications",
    options: settingsPage("Notifications"),
  }),
  SettingsThreads: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsThreads"),
    screen: SettingsThreadsRouteScreen,
    linking: "settings/thread-preferences",
    options: settingsPage("Threads"),
  }),
  SettingsAbout: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsAbout"),
    screen: SettingsAboutRouteScreen,
    linking: "settings/about",
    options: settingsPage("About"),
  }),
  SettingsEnvironmentNew: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsEnvironmentNew"),
    screen: ConnectionsNewRouteScreen,
    linking: "settings/environment-new",
    options: settingsPage("Add Environment"),
  }),
  SettingsArchive: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsArchive"),
    screen: ArchivedThreadsRouteScreen,
    linking: "settings/archive",
    options: settingsPage("Archive"),
  }),
  SettingsNavigation: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsNavigation"),
    screen: SettingsNavigationRouteScreen,
    linking: "settings/navigation-tabs",
    options: settingsPage("Navigation tabs"),
  }),
  SettingsAppearance: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsAppearance"),
    screen: SettingsAppearanceRouteScreen,
    linking: "settings/appearance",
    options: settingsPage("Appearance"),
  }),
  SettingsProjectGrouping: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsProjectGrouping"),
    screen: SettingsProjectGroupingRouteScreen,
    linking: "settings/project-grouping",
    options: settingsPage("General"),
  }),
  SettingsOrganization: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsOrganization"),
    screen: SettingsProjectGroupingRouteScreen,
    linking: "settings/organization",
    options: settingsPage("General"),
  }),
  SettingsProjectOverview: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsProjectOverview"),
    screen: SettingsProjectOverviewRouteScreen,
    linking: "settings/project",
    options: settingsPage("Projects"),
  }),
  SettingsKeyboard: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsKeyboard"),
    screen: SettingsKeyboardRouteScreen,
    linking: "settings/keyboard",
    options: settingsPage("Keyboard"),
  }),
  SettingsVoice: createNativeStackScreen({
    screen: SettingsVoiceRouteScreen,
    linking: { path: "settings/voice", alias: ["settings/microphone"] },
    options: settingsPage("Voice"),
  }),
  SettingsFollowUp: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsFollowUp"),
    screen: SettingsFollowUpRouteScreen,
    linking: "settings/follow-ups",
    options: settingsPage("Chat"),
  }),
  SettingsScheduledTasks: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsScheduledTasks"),
    screen: SettingsScheduledTasksRouteScreen,
    linking: "settings/scheduled-tasks",
    options: {
      ...settingsPage("Scheduled tasks"),
      headerTitleStyle: { fontSize: 16, fontWeight: "800" },
    },
  }),
  SettingsScheduledTaskNew: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsScheduledTaskNew"),
    screen: SettingsScheduledTaskNewRouteScreen,
    linking: "settings/scheduled-tasks/new",
    options: settingsPage("New scheduled task"),
  }),
  SettingsScheduledTaskEdit: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsScheduledTaskEdit"),
    screen: SettingsScheduledTaskEditRouteScreen,
    options: settingsPage("Edit scheduled task"),
  }),
  SettingsScheduledTaskBranch: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsScheduledTaskBranch"),
    screen: ScheduledTaskBranchPickerRouteScreen,
    options: settingsPage("Base branch"),
  }),
  SettingsScheduledTaskThread: createNativeStackScreen({
    screen: ScheduledTaskThreadPickerRouteScreen,
    options: settingsPage("Destination"),
  }),
  SettingsScheduledTaskModel: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsScheduledTaskModel"),
    screen: ScheduledTaskModelPickerRouteScreen,
    options: THREAD_SETTINGS_ROUTE,
  }),
  SettingsClientStorage: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsClientStorage"),
    screen: SettingsClientStorageRouteScreen,
    linking: "settings/client-storage",
    options: settingsPage("Client Storage"),
  }),
  SettingsDiagnostics: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsDiagnostics"),
    screen: SettingsDiagnosticsRouteScreen,
    linking: "settings/diagnostics",
    options: settingsPage("Diagnostics"),
  }),
  // These params snapshot the tap time, local filters, and freshly aggregated pools.
  // A linking path would round-trip them as URL query strings and preserve stale values.
  SettingsUsageAccount: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsUsageAccount"),
    screen: UsageLimitAccountScreen,
    options: settingsPage("Account"),
  }),
  SettingsOpenSourceLicenses: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsOpenSourceLicenses"),
    screen: SettingsOpenSourceLicensesRouteScreen,
    linking: "settings/open-source-licenses",
    options: settingsPage("Open source licenses"),
  }),
  SettingsOpenSourceLicense: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsOpenSourceLicense"),
    screen: SettingsOpenSourceLicenseRouteScreen,
    linking: "settings/open-source-licenses/:entryKey",
    options: settingsPage("License notice"),
  }),
  SettingsUsage: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsUsage"),
    screen: UsageRouteScreen,
    linking: "settings/usage",
    options: settingsPage("Usage"),
  }),
  SettingsAuth: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsAuth"),
    screen: SettingsAuthRouteScreen,
    linking: "settings/auth",
    options: { headerShown: false, presentation: "modal" },
  }),
  SettingsWaitlist: createNativeStackScreen({
    if: () => isMobileRouteEnabled("SettingsWaitlist"),
    screen: SettingsAuthRouteScreen,
    linking: "settings/waitlist",
    options: { headerShown: false, presentation: "modal" },
  }),
};

// iOS 26 header morphing requires one UINavigationBar; nested stacks make the whole screen slide.
const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

export function workspaceLocationFromState(state: NavigationState) {
  const routes = state.routes.filter((route) => !isWorkspaceOverlayRoute(route.name));
  const effectiveState =
    routes.length > 0 && routes.length !== state.routes.length
      ? ({ ...state, routes, index: routes.length - 1 } as NavigationState)
      : state;
  const path = getPathFromState(effectiveState, navigationPathConfig);
  const route = effectiveState.routes[effectiveState.index];
  return {
    pathname: path.startsWith("/") ? path : `/${path}`,
    routeKey: route?.key,
    routeName: route?.name,
  };
}

export function rootPathnameFromState(state: NavigationState): string {
  const path = getPathFromState(state, navigationPathConfig);
  return path.startsWith("/") ? path : `/${path}`;
}

function RootStackLayout(props: {
  readonly children: React.ReactNode;
  readonly state: NavigationState;
}) {
  const pathname = rootPathnameFromState(props.state);
  const workspaceLocation = workspaceLocationFromState(props.state);
  const settingsOpen = settingsOpenIn(
    props.state.routes
      .slice(0, props.state.index + 1)
      .filter((route) => !isWorkspaceOverlayRoute(route.name)),
  );
  // The flow follows the draft route even while a pushed Thread covers it, so
  // its state lives exactly as long as the route.
  const draftRoute = props.state.routes.findLast(isDraftThreadRoute);
  const draftRouteOnTop =
    draftRoute !== undefined &&
    props.state.routes.findLast((route) => route.name === "Thread") === draftRoute;
  const draftParams = (
    draftRoute?.params as { draft?: { draftId?: string | string[] } } | undefined
  )?.draft;
  const routeDraftId = Array.isArray(draftParams?.draftId)
    ? draftParams.draftId[0]
    : draftParams?.draftId;

  return (
    <NewTaskFlowProvider
      active={draftRouteOnTop}
      flowKey={draftRoute === undefined ? undefined : newTaskFlowKey(draftRoute)}
      routeDraftId={routeDraftId}
    >
      <HardwareKeyboardCommandProvider pathname={pathname}>
        <ShowcaseReadyMarker />
        <SettingsEnvironmentFilterProvider open={settingsOpen}>
          <WorkspaceConnectionStatusProvider>
            <AndroidWorkspaceTabsProvider state={props.state}>
              <AdaptiveWorkspaceLayout
                pathname={workspaceLocation.pathname}
                workspaceRouteKey={workspaceLocation.routeKey}
                workspaceRouteName={workspaceLocation.routeName}
              >
                {props.children}
                <HardwareKeyboardCommandOverlay />
              </AdaptiveWorkspaceLayout>
            </AndroidWorkspaceTabsProvider>
          </WorkspaceConnectionStatusProvider>
        </SettingsEnvironmentFilterProvider>
      </HardwareKeyboardCommandProvider>
    </NewTaskFlowProvider>
  );
}

function NotFoundScreen() {
  const t = useTranslation();
  const navigation = useNavigation();
  const screenBgStyle = StyleSheet.flatten(useResolveClassNames("bg-screen"));
  const primaryBgStyle = StyleSheet.flatten(useResolveClassNames("bg-primary"));
  const returnHomeButtonStyle = StyleSheet.flatten([
    {
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    primaryBgStyle,
  ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={[{ flex: 1 }, screenBgStyle]}
    >
      <Text className="text-3xl font-t3-bold text-foreground" selectable>
        {t("Route not found")}
      </Text>
      <Pressable
        style={returnHomeButtonStyle}
        onPress={() => navigation.dispatch(StackActions.replace("Home"))}
      >
        <Text className="text-base font-t3-bold text-primary-foreground">{t("Return home")}</Text>
      </Pressable>
    </ScrollView>
  );
}

const RootStackConfig = createWorkspaceStackNavigator({
  initialRouteName: "Home",
  UNSTABLE_router: workspaceDetailRouter,
  // React Navigation calls layouts inline; compiled components would share the navigator's memo cache.
  layout: (props) => <RootStackLayout {...props} />,
  screenOptions: {
    headerShown: false,
  },
  screens: {
    ...(__DEV__
      ? {
          ComponentCatalog: createNativeStackScreen({
            screen: ComponentCatalogScreen,
            linking: "dev/components",
            options: {
              get title() {
                return t("UI components");
              },
            },
          }),
        }
      : {}),
    Home: createNativeStackScreen({
      screen: WorkspaceRootScreen,
      linking: "",
      listeners: {
        transitionStart: ({ data }: { data: { closing: boolean } }) =>
          recordHomeTransitionStart(data.closing),
        transitionEnd: ({ data }: { data: { closing: boolean } }) =>
          recordHomeTransitionEnd(data.closing),
        focus: recordHomeFocus,
      },
      options: {
        ...pageRoute({ duoMinimize: "never", root: true }),
        contentStyle: { backgroundColor: "transparent" },
        ...getCompactBrandHeaderOptions(),
      },
    }),
    Thread: createNativeStackScreen({
      screen: ThreadRouteScreen,
      linking: { path: "threads/:environmentId?/:threadId?", alias: ["new/draft"] },
      options: pageRoute({ duoMinimize: "onScrollUp" }),
    }),
    NewTaskProject: createNativeStackScreen({
      screen: NewTaskRouteScreen,
      linking: { path: "new", alias: ["new/project"] },
      options: pageRoute({ title: "Choose project" }),
    }),
    NewTaskEnvironment: createNativeStackScreen({
      linking: "new/draft/environment",
      screen: NewTaskEnvironmentPickerRouteScreen,
      options: pageRoute({ title: "Environment" }),
    }),
    NewTaskBranch: createNativeStackScreen({
      if: () => isMobileRouteEnabled("NewTaskBranch"),
      linking: "new/draft/branch",
      screen: NewTaskBranchPickerRouteScreen,
      options: pageRoute({ title: "Branch" }),
    }),
    AddProject: createNativeStackScreen({
      if: () => isMobileRouteEnabled("AddProject"),
      linking: "new/add-project",
      screen: AddProjectSourceRoute,

      options: pageRoute({ title: "Add project" }),
    }),
    AddProjectRepository: createNativeStackScreen({
      if: () => isMobileRouteEnabled("AddProjectRepository"),
      linking: "new/add-project/repository",
      screen: AddProjectRepositoryRoute,
      options: pageRoute(),
    }),
    AddProjectDestination: createNativeStackScreen({
      if: () => isMobileRouteEnabled("AddProjectDestination"),
      linking: "new/add-project/destination",
      screen: AddProjectDestinationRoute,
      options: pageRoute(),
    }),
    AddProjectLocal: createNativeStackScreen({
      if: () => isMobileRouteEnabled("AddProjectLocal"),
      linking: "new/add-project/local",
      screen: AddProjectLocalRoute,
      options: pageRoute(),
    }),
    AddProjectNew: createNativeStackScreen({
      if: () => isMobileRouteEnabled("AddProjectNew"),
      linking: "new/add-project/new",
      screen: AddProjectNewRoute,
      options: pageRoute(),
    }),
    NewTaskFiles: createNativeStackScreen({
      linking: "new/draft/files",
      screen: ThreadFilesTreeScreen,
      options: pageRoute({ header: "solid" }),
    }),
    NewTaskFile: createNativeStackScreen({
      linking: "new/draft/files/:path*",
      screen: ThreadFileScreen,
      options: pageRoute({ header: "solid" }),
    }),
    NewTaskAttachment: createNativeStackScreen({
      screen: AttachmentFileScreen,
      linking: "new/draft/attachments/:attachmentId",
      options: pageRoute({ header: "solid" }),
    }),
    NewTaskThreadSettings: createNativeStackScreen({
      if: () => isMobileRouteEnabled("NewTaskThreadSettings"),
      screen: NewTaskThreadSettingsRouteScreen,
      linking: "new/draft/settings",
      options: THREAD_SETTINGS_ROUTE,
    }),
    ThreadTerminal: createNativeStackScreen({
      if: () => isMobileRouteEnabled("ThreadTerminal"),
      screen: ThreadTerminalRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/terminal`,
      options: pageRoute({ header: "solid" }),
    }),
    ThreadInspectorFullscreen: createNativeStackScreen({
      screen: FullscreenThreadRouteScreen,
      options: modalRoute({ header: "glass", itemStyle: "editor", duoMinimize: "onScrollUp" }),
    }),
    ThreadDevicePreview: createNativeStackScreen({
      if: () => isMobileRouteEnabled("ThreadDevicePreview"),
      screen: DevicePreviewRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/devices`,
      options: immersiveRoute({ hideSystemBars: true }),
    }),
    ThreadBrowserPreview: createNativeStackScreen({
      screen: BrowserPreviewRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/browser`,
      options: { ...modalRoute({ header: "solid" }), gestureEnabled: false },
    }),
    ThreadReview: createNativeStackScreen({
      if: () => isMobileRouteEnabled("ThreadReview"),
      screen: ReviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/review`,
      options: pageRoute(),
    }),
    ThreadReviewComment: createNativeStackScreen({
      if: () => isMobileRouteEnabled("ThreadReviewComment"),
      screen: ReviewCommentComposerSheet,
      linking: `${THREAD_LINKING_PREFIX}/review-comment`,
      options: sheetRoute({ detent: 0.55, android: "fullScreen" }),
    }),
    ThreadFiles: createNativeStackScreen({
      screen: ThreadFilesTreeScreen,
      linking: `${THREAD_LINKING_PREFIX}/files`,
      options: pageRoute({ title: "Files" }),
    }),
    ThreadFile: createNativeStackScreen({
      screen: ThreadFileScreen,
      linking: `${THREAD_LINKING_PREFIX}/files/:path*`,
      options: pageRoute(),
    }),
    ThreadMcpApp: createNativeStackScreen({
      screen: McpAppFullscreenScreen,
      linking: `${THREAD_LINKING_PREFIX}/apps/:itemId`,
      options: { ...modalRoute({ header: "solid" }), gestureEnabled: false },
    }),
    ThreadAttachment: createNativeStackScreen({
      screen: AttachmentFileScreen,
      linking: `${THREAD_LINKING_PREFIX}/attachments/:attachmentId`,
      options: pageRoute({ header: "solid" }),
    }),
    ThreadSettingsSheet: createNativeStackScreen({
      if: () => isMobileRouteEnabled("ThreadSettingsSheet"),
      screen: ExistingThreadSettingsRouteScreen,
      options: THREAD_SETTINGS_ROUTE,
    }),
    ThreadQueue: createNativeStackScreen({
      screen: ThreadQueueSheet,
      options: sheetRoute({ detent: 0.65, androidMaxDetent: 0.95 }),
    }),
    ThreadBackgroundWork: createNativeStackScreen({
      screen: ThreadBackgroundWorkSheet,
      options: sheetRoute({ detent: 0.5, androidMaxDetent: 0.9 }),
    }),
    ThreadAgents: createNativeStackScreen({
      screen: ThreadAgentsSheet,
      options: sheetRoute({ detent: 0.5, androidMaxDetent: 0.9 }),
    }),
    GitOverview: createNativeStackScreen({
      if: () => isMobileRouteEnabled("GitOverview"),
      screen: GitOverviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/git`,
      options: sheetRoute({ detent: 0.55 }),
    }),
    GitCommit: createNativeStackScreen({
      if: () => isMobileRouteEnabled("GitCommit"),
      screen: GitCommitSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/commit`,
      options: sheetRoute({ detent: 0.8, androidFit: true }),
    }),
    GitBranches: createNativeStackScreen({
      if: () => isMobileRouteEnabled("GitBranches"),
      screen: GitBranchesSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/branches`,
      options: sheetRoute({ detent: 0.55, androidFit: true }),
    }),
    GitConfirm: createNativeStackScreen({
      if: () => isMobileRouteEnabled("GitConfirm"),
      screen: GitConfirmSheet,
      linking: `${THREAD_LINKING_PREFIX}/git-confirm`,
      options: sheetRoute({ detent: 0.55, maxDetent: 0.7, androidFit: true }),
    }),
    ...SETTINGS_SCREENS,
    SettingsLegal: createNativeStackScreen({
      screen: SettingsLegalRouteScreen,
      linking: "settings/legal",
      options: modalRoute({ header: "solid", title: "Legal" }),
    }),
    ConnectOnboarding: createNativeStackScreen({
      screen: ConnectOnboardingRouteScreen,
      linking: "connect-onboarding",
      options: sheetRoute({
        get title() {
          return t("Set up T3 Connect");
        },
        header: "solid",
        detent: 0.6,
        androidMaxDetent: 0.95,
      }),
    }),
    Connections: createNativeStackScreen({
      screen: ConnectionsRouteScreen,
      linking: "connections",
      options: sheetRoute({
        get title() {
          return t("Environments");
        },
        detent: 0.55,
        maxDetent: 0.7,
        android: "card",
      }),
    }),
    ConnectionsNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "connections/new",
      options: sheetRoute({
        get title() {
          return t("Add Environment");
        },
        detent: 0.55,
        maxDetent: 0.7,
      }),
    }),
    NotFound: createNativeStackScreen({
      screen: NotFoundScreen,
      linking: "*",
    }),
  },
});

function GuardedScreenLayout(props: {
  readonly children: ReactNode;
  readonly route: { readonly name: string; readonly params?: object | undefined };
}) {
  return (
    <RenderErrorBoundary
      resetKeys={[props.route.params]}
      renderFallback={(fallback) => (
        <ScreenRenderFallback {...fallback} routeName={props.route.name} />
      )}
    >
      {props.children}
    </RenderErrorBoundary>
  );
}

function ScreenRenderFallback(props: RenderFailureProps & { readonly routeName: string }) {
  const t = useTranslation();
  const navigation = useNavigation();
  const exit = navigation.canGoBack()
    ? { label: t("Go back"), onPress: () => navigation.goBack() }
    : props.routeName === "Home"
      ? // Home itself failed, and the Settings list renders inside it; open a Settings page.
        {
          label: t("Open settings"),
          onPress: () => openSettings(navigation, DEFAULT_SETTINGS_PAGE),
        }
      : {
          label: t("Return home"),
          onPress: () => navigation.dispatch(StackActions.replace("Home")),
        };

  return <RenderFailureView {...props} exit={exit} />;
}

registerPresentedRoutes(
  Object.entries(RootStackConfig.config.screens ?? {}).flatMap(([name, screen]) => {
    const options = (screen as { readonly options?: unknown }).options;
    return options && typeof options === "object" && isPresentedRoute(options) ? [name] : [];
  }),
);

export const RootStack = RootStackConfig.with(function AdaptiveRootStack({ Navigator }) {
  const { width, height } = useWindowDimensions();
  const nativeMetrics = useNativeLayoutMetrics();
  const usesSplitView = deriveLayout({ width, height, nativeMetrics }).usesSplitView;

  /* oxlint-disable react/no-unstable-nested-components -- React Navigation invokes screenLayout as a render callback. */
  return (
    <Navigator
      screenLayout={(props) => <GuardedScreenLayout {...props} />}
      screenOptions={({ route, navigation }) =>
        Platform.OS === "android"
          ? {
              animation: androidWorkspaceDestinationAnimation(
                route,
                navigation.getState().routes,
                usesSplitView,
              ),
            }
          : {}
      }
    />
  );

  /* oxlint-enable react/no-unstable-nested-components */
});

type RootStackType = typeof RootStack;

const navigationPathConfig = {
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

declare module "@react-navigation/native" {
  interface RootNavigator extends RootStackType {}
}
