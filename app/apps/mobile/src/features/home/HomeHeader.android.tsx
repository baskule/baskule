import { listFilterMenuActions } from "./home-list-filter-menu";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ThreadListToolbar } from "./ThreadListToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

export function HomeHeader(props: HomeHeaderProps) {
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const menuActions = listFilterMenuActions(props);
  const handleMenuAction = (event: { nativeEvent: { event: string } }) => {
    const id = event.nativeEvent.event;
    if (id === "environment:all") {
      props.onEnvironmentChange(null);
      return;
    }

    if (id.startsWith("environment:")) {
      const environmentId = id.slice("environment:".length);
      const environment = props.environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (environment) {
        props.onEnvironmentChange(environment.environmentId);
      }
      return;
    }

    if (id === "project:all") {
      props.onProjectChange(null);
      return;
    }

    if (id.startsWith("project:")) {
      const projectKey = id.slice("project:".length);
      if (props.projects.some((project) => project.key === projectKey)) {
        props.onProjectChange(projectKey);
      }
      return;
    }
  };

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <ThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenEnvironments={props.onOpenEnvironments}
        onOpenSettings={props.onOpenSettings}
      />
    </>
  );
}
