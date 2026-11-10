import { t } from "../../i18n";

import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

import { BASKULE_FLAGS } from "../../baskule/flags";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

/** baskule: chats are filtered by space alone, and only when the person has several. */
export function visibleListFilters<Environment, Project>(
  environments: ReadonlyArray<Environment>,
  projects: ReadonlyArray<Project>,
) {
  return BASKULE_FLAGS.projects
    ? { environments, projects }
    : { environments: environments.length > 1 ? environments : [], projects: [] };
}

function scopeCopy() {
  return BASKULE_FLAGS.projects
    ? {
        title: t("Environment"),
        all: t("All environments"),
        allDetail: t("Show threads from every environment"),
      }
    : { title: t("Spaces"), all: t("All spaces"), allDetail: t("Show chats from every space") };
}

/** The list filter as a native menu; empty when there is nothing to choose. */
export function listFilterMenuActions(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
}): MenuAction[] {
  const { environments, projects } = visibleListFilters(props.environments, props.projects);
  const copy = scopeCopy();
  const checked = (on: boolean) => (on ? ("on" as const) : ("off" as const));
  return [
    ...(environments.length === 0
      ? []
      : [
          {
            id: "environment",
            title: copy.title,
            subactions: [
              {
                id: "environment:all",
                title: copy.all,
                subtitle: copy.allDetail,
                state: checked(props.selectedEnvironmentId === null),
              },
              ...environments.map((environment) => ({
                id: `environment:${environment.environmentId}`,
                title: environment.label,
                state: checked(props.selectedEnvironmentId === environment.environmentId),
              })),
            ],
          },
        ]),
    ...(projects.length === 0
      ? []
      : [
          {
            id: "project",
            title: t("Project"),
            subactions: [
              {
                id: "project:all",
                title: t("All projects"),
                subtitle: t("Show threads from every project"),
                state: checked(props.selectedProjectKey === null),
              },
              ...projects.map((project) => ({
                id: `project:${project.key}`,
                title: project.label,
                state: checked(props.selectedProjectKey === project.key),
              })),
            ],
          },
        ]),
  ];
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];
  const visible = visibleListFilters(props.environments, props.projects);
  const copy = scopeCopy();

  if (visible.environments.length > 0) {
    items.push({
      type: "submenu",
      title: copy.title,
      items: [
        {
          type: "action",
          title: copy.all,
          subtitle: copy.allDetail,
          state: props.selectedEnvironmentId === null ? "on" : "off",
          onPress: () => props.onEnvironmentChange(null),
        },
        ...visible.environments.map((environment) => ({
          type: "action" as const,
          title: environment.label,
          state:
            props.selectedEnvironmentId === environment.environmentId
              ? ("on" as const)
              : ("off" as const),
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    });
  }

  if (visible.projects.length > 0) {
    items.push({
      type: "submenu",
      title: t("Project"),
      items: [
        {
          type: "action",
          title: t("All projects"),
          subtitle: t("Show threads from every project"),
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...visible.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: t("Thread list options"),
    items,
  };
}
