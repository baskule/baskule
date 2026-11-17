import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";

import { View } from "react-native";

import { AndroidHomeFabLayout } from "../../home/AndroidHomeFab";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { WorkspaceThreadSidebar } from "./WorkspaceThreadSidebar";
import { WorkspaceAppBarScope } from "../../../components/ui/WorkspaceAppBar.android";

/** The Home route in the sidebar column: the selected tab's list. */
export function AndroidWorkspaceSidebar() {
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  // Settings and Usage cover the sidebar.
  const coveredByPage =
    (useAndroidWorkspaceRoot()?.settingsOpen ?? false) || workspace.state.selectedTab === "usage";
  if (enabled.length === 0) return <WorkspaceNoTabs />;
  return (
    <WorkspaceAppBarScope>
      <WorkspaceTabPanes
        tabs={NAVIGATION_TAB_ORDER}
        selected={workspace.state.selectedTab}
        renderTab={(tab) =>
          tab === "threads" ? (
            <AndroidHomeFabLayout sidebar disabled={coveredByPage} onStartNewTask={startNewTask}>
              <WorkspaceThreadSidebar />
            </AndroidHomeFabLayout>
          ) : (
            <View className="flex-1 bg-screen" />
          )
        }
      />
    </WorkspaceAppBarScope>
  );
}
