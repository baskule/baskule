import { t } from "../../i18n";

import type { ClientSettings } from "@t3tools/contracts";

// Ids are stored in client settings, so never rename one.
export const THREAD_DETAILS_ITEMS = [
  { id: "environment", label: t("Environment and worktree"), defaultVisible: true },
  { id: "openIn", label: t("Open in editor"), defaultVisible: true },
  { id: "scripts", label: t("Project scripts"), defaultVisible: true },
  { id: "branch", label: t("Branch and pull request"), defaultVisible: true },
  { id: "gitActions", label: t("Git actions"), defaultVisible: true },
  { id: "changes", label: t("Changes"), defaultVisible: true },
  { id: "automations", label: t("Automations"), defaultVisible: true },
  { id: "lineage", label: t("Lineage"), defaultVisible: true },
  { id: "usage", label: t("Usage"), defaultVisible: false },
] as const;

export type ThreadDetailsItemId = (typeof THREAD_DETAILS_ITEMS)[number]["id"];
export type ThreadDetailsVisibility = Readonly<Record<ThreadDetailsItemId, boolean>>;

type ThreadDetailsItem = (typeof THREAD_DETAILS_ITEMS)[number];
type ThreadDetailsItemSettings = Pick<ClientSettings, "threadDetailsItems">;

function defaultVisible(item: ThreadDetailsItem) {
  return item.defaultVisible;
}

export function resolveThreadDetailsVisibility(
  settings: ThreadDetailsItemSettings,
): ThreadDetailsVisibility {
  return Object.fromEntries(
    THREAD_DETAILS_ITEMS.map((item) => [
      item.id,
      settings.threadDetailsItems[item.id] ?? defaultVisible(item),
    ]),
  ) as Record<ThreadDetailsItemId, boolean>;
}

/** Stores only choices that differ from the default, so a later default change reaches everyone else. */
export function setThreadDetailsItem(
  settings: ThreadDetailsItemSettings,
  item: ThreadDetailsItem,
  visible: boolean,
): ClientSettings["threadDetailsItems"] {
  const { [item.id]: _previous, ...rest } = settings.threadDetailsItems;
  return visible === defaultVisible(item) ? rest : { ...rest, [item.id]: visible };
}

export function isDefaultThreadDetailsVisibility(visibility: ThreadDetailsVisibility) {
  return THREAD_DETAILS_ITEMS.every((item) => visibility[item.id] === item.defaultVisible);
}

export const RESET_THREAD_DETAILS_ITEMS = {
  threadDetailsItems: {},
} satisfies Partial<ClientSettings>;
