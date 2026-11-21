import { type MFunctionType } from "gt-i18n/types";
import { mFallback, msg } from "gt-i18n";
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
  resolve: MFunctionType = mFallback,
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
      label: resolve(msg("Commit")),
      disabled: isBusy || !gitStatus.hasWorkingTreeChanges,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: resolve(msg("Push", { $context: "verb, git action" })),
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
  resolve: MFunctionType = mFallback,
): GitQuickAction {
  if (isBusy)
    return {
      label: resolve(msg("Commit")),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git action in progress.")),
    };
  if (!gitStatus)
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git status is unavailable.")),
    };
  if (gitStatus.refName === null)
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Create and checkout a branch before pushing.")),
    };
  const behind = gitStatus.behindCount > 0;
  const ahead = gitStatus.aheadCount > 0;
  if (gitStatus.hasWorkingTreeChanges)
    return behind || (!gitStatus.hasUpstream && !hasOriginRemote)
      ? { label: resolve(msg("Commit")), disabled: false, kind: "run_action", action: "commit" }
      : {
          label: resolve(msg("Commit & push")),
          disabled: false,
          kind: "run_action",
          action: "commit_push",
        };
  if (!gitStatus.hasUpstream && !hasOriginRemote)
    return {
      label: resolve(msg("Push")),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg('Add an "origin" remote before pushing.')),
    };
  if (ahead && behind)
    return {
      label: resolve(msg("Sync branch")),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Branch has diverged from upstream. Rebase/merge first.")),
    };
  if (behind) return { label: resolve(msg("Pull")), disabled: false, kind: "run_pull" };
  if (ahead || !gitStatus.hasUpstream)
    return {
      label: resolve(msg("Push")),
      disabled: false,
      kind: "run_action",
      action: isDefaultBranch ? "commit_push" : "push",
    };
  return {
    label: resolve(msg("Commit", { $context: "verb, git action" })),
    disabled: true,
    kind: "show_hint",
    hint: resolve(msg("Branch is up to date. No action needed.")),
  };
}

export function getGitActionDisabledReason(
  input: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasOriginRemote: boolean;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return resolve(msg("Git action in progress."));
  if (!gitStatus) return resolve(msg("Git status is unavailable."));

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return resolve(msg("Worktree is clean. Make changes before committing."));
    }
    return resolve(msg("Commit is currently unavailable."));
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return resolve(msg("Detached HEAD: checkout a branch before pushing."));
    }
    if (hasChanges) {
      return resolve(msg("Commit or stash local changes before pushing."));
    }
    if (isBehind) {
      return resolve(msg("Branch is behind upstream. Pull/rebase before pushing."));
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return resolve(msg('Add an "origin" remote before pushing.'));
    }
    if (!isAhead) {
      return resolve(msg("No local commits to push."));
    }
    return resolve(msg("Push is currently unavailable."));
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

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
  },
  resolve: MFunctionType = mFallback,
): DefaultBranchActionDialogCopy {
  const branch = input.branchName;
  if (input.includesCommit) {
    return {
      title: resolve(msg("Commit & push to default branch?")),
      description: resolve(
        msg(
          'This action will commit and push changes on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
          { branch },
        ),
      ),
      continueLabel: resolve(msg("Commit & push to {branch}", { branch })),
    };
  }
  return {
    title: resolve(msg("Push to default branch?")),
    description: resolve(
      msg(
        'This action will push local commits on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
        { branch },
      ),
    ),
    continueLabel: resolve(msg("Push to {branch}", { branch })),
  };
}
