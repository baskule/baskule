import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";

export type GitActionIconName = "commit" | "push";

export type GitDialogAction = "commit" | "push";

export interface GitActionMenuItem {
  id: "commit" | "push";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction = "push" | "commit_push";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "action" | "commitMessage" | "featureBranch" | "filePaths"
>;

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const canPush =
    !isBusy &&
    gitStatus.refName !== null &&
    !gitStatus.hasWorkingTreeChanges &&
    gitStatus.behindCount === 0 &&
    (!gitStatus.hasUpstream || gitStatus.aheadCount > 0) &&
    (gitStatus.hasUpstream || hasOriginRemote);
  return [
    {
      id: "commit",
      label: "Commit",
      disabled: isBusy || !gitStatus.hasWorkingTreeChanges,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: "Push",
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
): GitQuickAction {
  if (isBusy)
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  if (!gitStatus)
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  if (gitStatus.refName === null)
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Create and checkout a branch before pushing.",
    };
  const behind = gitStatus.behindCount > 0;
  const ahead = gitStatus.aheadCount > 0;
  if (gitStatus.hasWorkingTreeChanges)
    return behind || (!gitStatus.hasUpstream && !hasOriginRemote)
      ? { label: "Commit", disabled: false, kind: "run_action", action: "commit" }
      : { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
  if (!gitStatus.hasUpstream && !hasOriginRemote)
    return {
      label: "Push",
      disabled: true,
      kind: "show_hint",
      hint: 'Add an "origin" remote before pushing.',
    };
  if (ahead && behind)
    return {
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  if (behind) return { label: "Pull", disabled: false, kind: "run_pull" };
  if (ahead || !gitStatus.hasUpstream)
    return {
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: isDefaultBranch ? "commit_push" : "push",
    };
  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

export function getGitActionDisabledReason(input: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: checkout a branch before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  return null;
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return action === "push" || action === "commit_push";
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` on "${branchLabel}". You can continue on this branch or create a feature branch and run the same action there.`;
  if (input.includesCommit) {
    return {
      title: "Commit & push to default branch?",
      description: `This action will commit and push changes${suffix}`,
      continueLabel: `Commit & push to ${branchLabel}`,
    };
  }
  return {
    title: "Push to default branch?",
    description: `This action will push local commits${suffix}`,
    continueLabel: `Push to ${branchLabel}`,
  };
}
