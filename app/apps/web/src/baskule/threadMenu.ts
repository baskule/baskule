// baskule: the chat menu offers the chat controls in scope: Rename, Archive and Delete (0.1), plus
// Pin, Snooze and Mark unread in the hosted 0.2 build. Everything else (branches, settle, copy
// paths, project settings) stays hidden.
import type { ContextMenuItem } from "@t3tools/contracts";

import { BASKULE_HOSTED, BASKULE_UI } from "./flags";

const BASKULE_THREAD_MENU: Readonly<Record<string, string>> = BASKULE_HOSTED
  ? {
      // 0.2 chat controls (thin-server scope 1): pin, snooze, unread.
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
