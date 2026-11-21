import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useGT, useMessages } from "gt-react";
import { m } from "../i18n/messages";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";

import { memo, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useDeadlinePassed } from "../hooks/useDeadline";
import { useNowSecond } from "../hooks/useNowSecond";

import {
  CheckIcon,
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  FileDiffIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
} from "lucide-react";

import { Spinner } from "~/components/ui/spinner";

import { cn } from "~/lib/utils";
import {
  buildMenuItems,
  formatGitActionElapsed,
  GIT_ACTION_SUCCESS_VISIBLE_MS,
  hasUsableGitMenuContent,
  type GitActionProgressPresentation,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveChangesTotals,
  resolveDefaultBranchActionDialogCopy,
  resolveFeatureBranchUnavailableReason,
  resolveGitActionProgressPresentation,
  resolveGitActionResultToastTiming,
  resolveLiveThreadBranchUpdate,
  getMenuActionDisabledReason,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";

import { StartTruncatedPath } from "./StartTruncatedPath";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsInitAction,
  useVcsPullAction,
} from "../state/sourceControlActions";
import { useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { useProjectClone } from "~/state/projectClones";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import {
  selectThreadBranchBaseRef,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "~/diffPanelStore";
import { useClientSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";

import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsActionManager, vcsEnvironment, vcsStatusRevalidation } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";

import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { ChangeBreakdownGrid } from "./pullRequest/ChangeBreakdownGrid";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  compact?: boolean;
  showActions?: boolean;
  showChanges?: boolean;
  onOpenChanges?: () => void;
  workspaceMutationId?: string | null;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  filePaths?: string[];
}

interface InlineGitActionSuccess {
  readonly title: string;
  readonly description: string | null;
  readonly expiresAtMs: number;
}

const inlineSuccessExpiresAt = () => Date.now() + GIT_ACTION_SUCCESS_VISIBLE_MS;

type RefreshVcsStatus = (target: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: ScopedThreadRef["environmentId"] | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}
const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull"] as const;

const COMMIT_DIALOG_TITLE = msg("Commit changes");
const COMMIT_DIALOG_DESCRIPTION = msg(
  "Review and confirm your commit. Leave the message blank to auto-generate one.",
);

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <CloudUploadIcon />;
}

function GitQuickActionIcon({
  quickAction,
  className = "size-3.5",
}: {
  quickAction: GitQuickAction;
  className?: string;
}) {
  const messages = useMessages();
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={className} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={className} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={className} />;
    }
    return <InfoIcon className={className} />;
  }
  // show_hint carries no action, so match the label resolveQuickAction gave it.
  if (quickAction.label === messages(msg("Commit", { $context: "verb, git action" }))) {
    return <GitCommitIcon className={className} />;
  }
  if (quickAction.label === messages(msg("Push", { $context: "verb, git action" }))) {
    return <CloudUploadIcon className={className} />;
  }
  return <InfoIcon className={className} />;
}

function GitActionElapsedTime({
  startedAtMs,
  className,
}: {
  startedAtMs: number | null;
  className?: string;
}) {
  return startedAtMs === null ? null : (
    <RunningGitActionElapsedTime startedAtMs={startedAtMs} className={className} />
  );
}

function RunningGitActionElapsedTime({
  startedAtMs,
  className,
}: {
  startedAtMs: number;
  className: string | undefined;
}) {
  const messages = useMessages();
  const nowMs = useNowSecond();
  const elapsed = formatGitActionElapsed(startedAtMs, nowMs, messages);
  if (!elapsed) {
    return null;
  }

  return (
    <p aria-live="off" className={className}>
      {elapsed}
    </p>
  );
}

