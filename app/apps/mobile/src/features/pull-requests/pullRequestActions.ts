import { t } from "../../i18n";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { PullRequestGlyph } from "./pullRequestGlyphs";

type ActionDetail = Pick<
  PullRequestDetail,
  "state" | "isDraft" | "mergeability" | "autoMergeEnabled" | "workflowApprovalsRequired"
> & {
  readonly capabilities: Pick<
    PullRequestDetail["capabilities"],
    "actions" | "mergeMethods" | "updateMethods" | "deleteBranch"
  >;
  readonly viewerPermissions: Pick<
    PullRequestDetail["viewerPermissions"],
    "actions" | "updateMethods"
  >;
  readonly mergeCapabilities: PullRequestDetail["mergeCapabilities"];
};

export const MERGE_METHODS = {
  squash: {
    get title() {
      return t("Squash and merge");
    },
    get description() {
      return t("Combine the commits into one commit.");
    },
  },
  merge: {
    get title() {
      return t("Create a merge commit");
    },
    get description() {
      return t("Keep the commits and add a merge commit.");
    },
  },
  rebase: {
    get title() {
      return t("Rebase and merge");
    },
    get description() {
      return t("Add the commits without a merge commit.");
    },
  },
} as const satisfies Record<PullRequestMergeMethod, { title: string; description: string }>;

export const PR_ACTION_LABELS = {
  get merge() {
    return t("Merge pull request");
  },
  get ready() {
    return t("Mark ready for review");
  },
  get draft() {
    return t("Convert to draft");
  },
  get close() {
    return t("Close pull request");
  },
  get reopen() {
    return t("Reopen pull request");
  },
  get "update-branch"() {
    return t("Update branch");
  },
  get "enable-auto-merge"() {
    return t("Enable auto-merge");
  },
  get "disable-auto-merge"() {
    return t("Disable auto-merge");
  },
  get revert() {
    return t("Create revert pull request");
  },
  get "delete-branch"() {
    return t("Delete branch");
  },
  get "approve-workflows"() {
    return t("Approve workflows");
  },
} as const satisfies Record<PullRequestAction, string>;

export const PR_ACTION_ICONS = {
  merge: PullRequestGlyph.merged,
  ready: "checkmark.circle",
  draft: "pencil",
  close: "xmark",
  reopen: "arrow.clockwise",
  "update-branch": "arrow.up.circle",
  "enable-auto-merge": "clock",
  "disable-auto-merge": "xmark",
  revert: "arrow.uturn.backward",
  "delete-branch": "trash",
  "approve-workflows": "checkmark",
} as const satisfies Record<PullRequestAction, AppSymbolName>;

export const ALL_PR_ACTIONS: readonly PullRequestAction[] = [
  "merge",
  "ready",
  "draft",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
  "approve-workflows",
  "close",
  "reopen",
  "revert",
  "delete-branch",
];

export function allowedMergeMethods(pr: ActionDetail) {
  return pr.capabilities.mergeMethods.filter((method) => pr.mergeCapabilities[method]);
}

export function allowedUpdateMethods(pr: ActionDetail) {
  return (pr.capabilities.updateMethods ?? []).filter((method) =>
    pr.viewerPermissions.updateMethods?.includes(method),
  );
}

export function canPerformPullRequestAction(pr: ActionDetail, action: PullRequestAction) {
  if (!pr.capabilities.actions.includes(action) || !pr.viewerPermissions.actions.includes(action))
    return false;
  if (action === "reopen") return pr.state === "closed";
  if (action === "revert") return pr.state === "merged";
  if (action === "delete-branch")
    return pr.state !== "open" && pr.capabilities.deleteBranch === true;
  if (pr.state !== "open") return false;
  switch (action) {
    case "update-branch":
      return allowedUpdateMethods(pr).length > 0;
    case "approve-workflows":
      return (pr.workflowApprovalsRequired ?? 0) > 0;
    case "ready":
      return pr.isDraft;
    case "draft":
      return !pr.isDraft;
    case "merge":
      return !pr.isDraft && pr.mergeability !== "conflicting" && allowedMergeMethods(pr).length > 0;
    case "enable-auto-merge":
      return !pr.isDraft && pr.autoMergeEnabled === false && allowedMergeMethods(pr).length > 0;
    case "disable-auto-merge":
      return pr.autoMergeEnabled === true;
    default:
      return true;
  }
}

export const MERGE_CONFLICT_REASON = "Resolve the branch conflicts before merging.";

export function mergeUnavailableReason(pr: ActionDetail, connectionAllowsWrites: boolean) {
  if (pr.state === "merged") return t("This pull request has been merged.");
  if (pr.state === "closed") return t("Reopen this pull request before merging.");
  if (!connectionAllowsWrites) return t("This environment connection is read-only.");
  if (!pr.capabilities.actions.includes("merge"))
    return t("This provider does not support merging here.");
  if (!pr.viewerPermissions.actions.includes("merge"))
    return t("Your account cannot merge this pull request.");
  if (pr.isDraft) return t("Mark this draft ready for review before merging.");
  if (pr.mergeability === "conflicting") return MERGE_CONFLICT_REASON;
  if (!allowedMergeMethods(pr).length) return t("This repository has no available merge methods.");
  return null;
}

export function mergeSummary(
  pr: ActionDetail & Pick<PullRequestDetail, "autoMergeMethod">,
  connectionAllowsWrites: boolean,
) {
  if (pr.state === "merged") return t("Merged");
  if (pr.state === "closed") return t("Closed");
  if (pr.isDraft) return t("Draft");
  if (pr.mergeability === "conflicting") return t("Has conflicts");
  if (!connectionAllowsWrites) return t("Read-only connection");
  const allowed = allowedMergeMethods(pr);
  const method = pr.autoMergeMethod ?? (allowed.includes("squash") ? "squash" : allowed[0]);
  const methodLabel = method ? `${method[0]?.toUpperCase()}${method.slice(1)}` : "Merge";
  if (pr.autoMergeEnabled) return `${methodLabel} · auto-merge on`;
  if (mergeUnavailableReason(pr, connectionAllowsWrites)) return t("Unavailable");
  return `${methodLabel}${pr.autoMergeEnabled === false ? " · auto-merge off" : ""}`;
}

export const openOnProviderLabel = (provider: SourceControlProviderKind) =>
  `Open on ${sourceControlClients.get(provider).label}`;
