import { BASKULE_FLAGS } from "../../baskule/flags";
import { t } from "../../i18n";
import type { EnvironmentId } from "@t3tools/contracts";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export function buildHomeListFilterMenuItems(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
}): AppBarMenuItem[] {
  const visible = visibleListFilters(props.environments, props.projects);
  const items: AppBarMenuItem[] = visible.environments.length
    ? [
        {
          id: "environment",
          title: BASKULE_FLAGS.projects ? t("Environment") : t("Spaces"),
          items: [
            {
              id: "environment:all",
              title: BASKULE_FLAGS.projects ? t("All environments") : t("All spaces"),
              subtitle: BASKULE_FLAGS.projects
                ? t("Show threads from every environment")
                : t("Show chats from every space"),
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
      title: t("Project"),
      items: [
        {
          id: "project:all",
          title: t("All projects"),
          subtitle: t("Show threads from every project"),
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
