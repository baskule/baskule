// baskule: the chat menu offers Rename, Archive and Delete, plus Pin, Snooze and Mark unread
// in hosted mode. Branches, settlement, copied paths and project settings stay hidden.
import type { ContextMenuItem } from "@t3tools/contracts";

import { BASKULE_HOSTED, BASKULE_UI } from "./flags";

const BASKULE_THREAD_MENU: Readonly<Record<string, string>> = BASKULE_HOSTED
  ? {
      // Hosted chat controls: pin, snooze, unread.
      pin: "Pin",
      unpin: "Unpin",
      snooze: "Snooze",
      unsnooze: "Wake now",
      "mark-unread": "Mark unread",
      rename: "Rename",
      archive: "Archive",
      delete: "Delete",
    }
  : {
      rename: "Rename",
      archive: "Archive",
      delete: "Delete",
    };

export function baskuleThreadMenuItems<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
): ReadonlyArray<ContextMenuItem<T>> {
  if (!BASKULE_UI) return items;
  return items
    .filter((item) => item.id in BASKULE_THREAD_MENU)
    .map((item, index) => ({
      ...item,
      label: BASKULE_THREAD_MENU[item.id] ?? item.label,
      separatorBefore: index > 0 && (item.id === "delete" || item.id === "rename"),
    }));
}
