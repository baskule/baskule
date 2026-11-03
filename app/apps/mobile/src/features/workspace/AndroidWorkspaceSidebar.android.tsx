import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { type ReactNode } from "react";

import { View } from "react-native";

import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";

export function AndroidWorkspaceSidebar(props: { readonly children: ReactNode }) {
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  if (enabled.length === 0) return <WorkspaceNoTabs />;
  return (
    <WorkspaceTabPanes
      tabs={NAVIGATION_TAB_ORDER}
      selected={workspace.state.selectedTab}
      renderTab={(tab) =>
        tab === "threads" ? props.children : <View className="flex-1 bg-screen" />
      }
    />
  );
}
