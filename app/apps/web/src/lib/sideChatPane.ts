import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import type {
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  SideThreadOpenTarget,
} from "@t3tools/contracts";

import type { ToolCallDiffTarget } from "../diffPanelStore";

import { useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side thread's tool diffs in its parent's diff panel and runs its shell commands
 * in the parent's terminal drawer, since the embedded view hides its own. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection and the drawer are not panel state.
 */
export interface SideChatParentPanel {
  /** The thread whose panel shows the embedded one. */
  readonly hostRef: ScopedThreadRef;
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
  readonly runShellCommand: (command: string) => void;
}

/**
 * Where opening `threadRef` should route. A side chat shows as a tab of its parent, so this opens
 * that tab and returns the parent; any other thread returns `threadRef`.
 */
export function resolveThreadOpenRoute(
  threadRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "lineage"> | null,
): ScopedThreadRef {
  const parentThreadId = thread?.lineage.sideChat === true ? thread.lineage.parentThreadId : null;
  if (parentThreadId === null) return threadRef;
  const parentRef = scopeThreadRef(threadRef.environmentId, parentThreadId);
  useRightPanelStore.getState().openSideChat(parentRef, threadRef.threadId);
  return parentRef;
}

/** Opens a related thread in the main view; side chats keep their parent panel. */
export function openSideThread(input: {
  readonly threadRef: ScopedThreadRef;
  readonly panelRef: ScopedThreadRef | null;
  readonly intent: SideThreadOpenIntent;
  readonly navigate: (threadRef: ScopedThreadRef) => void;
}): SideThreadOpenTarget {
  input.navigate(input.threadRef);
  return "main";
}
