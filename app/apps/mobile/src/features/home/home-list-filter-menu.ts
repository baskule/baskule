import { BASKULE_FLAGS } from "../../baskule/flags";

import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { msg } from "gt-react-native";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../i18n/messages";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function homeListFilterEnvironments(environments: ReadonlyArray<WorkspaceEnvironment>) {
  return Arr.sort(
    environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.environmentLabel,
        connectionState: environment.connectionState,
      })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export function buildHomeListFilterMenuItems(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
  },
  resolve: MessageResolver = m,
): AppBarMenuItem[] {
  const visible = visibleListFilters(props.environments, props.projects);
  const items: AppBarMenuItem[] = visible.environments.length
    ? [
        {
          id: "environment",
          title: BASKULE_FLAGS.projects ? resolve(msg("Environment")) : resolve(msg("Spaces")),
          items: [
            {
              id: "environment:all",
              title: BASKULE_FLAGS.projects
                ? resolve(msg("All environments"))
                : resolve(msg("All spaces")),
              subtitle: BASKULE_FLAGS.projects
                ? resolve(msg("Show threads from every environment"))
                : resolve(msg("Show chats from every space")),
              selected: props.selectedEnvironmentId === null,
              onPress: () => props.onEnvironmentChange(null),
            },
            ...visible.environments.map((environment) => ({
              id: `environment:${environment.environmentId}`,
              title: environment.label,
              selected: props.selectedEnvironmentId === environment.environmentId,
              onPress: () => props.onEnvironmentChange(environment.environmentId),
            })),
          ],
        },
      ]
    : [];

  if (visible.projects.length > 0) {
    items.push({
      id: "project",
      title: resolve(msg("Project", { $context: "filter menu heading" })),
      items: [
        {
          id: "project:all",
          title: resolve(msg("All projects")),
          subtitle: resolve(msg("Show threads from every project")),
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...visible.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return items;
}

export function visibleListFilters<Environment, Project>(
  environments: ReadonlyArray<Environment>,
  projects: ReadonlyArray<Project>,
) {
  return BASKULE_FLAGS.projects
    ? { environments, projects }
    : { environments: environments.length > 1 ? environments : [], projects: [] };
}
