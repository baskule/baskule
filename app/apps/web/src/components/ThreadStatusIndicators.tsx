import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useStableCallback } from "~/hooks/useStableCallback";

import {
  resolveEnvironmentMachineKind,
  type ScopedThreadRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { FolderGit2Icon, TerminalIcon } from "lucide-react";
import { m, type MessageResolver } from "../i18n/messages";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";

import { type AnimationEvent } from "react";
import { cn } from "../lib/utils";
import { revealThreadTerminal } from "../lib/revealThreadTerminal";

import { useThreadRunningTerminalIds } from "../state/terminalSessions";

import { useUiStateStore } from "../uiStateStore";

import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
  useSidebarRowSubscriptionLease,
} from "./Sidebar.logic";

import type { SidebarThreadSummary } from "../types";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

export interface TerminalStatusIndicator {
  label: string;
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

/** The pull request a thread shows: its current link, else the one found for its branch. */

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: resolve(msg("Terminal process running")),
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function synchronizeTerminalPulse(event: AnimationEvent<SVGSVGElement>) {
  if (event.animationName !== "status-pulse") return;

  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "status-pulse") {
      animation.startTime = 0;
    }
  }
}

export function ThreadTerminalStatusButton({
  threadRef,
  terminalIds,
  onThreadActivate,
}: {
  threadRef: ScopedThreadRef;
  terminalIds: readonly string[];
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const terminalId = terminalIds[0];
  if (terminalId === undefined) return null;
  const status = terminalStatusFromRunningIds(terminalIds, messages);
  const label = gt(
    "{count, plural, one {{count} terminal process running. Open terminal} other {{count} terminal processes running. Open terminal}}",
    { count: terminalIds.length },
  );
  return (
    <SharedTooltipTrigger
      render={
        <button
          type="button"
          aria-label={label}
          data-testid={`sidebar-terminal-status-${threadRef.threadId}`}
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            status?.colorClass,
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            revealThreadTerminal(threadRef, terminalId);
            onThreadActivate(threadRef);
          }}
        />
      }
      label={label}
    >
      <TerminalIcon
        className="size-3.5 motion-safe:animate-status-pulse"
        onAnimationStart={synchronizeTerminalPulse}
      />
    </SharedTooltipTrigger>
  );
}

function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  const m = useMessages();
  const label = m(status.label);
  if (compact) {
    return (
      <SharedTooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
          />
        }
        label={label}
      >
        <span
          className={`size-[9px] rounded-full ${status.dotClass} ${
            status.pulse ? "motion-safe:animate-status-pulse" : ""
          }`}
        />
      </SharedTooltipTrigger>
    );
  }

  return (
    <SharedTooltipTrigger
      render={
        <span
          role="img"
          aria-label={label}
          className={`inline-flex items-center gap-1 text-3xs ${status.colorClass}`}
        />
      }
      label={label}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
          status.pulse ? "motion-safe:animate-status-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{label}</span>
    </SharedTooltipTrigger>
  );
}

export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const { rowRef } = useSidebarRowSubscriptionLease(false);
  // A new ref callback would detach and reattach the row, and each reattach sets lease state.
  const statusRef = useStableCallback((node: HTMLSpanElement | null) =>
    rowRef(node?.parentElement ?? null),
  );
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  return (
    <span
      ref={statusRef}
      className={threadStatus ? "inline-flex shrink-0 items-center gap-1.5" : "contents"}
    >
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const gt = useGT();
  const m = useMessages();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? gt("Remote", { $context: "machine location" }))
    : null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds, m);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={m(terminalStatus.label)}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
              onAnimationStart={synchronizeTerminalPulse}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{m(terminalStatus.label)}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <SharedTooltipTrigger
          render={
            <span
              aria-label={threadEnvironmentLabel ?? gt("Remote", { $context: "machine location" })}
              className="inline-flex items-center justify-center"
            />
          }
          label={threadEnvironmentLabel}
        >
          <EnvironmentMachineIcon
            kind={remoteMachine}
            className="size-3 text-muted-foreground/60"
          />
        </SharedTooltipTrigger>
      ) : null}
    </span>
  );
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const gt = useGT();
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = worktreePath;
  const tooltip = thread.branch
    ? gt("Worktree: {path} ({branch})", { path: displayPath, branch: thread.branch })
    : gt("Worktree: {path}", { path: displayPath });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3.5 shrink-0 text-icon-muted" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
