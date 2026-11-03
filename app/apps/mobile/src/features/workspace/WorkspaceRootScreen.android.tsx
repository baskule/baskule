import { useAndroidFloatingTabs } from "../settings/appearance/AppearancePreferencesProvider";
import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { WorkspaceExtraTab } from "./WorkspaceExtraTab";
import { useWindowDimensions, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";

import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation, FloatingWorkspaceTabs } from "./AndroidWorkspaceNavigation";
import { FLOATING_TABS, floatingTabsMetrics } from "./floating-workspace-tabs";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import type { WorkspaceTab } from "./workspace-tabs-state";

const TABS: readonly WorkspaceTab[] = NAVIGATION_TAB_ORDER;

export function WorkspaceRootScreen() {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const insets = useSafeAreaInsets();
  const { fabClearance, scale, fabSize } = useAndroidControlSizing();
  const window = useWindowDimensions();
  const floating = floatingTabsMetrics(enabled.length + 1, scale, fabSize, window.width);
  const context = {
    ...workspace,
    bottomClearance: layout.usesSplitView
      ? workspace.bottomClearance
      : floatingTabsEnabled
        ? insets.bottom +
          FLOATING_TABS.bottom +
          FLOATING_TABS.edge +
          Math.max(
            floating.height,
            workspace.state.selectedTab === "threads" ? floating.fabOffset + fabSize : 0,
          )
        : workspace.state.selectedTab === "threads"
          ? fabClearance + 16
          : 16,
  };
  const tab = workspace.state.selectedTab;

  return (
    <WorkspaceTabsContext value={context}>
      <View className={layout.usesSplitView ? "flex-1 bg-screen" : "flex-1 bg-header"}>
        {!layout.usesSplitView ? (
          <NativeStackScreenOptions options={{ headerShown: false }} />
        ) : null}
        <SafeAreaInsetsContext
          value={
            layout.usesSplitView
              ? insets
              : floatingTabsEnabled
                ? tab === "usage"
                  ? { ...insets, bottom: context.bottomClearance }
                  : insets
                : { ...insets, bottom: 0 }
          }
        >
          {enabled.length === 0 ? (
            layout.usesSplitView ? (
              <View className="flex-1 bg-screen" />
            ) : (
              <WorkspaceNoTabs />
            )
          ) : (
            <WorkspaceTabPanes
              tabs={TABS}
              selected={tab}
              renderTab={(tab) =>
                tab === "threads" ? <HomeRouteScreen /> : <WorkspaceExtraTab tab={tab} />
              }
            />
          )}
        </SafeAreaInsetsContext>
        {layout.usesSplitView ? null : floatingTabsEnabled ? (
          <FloatingWorkspaceTabs fillWidth onNewThread={startNewTask} />
        ) : (
          <AndroidWorkspaceNavigation onNewThread={startNewTask} />
        )}
      </View>
    </WorkspaceTabsContext>
  );
}