function GitActionProgressButtonContent({
  progress,
  id,
}: {
  progress: GitActionProgressPresentation;
  id: string;
}) {
  const hasOutput = progress.output !== null;

  return (
    <div
      id={id}
      aria-atomic="false"
      aria-live="polite"
      className={cn(
        "grid min-w-0 flex-1 items-center",
        "grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[1.125rem] gap-x-3",
      )}
      role="status"
    >
      <Spinner aria-hidden="true" className="row-start-1 -mx-0.5 shrink-0" />
      <p
        className={cn(
          "row-start-1 min-w-0 self-baseline truncate text-left",
          THREAD_DETAILS_PANEL_LABEL_CLASS,
        )}
      >
        {progress.status}
      </p>
      <GitActionElapsedTime
        startedAtMs={progress.startedAtMs}
        className="col-start-3 row-start-1 self-baseline text-2xs font-normal tabular-nums text-muted-foreground"
      />
      <div
        className={cn(
          "col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          hasOutput ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground" />
              }
            >
              {progress.output}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-96 break-words">
              {progress.output}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function GitActionSuccessButtonContent({ success }: { success: InlineGitActionSuccess }) {
  const hasDescription = success.description !== null;

  return (
    <div
      aria-live="polite"
      className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[1.125rem] items-center gap-x-3"
      role="status"
    >
      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
      <p className={cn("min-w-0 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {success.title}
      </p>
      <div
        className={cn(
          "col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          hasDescription ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground" />
              }
            >
              {success.description}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-96 break-words">
              {success.description}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

export default memo(function GitActionsControl(props: GitActionsControlProps) {
  const checkoutKey = JSON.stringify([props.activeThreadRef?.environmentId ?? null, props.gitCwd]);
  return <CheckoutGitActionsControl key={checkoutKey} {...props} />;
});

function CheckoutGitActionsControl({
  gitCwd,
  activeThreadRef,
  draftId,
  compact = false,
  showActions = true,
  showChanges = true,
  onOpenChanges,
  workspaceMutationId = null,
}: GitActionsControlProps) {
  const gt = useGT();
  const messages = useMessages();
  const progressLabelId = useId();
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread branch metadata update",
  );
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const canWriteSourceControl = useEnvironmentScope(
    activeEnvironmentId,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(activeEnvironmentId, AuthOrchestrationOperateScope);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threadToastData = activeThreadRef ? { threadRef: activeThreadRef } : undefined;
  const activeServerThreadShell = useQuietThreadShell(activeThreadRef);
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const activeServerThreadProjection = useQuietThreadProjection(
    activeDraftThread !== null && activeServerThreadShell === null ? null : activeThreadRef,
  );
  const activeServerThread =
    activeServerThreadShell ?? activeServerThreadProjection?.projection.thread ?? null;
  const isLocalDraftThread = activeDraftThread !== null && activeServerThread === null;
  const canChangeThreadBranch = canWriteSourceControl && (isLocalDraftThread || canOperateThread);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [inlineSuccess, setInlineSuccess] = useState<InlineGitActionSuccess | null>(null);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const sourceControlScope = { environmentId: activeEnvironmentId, cwd: gitCwd };
  const vcsActionState = useAtomValue(vcsActionManager.stateAtom(sourceControlScope));
  const inlineSuccessExpired = useDeadlinePassed(inlineSuccess?.expiresAtMs ?? null);
  const visibleInlineSuccess = inlineSuccessExpired ? null : inlineSuccess;

  const persistThreadBranchSync = (branch: string | null, manualSelection = false) => {
    if (!activeThreadRef) {
      return;
    }

    if (activeServerThread) {
      if (
        !readEnvironmentScope(activeThreadRef.environmentId, AuthOrchestrationOperateScope) ||
        activeServerThread.branch === branch
      ) {
        return;
      }

      void updateThreadMetadata({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadRef.threadId,
          ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
        },
      });

      return;
    }

    if (!activeDraftThread || activeDraftThread.branch === branch) {
      return;
    }

    setDraftThreadContext(draftId ?? activeThreadRef, {
      branch,
      worktreePath: activeDraftThread.worktreePath,
      environmentSelection: manualSelection
        ? "manual"
        : (activeDraftThread.environmentSelection ??
          (activeDraftThread.branch ? "manual" : "auto")),
    });
  };
  const persistLiveThreadBranch = useEffectEvent((branch: string | null) => {
    persistThreadBranchSync(branch);
  });

  const syncThreadBranchAfterGitAction = (result: GitRunStackedActionResult) => {
    const branchUpdate = resolveThreadBranchUpdate(result);
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch, true);
  };

  const gitStatusQuery = useEnvironmentQuery(
    activeEnvironmentId !== null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: activeEnvironmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const { data: gitStatus, error: gitStatusError } = gitStatusQuery;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = gitStatus;
  const changesBaseRef = useDiffPanelStore((state) =>
    selectThreadBranchBaseRef(state, activeThreadRef),
  );
  const ignoreWhitespaceSetting = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const ignoreWhitespace =
    useDiffPanelSessionStore((state) => state.ignoreWhitespace) ?? ignoreWhitespaceSetting;
  const { canReadFiles } = useFilesystemReadAccess(activeEnvironmentId, messages);
  // Same input as the Diff panel's branch query, so both read one cached result. Status
  // totals join the revision because edits, pulls and resets outside a turn leave the mutation
  // id as is.
  const changesRevision = gitStatusForActions
    ? JSON.stringify([
        workspaceMutationId,
        gitStatusForActions.refName,
        gitStatusForActions.workingTree.insertions,
        gitStatusForActions.workingTree.deletions,
        gitStatusForActions.branchChanges?.baseRef,
        gitStatusForActions.branchChanges?.insertions,
        gitStatusForActions.branchChanges?.deletions,
      ])
    : null;
  const changesPreview = useEnvironmentQuery(
    showChanges &&
      isRepo &&
      canReadFiles &&
      changesRevision !== null &&
      activeEnvironmentId !== null &&
      gitCwd !== null
      ? revisionedQuery(
          reviewEnvironment.diffPreview({
            environmentId: activeEnvironmentId,
            input: {
              cwd: gitCwd,
              ...(changesBaseRef ? { baseRef: changesBaseRef } : {}),
              ignoreWhitespace,
              metadataOnly: true,
              sourceKind: "branch-range",
            },
          }),
          changesRevision,
        )
      : null,
  );
  const resolvedChangesTotals = resolveChangesTotals(
    gitStatusForActions,
    changesPreview.data?.sources.find((source) => source.kind === "branch-range"),
  );
  const changesTotals = resolvedChangesTotals ?? { insertions: 0, deletions: 0 };
  const changesBreakdown = resolvedChangesTotals?.breakdown ?? null;
  const changesBaseLabel = resolvedChangesTotals
    ? resolvedChangesTotals.baseRef === null
      ? gt("Uncommitted")
      : gt("vs {ref}", { ref: resolvedChangesTotals.baseRef })
    : null;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  // Changed-file paths are repository-relative, so they must resolve against
  // the worktree root from the same status snapshot, not the project cwd.
  const workingTreeRoot = gitStatusForActions?.workingTree.rootPath ?? null;
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initAction = useVcsInitAction(sourceControlScope);
  const runImmediateGitAction = useGitStackedAction(sourceControlScope);
  const pullAction = useVcsPullAction(sourceControlScope);
  const isGitActionRunning = useSourceControlActionRunning(
    sourceControlScope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  // Until a clone finishes, the status names an unborn HEAD that the repository may never have.
  const activeProjectClone = useProjectClone(
    activeDraftThread
      ? scopeProjectRef(activeDraftThread.environmentId, activeDraftThread.projectId)
      : null,
  );
  const isProjectCloning = activeProjectClone !== null && activeProjectClone.phase !== "done";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the draft thread branch when the live git status subscription reports a different branch
  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread || isProjectCloning) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistLiveThreadBranch(branchUpdate.branch);
  }, [
    activeServerThread,
    activeDraftThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    isProjectCloning,
    isSelectingWorktreeBase,
  ]);

  const isDefaultRef = gitStatusForActions?.isDefaultRef ?? false;

  const gitActionMenuItems = buildMenuItems(
    gitStatusForActions,
    isGitActionRunning,
    hasPrimaryRemote,
    messages,
  );
  const isDetachedHead = gitStatusForActions?.refName === null;
  const isCleanAndBehind =
    gitStatusForActions !== null &&
    gitStatusForActions.refName !== null &&
    !gitStatusForActions.hasWorkingTreeChanges &&
    gitStatusForActions.behindCount > 0 &&
    gitStatusForActions.aheadCount === 0;
  const hasGitMenuContent = hasUsableGitMenuContent({
    menuItems: gitActionMenuItems,
    canWriteSourceControl,
    canPublishRepository: false,
    hasNotice: isDetachedHead || isCleanAndBehind || Boolean(gitStatusError),
  });

  // A disabled menu cannot refresh on open, and terminal edits or commits publish no status.
  const refreshStatusForEmptyMenu = () =>
    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);

  const quickAction = resolveQuickAction(
    gitStatusForActions,
    isGitActionRunning,
    isDefaultRef,
    hasPrimaryRemote,
    messages,
  );
  const quickActionDisabledReason = !canWriteSourceControl
    ? gt("This connection cannot change source control.")
    : quickAction.disabled
      ? (quickAction.hint ?? gt("This action is currently unavailable."))
      : null;
  const gitActionProgress = resolveGitActionProgressPresentation(vcsActionState, messages);
  // A fresh draft or a thread with no turns hides commit, push, and diff rows until there is work.
  const quietEmptyDraft =
    (draftId !== undefined || activeServerThreadShell?.latestRun === null) &&
    gitActionProgress === null &&
    !gitStatusError &&
    quickAction.disabled &&
    !changesTotals.insertions &&
    !changesTotals.deletions;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy(
        {
          action: pendingDefaultBranchAction.action,
          branchName: pendingDefaultBranchAction.branchName,
          includesCommit: pendingDefaultBranchAction.includesCommit,
        },
        messages,
      )
    : null;
  // Keep enabled until live status loads; the server rejects stale requests.
  const featureBranchUnavailableReason = pendingDefaultBranchAction
    ? resolveFeatureBranchUnavailableReason(
        {
          action: pendingDefaultBranchAction.action,
          branchName: pendingDefaultBranchAction.branchName,
          hasWorkingTreeChanges: gitStatus?.hasWorkingTreeChanges ?? true,
        },
        messages,
      )
    : null;

  useAtomMount(
    vcsStatusRevalidation(
      activeEnvironmentId !== null && gitCwd !== null
        ? { environmentId: activeEnvironmentId, cwd: gitCwd }
        : null,
    ),
  );

  async function runGitActionWithToast({
    action,
    commitMessage,
    onConfirmed,
    skipDefaultBranchPrompt = false,
    statusOverride,
    featureBranch = false,
    filePaths,
  }: RunGitActionWithToastInput) {
    if (
      activeEnvironmentId === null ||
      !readEnvironmentScope(activeEnvironmentId, AuthSourceControlWriteScope) ||
      (featureBranch &&
        !isLocalDraftThread &&
        !readEnvironmentScope(activeEnvironmentId, AuthOrchestrationOperateScope))
    )
      return false;
    const actionStatus = statusOverride ?? gitStatusForActions;
    const actionBranch = actionStatus?.refName ?? null;
    const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
    const actionCanCommit = action === "commit" || action === "commit_push";
    const includesCommit =
      actionCanCommit &&
      (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
    if (
      !skipDefaultBranchPrompt &&
      requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
      actionBranch
    ) {
      if (action !== "push" && action !== "commit_push") {
        return;
      }
      setPendingDefaultBranchAction({
        action,
        branchName: actionBranch,
        includesCommit,
        ...(commitMessage ? { commitMessage } : {}),
        ...(onConfirmed ? { onConfirmed } : {}),
        ...(filePaths ? { filePaths } : {}),
      });
      return false;
    }
    onConfirmed?.();
    setInlineSuccess(null);

    const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
    const actionId = randomUUID();

    const result = await runImmediateGitAction.run({
      actionId,
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(featureBranch ? { featureBranch } : {}),
      ...(filePaths ? { filePaths } : {}),
      ...(activeServerThread ? { threadId: activeServerThread.id } : {}),
      ...(activeDraftThread ? { projectId: activeDraftThread.projectId } : {}),
    });

    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        return false;
      }

      const error = squashAtomCommandFailure(result);
      const errorToastTiming = resolveGitActionResultToastTiming("error");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Action failed"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
          timeout: errorToastTiming.timeout,
          ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
        }),
      );
      return false;
    }

    const actionResult = result.value;
    syncThreadBranchAfterGitAction(actionResult);
    setInlineSuccess({
      title: actionResult.toast.title,
      description: actionResult.toast.description ?? null,
      expiresAtMs: inlineSuccessExpiresAt(),
    });
    return true;
  }

  const continuePendingDefaultBranchAction = (featureBranch: boolean) => {
    if (!pendingDefaultBranchAction || !canWriteSourceControl) return;
    if (featureBranch && (!canChangeThreadBranch || featureBranchUnavailableReason !== null))
      return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch,
      skipDefaultBranchPrompt: true,
    });
  };

  // Keep a typed message for the retry unless the user already started a new one.
  const restoreDialogCommitMessageOnFailure =
    (commitMessage: string) => (committed: boolean | undefined) => {
      if (committed || !commitMessage) return;
      setDialogCommitMessage((current) => current || commitMessage);
    };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    }).then(restoreDialogCommitMessageOnFailure(commitMessage));
  };

  const runQuickAction = () => {
    if (quickAction.kind === "run_pull") {
      void (async () => {
        setInlineSuccess(null);
        const result = await pullAction.run();
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            return;
          }
          const error = squashAtomCommandFailure(result);
          const errorToastTiming = resolveGitActionResultToastTiming("error");
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: gt("Pull failed"),
              description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
              timeout: errorToastTiming.timeout,
              ...(threadToastData !== undefined ? { data: threadToastData } : {}),
            }),
          );
          return;
        }

        const pullResult = result.value;
        const title = pullResult.status === "pulled" ? gt("Pulled") : gt("Already up to date");
        const description =
          pullResult.status === "pulled"
            ? pullResult.upstreamRef
              ? gt("Updated {ref} from {upstream}", {
                  ref: pullResult.refName,
                  upstream: pullResult.upstreamRef,
                })
              : gt("Updated {ref} from upstream", { ref: pullResult.refName })
            : gt("{ref} is already synchronized.", { ref: pullResult.refName });
        setInlineSuccess({
          title,
          description,
          expiresAtMs: inlineSuccessExpiresAt(),
        });
      })();
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    }).then(restoreDialogCommitMessageOnFailure(commitMessage));
  };

  const openChangedFileInEditor = (filePath: string) => {
    if (workingTreeRoot === null) {
      toastManager.add({
        type: "error",
        title: gt("Editor opening is unavailable."),
        data: threadToastData,
      });
      return;
    }
    const target = resolvePathLinkTarget(filePath, workingTreeRoot);
    void (async () => {
      const result = await openInPreferredEditor(target);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Unable to open file"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    })();
  };

  const initializeGit = () => {
    void (async () => {
      const result = await initAction.run();
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Git initialization failed"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    })();
  };
  const gitItems = (
    <>
      {gitActionMenuItems.map((item) => {
        const disabledReason = getMenuActionDisabledReason(
          {
            item,
            gitStatus: gitStatusForActions,
            isBusy: isGitActionRunning,
            hasPrimaryRemote,
          },
          messages,
        );
        if (item.disabled && disabledReason) {
          return (
            <Popover key={`${item.id}-${item.label}`}>
              <PopoverTrigger
                openOnHover
                nativeButton={false}
                render={<span className="block w-full cursor-not-allowed" />}
              >
                <MenuItem className="w-full" disabled>
                  <GitActionItemIcon icon={item.icon} />
                  <MenuItemLabel>{item.label}</MenuItemLabel>
                </MenuItem>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="left" align="center">
                {disabledReason}
              </PopoverPopup>
            </Popover>
          );
        }

        return (
          <MenuItem
            key={`${item.id}-${item.label}`}
            disabled={!canWriteSourceControl || item.disabled}
            onClick={() => {
              openDialogForMenuItem(item);
            }}
          >
            <GitActionItemIcon icon={item.icon} />
            <MenuItemLabel>{item.label}</MenuItemLabel>
          </MenuItem>
        );
      })}
      {isDetachedHead && (
        <p className="px-2 py-1.5 text-xs text-warning">
          <T>Detached HEAD: create and check out a branch to enable push actions.</T>
        </p>
      )}
      {isCleanAndBehind && (
        <p className="px-2 py-1.5 text-xs text-warning">
          <T>Behind upstream. Pull/rebase first.</T>
        </p>
      )}
      {gitStatusError && <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError}</p>}
    </>
  );

  if (!gitCwd) return null;

  return (
    <>
      {!showActions ? null : !isRepo ? (
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="row"
          panel
          disabled={!canWriteSourceControl || initAction.isPending}
          onClick={initializeGit}
        >
          <GitBranchPlusIcon className="size-3.5" aria-hidden />
          <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {initAction.isPending ? <T>Initializing...</T> : <T>Initialize Git</T>}
          </span>
        </ThreadDetailsControl>
      ) : quietEmptyDraft || (compact && !gitActionProgress && !visibleInlineSuccess) ? null : (
        <div
          role="group"
          aria-label={gt("Git actions")}
          ref={panelAnchorRef}
          onPointerEnter={hasGitMenuContent ? undefined : refreshStatusForEmptyMenu}
          onFocus={hasGitMenuContent ? undefined : refreshStatusForEmptyMenu}
          className={cn(
            "shrink-0",
            THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
            gitActionProgress && "bg-black/[0.035] dark:bg-white/[0.055]",
          )}
        >
          {gitActionProgress ? (
            <ThreadDetailsControl
              aria-label={
                gitActionProgress.output
                  ? `${gitActionProgress.status} ${gitActionProgress.output}`
                  : gitActionProgress.status
              }
              part="primary"
              panel
              multiline
              disabled
              size="xs"
              variant="ghost"
            >
              <GitActionProgressButtonContent id={progressLabelId} progress={gitActionProgress} />
            </ThreadDetailsControl>
          ) : visibleInlineSuccess ? (
            <ThreadDetailsControl part="primary" multiline disabled size="xs" variant="ghost">
              <GitActionSuccessButtonContent success={visibleInlineSuccess} />
            </ThreadDetailsControl>
          ) : quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={
                  <ThreadDetailsControl
                    aria-disabled="true"
                    part="primary"
                    panel
                    size="xs"
                    variant="ghost"
                  />
                }
              >
                <GitQuickActionIcon
                  quickAction={quickAction}
                  className={THREAD_DETAILS_PANEL_ICON_CLASS}
                />
                <span
                  className={cn(
                    "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                    cn("not-sr-only ml-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
                  )}
                >
                  {quickAction.label}
                </span>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    data-toolbar-control=""
                    variant="ghost"
                    size="xs"
                    part="primary"
                    panel
                    disabled={!canWriteSourceControl || isGitActionRunning || quickAction.disabled}
                    onClick={runQuickAction}
                  />
                }
              >
                <GitQuickActionIcon
                  quickAction={quickAction}

                  className={THREAD_DETAILS_PANEL_ICON_CLASS}
                />
                <span
                  className={cn(
                    "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                    cn("not-sr-only ml-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
                  )}
                >
                  {quickAction.label}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">{quickAction.label}</TooltipPopup>
            </Tooltip>
          )}
          {!gitActionProgress ? (
            <>
              <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
              <Menu
                onOpenChange={(open) => {
                  if (open) {
                    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
                  }
                }}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <MenuTrigger
                        render={
                          <ThreadDetailsControl
                            aria-label={gt("Git action options")}
                            data-toolbar-control=""
                            size="sm"
                            variant="ghost"
                            part="secondary"
                            panel
                          />
                        }
                        disabled={isGitActionRunning || !hasGitMenuContent}
                      />
                    }
                  >
                    <ChevronDownIcon
                      aria-hidden="true"
                      className={THREAD_DETAILS_PANEL_CHEVRON_CLASS}
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    <T>Git action options</T>
                  </TooltipPopup>
                </Tooltip>
                <MenuPopup align="end" anchor={panelAnchorRef} className="w-(--anchor-width)">
                  {gitItems}
                </MenuPopup>
              </Menu>
            </>
          ) : null}
        </div>
      )}

      {showChanges && isRepo && !quietEmptyDraft ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                type="button"
                variant="ghost"
                size="sm"
                part="row"
                disabled={!onOpenChanges}
                onClick={onOpenChanges}
              />
            }
          >
            <FileDiffIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="shrink-0">
                <T>Changes</T>
              </span>
              {changesBaseLabel ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="pointer-events-auto min-w-0 truncate font-normal text-muted-foreground" />
                    }
                  >
                    {changesBaseLabel}
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-96 break-words">
                    {changesBaseLabel}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              <span className="ml-auto flex shrink-0 items-baseline gap-2 ps-2 font-mono tabular-nums">
                <span
                  className={
                    changesTotals.insertions
                      ? "text-diff-addition-foreground"
                      : "text-muted-foreground"
                  }
                >
                  +{formatDiffCount(changesTotals.insertions)}
                </span>
                <span
                  className={
                    changesTotals.deletions
                      ? "text-diff-deletion-foreground"
                      : "text-muted-foreground"
                  }
                >
                  -{formatDiffCount(changesTotals.deletions)}
                </span>
              </span>
            </span>
          </TooltipTrigger>
          {changesBreakdown && (changesTotals.insertions > 0 || changesTotals.deletions > 0) ? (
            // Base UI fixes the popup width on open; remeasure when the breakdown changes.
            <TooltipPopup key={JSON.stringify(changesBreakdown)} side="bottom">
              <ChangeBreakdownGrid
                breakdown={changesBreakdown}
                total={{ additions: changesTotals.insertions, deletions: changesTotals.deletions }}
              />
            </TooltipPopup>
          ) : null}
        </Tooltip>
      ) : null}

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setDialogCommitMessage("");
            setExcludedFiles(new Set());
            setIsEditingFiles(false);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{messages(COMMIT_DIALOG_TITLE)}</DialogTitle>
            <DialogDescription>{messages(COMMIT_DIALOG_DESCRIPTION)}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3 rounded-xl bg-neutral-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">
                  <T context="git branch">Branch</T>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {gitStatusForActions?.refName ?? gt("(detached HEAD)")}
                  </span>
                  {isDefaultRef && (
                    <span className="text-right text-warning">
                      <T>Default branch</T>
                    </span>
                  )}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        aria-label={gt("Include all files")}
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          setExcludedFiles(
                            allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                          );
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">
                      <T>Files</T>
                    </span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        {gt("({selected} of {total})", {
                          selected: selectedFiles.length,
                          total: allFiles.length,
                        })}
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setIsEditingFiles((prev) => !prev)}
                    >
                      {isEditingFiles ? (
                        <T context="button, finish editing the file list">Done</T>
                      ) : (
                        <T context="verb">Edit</T>
                      )}
                    </Button>
                  )}
                </div>
                {!gitStatusForActions || allFiles.length === 0 ? (
                  <p className="font-medium">
                    <T context="no files">none</T>
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
                      <ScrollArea>
                        <div className="space-y-1 p-1">
                          {allFiles.map((file) => {
                            const isExcluded = excludedFiles.has(file.path);
                            return (
                              <div
                                key={file.path}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
                              >
                                {isEditingFiles && (
                                  <Checkbox
                                    aria-label={gt("Include {path}", { path: file.path })}
                                    checked={!excludedFiles.has(file.path)}
                                    onCheckedChange={() => {
                                      setExcludedFiles((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(file.path)) {
                                          next.delete(file.path);
                                        } else {
                                          next.add(file.path);
                                        }
                                        return next;
                                      });
                                    }}
                                  />
                                )}
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left enabled:cursor-pointer"
                                  disabled={!canOperateThread || workingTreeRoot === null}
                                  aria-label={gt("Open {path} in editor", { path: file.path })}
                                  onClick={() => openChangedFileInEditor(file.path)}
                                >
                                  <StartTruncatedPath
                                    path={file.path}
                                    className={`flex-1${isExcluded ? " text-muted-foreground" : ""}`}
                                  />
                                  <span className="shrink-0">
                                    {isExcluded ? (
                                      <span className="text-muted-foreground">
                                        <T>Excluded</T>
                                      </span>
                                    ) : (
                                      <>
                                        <span className="text-diff-addition">
                                          +{formatDiffCount(file.insertions)}
                                        </span>
                                        <span className="text-muted-foreground"> / </span>
                                        <span className="text-diff-deletion">
                                          -{formatDiffCount(file.deletions)}
                                        </span>
                                      </>
                                    )}
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </div>
                    <div className="flex justify-end font-mono">
                      <span className="text-diff-addition">
                        +{formatDiffCount(selectedFiles.reduce((sum, f) => sum + f.insertions, 0))}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-diff-deletion">
                        -{formatDiffCount(selectedFiles.reduce((sum, f) => sum + f.deletions, 0))}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">
                <T>Commit message (optional)</T>
              </p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder={gt("Leave empty to auto-generate")}
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsCommitDialogOpen(false);
                setDialogCommitMessage("");
                setExcludedFiles(new Set());
                setIsEditingFiles(false);
              }}
            >
              <T>Cancel</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canChangeThreadBranch || noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              <T>Commit on new branch</T>
            </Button>
            <Button
              size="sm"
              disabled={!canWriteSourceControl || noneSelected}
              onClick={runDialogAction}
            >
              <T context="verb">Commit</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDefaultBranchAction(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? gt("Run action on default branch?")}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
            {featureBranchUnavailableReason && (
              <p className="text-xs text-muted-foreground">{featureBranchUnavailableReason}</p>
            )}
          </DialogHeader>
          <DialogFooter variant="bare" className="sm:flex-wrap sm:items-center">
            <Button
              className="w-full sm:mr-auto sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              <T>Abort</T>
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              variant="outline"
              size="sm-multiline"
              onClick={() => continuePendingDefaultBranchAction(false)}
              disabled={!canWriteSourceControl}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? gt("Continue")}
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              size="sm-multiline"
              onClick={() => continuePendingDefaultBranchAction(true)}
              disabled={!canChangeThreadBranch || featureBranchUnavailableReason !== null}
            >
              <T>Check out feature branch & continue</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
