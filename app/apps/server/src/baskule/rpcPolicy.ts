// baskule: the RPC methods and orchestration commands a space serves are allowlisted.
// The list follows the selected product features. Everything else answers
// "unsupported in Baskule". Active only when a host provides `BaskuleRpcPolicy`.
import {
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS as O,
  WS_METHODS as W,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";

/** Selected features → methods. */
export const BASKULE_ALLOWED_METHODS: ReadonlySet<string> = new Set<string>([
  // 1. Chat and conversation controls (search, queue, unread/pin/snooze, questions/approvals).
  O.dispatchCommand,
  O.launchThread,
  O.getThreadProjection,
  O.subscribeShell,
  O.subscribeThread,
  O.getArchivedShellSnapshot,
  O.subscribeArchivedShell,
  O.getTurnItem,
  O.subscribeCommandOutput,
  O.searchThreads,
  O.searchThread,
  O.searchThreadStream,
  // 4. Workflow lifecycle: stop (the script viewer reads host files, so it stays off).
  O.stopWorkflow,
  // 2. Files and attachments (paths are confined by the cell's FileSystem). Listing is per
  // directory (`directoryPath`); search runs on the computer without a native index in the cell.
  W.projectsSearchEntries,
  W.projectsSearchContents,
  W.projectsListEntries,
  W.projectsReadFile,
  W.projectsWriteFile,
  W.projectsEnsureScratch,
  W.assetsCreateUrl,
  W.assetsPersistChatAttachments,
  W.attachmentsCreateUploadUrl,
  W.attachmentsDelete,
  // 5. Interactive MCP applications.
  W.mcpAppsCallTool,
  W.mcpAppsToolInfo,
  W.mcpAppsReadResource,
  W.mcpAppsUpdateModelContext,
  // 3. Scheduled and webhook-triggered work, private secret entry.
  W.scheduledTasksList,
  W.scheduledTasksSubscribe,
  W.scheduledTasksUpsert,
  W.scheduledTasksSetEnabled,
  W.scheduledTasksDelete,
  W.scheduledTasksRunNow,
  W.scheduledTasksRotateWebhookToken,
  W.scheduledTasksListWebhookDeliveries,
  W.scheduledTasksGetWebhookDelivery,
  W.secretsAnswerRequest,
  // 6. Shared browser sessions (the computer side is WP-F).
  W.previewOpen,
  W.previewNavigate,
  W.previewResize,
  W.previewAdjust,
  W.previewRefresh,
  W.previewClose,
  W.previewList,
  W.previewClearProfile,
  W.previewReportProfiles,
  W.previewReportStatus,
  W.subscribePreviewEvents,
  // Client plumbing: config, lifecycle, provider/model list (read-only), presence.
  W.serverProbe,
  W.serverGetConfig,
  W.subscribeServerConfig,
  W.subscribeServerLifecycle,
  W.serverGetSettings,
  W.serverRefreshProviders,
  W.serverReportClientActivity,
  W.serverGetBackgroundPolicy,
  W.subscribeBackgroundPolicy,
]);

/** `orchestration.dispatchCommand` command types a client may send. */
export const BASKULE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set<string>([
  "thread.create",
  "thread.stop",
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
  "thread.active.reorder",
  "thread.visit",
  "thread.mark-unread",
  "thread.metadata.update",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.model-selection.set",
  "provider-session.detach",
  "provider.switch",
  "message.dispatch",
  "prepared-run.release",
  "prepared-run.progress",
  "prepared-run.fail",
  "prepared-run.retry",
  "notification.delivery.accept",
  "run.interrupt",
  "queued-message.promote-to-steer",
  "queue.resume",
  "queued-run.reorder",
  "queued-run.cancel",
  "queued-run.edit",
  "runtime-request.respond",
  "thread.user-input.dismiss",
  "subagent.stop",
  "delegated_task.request",
  "delegated_task.wake-policy",
  "delegated_task.completion-delivery.acknowledge",
  "delegated_task.completion-delivery.dispose",
  "thread.created.record",
  "thread.fork",
  "thread.merge_back",
  "checkpoint.rollback",
  // Off: settle/unsettle (no Done inbox in Baskule; the capability is advertised off and
  // auto-settlement is disabled in managedSettings.ts), pull requests (thread.pull-request*),
  // title regeneration (server-produced).
]);

/**
 * T3's own MCP tools offered to the space's agent (OpenCode in the AgentCell, through the platform's
 * bridge): delegation, other conversations (create, read, message, organize, fork/merge, queue,
 * pending questions), attachments, scheduled work, private secret entry, inline HTML (`html_render`)
 * and the shared browser. Off: `html_preview` (needs a headless Chrome on the cell's host), project,
 * worktree, pull-request, device and environment-preference tools.
 */
export const BASKULE_ALLOWED_MCP_TOOLS: ReadonlySet<string> = new Set<string>([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_workflow_stop",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "request_secret",
  "run_scheduled_task_now",
  "create_threads",
  "t3_thread_launch",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_thread_organize",
  "t3_thread_configure",
  "t3_thread_transfer",
  "t3_queue",
  "t3_pending_request",
  "t3_attachment_prepare_upload",
  "t3_attachment_discard",
  "t3_thread_send_attachments",
  "html_render",
  "preview_status",
  "preview_open",
  "preview_dialog",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_act",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
  "t3_preview_list",
  "t3_preview_close",
]);

export interface BaskuleRpcPolicyService {
  readonly methods: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
  /** MCP tools T3 registers on `/mcp`; the others are not registered at all. */
  readonly mcpTools?: ReadonlySet<string>;
}

export class BaskuleRpcPolicy extends Context.Reference<BaskuleRpcPolicyService | undefined>(
  "baskule/BaskuleRpcPolicy",
  { defaultValue: () => undefined },
) {}

export const BASKULE_POLICY: BaskuleRpcPolicyService = {
  methods: BASKULE_ALLOWED_METHODS,
  commands: BASKULE_ALLOWED_COMMANDS,
  mcpTools: BASKULE_ALLOWED_MCP_TOOLS,
};

/** The reason a call is refused, or undefined when the policy allows it. */
export const baskuleRefusal = (
  policy: BaskuleRpcPolicyService,
  method: string,
  payload: unknown,
): string | undefined => {
  if (!policy.methods.has(method)) return `${method} is unsupported in Baskule.`;
  if (method === O.dispatchCommand) {
    const type = (payload as { readonly type?: unknown } | null)?.type;
    if (typeof type !== "string" || !policy.commands.has(type)) {
      return `The ${String(type)} command is unsupported in Baskule.`;
    }
  }
  return undefined;
};

export const baskuleUnsupportedError = (message: string, requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message,
    requiredScope,
    requiredPermission: "baskule:unsupported",
  });
