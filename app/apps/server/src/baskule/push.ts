import {
  CommandId,
  EnvironmentId,
  RuntimeRequestId,
  type ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import type { PushNotification } from "@t3tools/contracts/baskulePush";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import { runInputAuthor } from "./usageAuthor.ts";

export class BaskulePushHost extends Context.Reference<
  | {
      deliver: (notification: PushNotification) => Promise<void>;
      changed: () => Promise<void>;
    }
  | undefined
>("BaskulePushHost", { defaultValue: () => undefined }) {}

export const currentPushNotification = Effect.fn("Baskule.currentPushNotification")(function* (
  threadId: ThreadId,
  store: Pick<ProjectionStoreV2Shape, "getThreadShell" | "getThreadRecords">,
) {
  const shell = yield* store.getThreadShell(threadId);
  if (!shell || shell.archivedAt !== null) return null;
  const state = projectThreadAwarenessV2({
    environmentId: EnvironmentId.make("baskule"),
    project: { title: "" },
    thread: shell,
  });
  const kind =
    state?.phase === "completed"
      ? "completion"
      : state?.phase === "failed"
        ? "failure"
        : state?.phase === "waiting_for_approval"
          ? "approval"
          : state?.phase === "waiting_for_input"
            ? "input"
            : null;
  if (!kind || !state) return null;
  let runId = shell.latestRunId;
  let identity: string | null = runId;
  if (kind === "approval" || kind === "input") {
    const records = yield* store.getThreadRecords(threadId, ["runtimeRequests"]);
    const request = records.runtimeRequests.find(
      (r) => r.id === shell.pendingRuntimeRequest?.id && r.status === "pending",
    );
    if (request) {
      const nodes = yield* store.getThreadRecords(threadId, ["nodes"]);
      runId = nodes.nodes.find((n) => n.id === request.nodeId)?.runId ?? null;
      identity = request.id;
    } else {
      const items = yield* store.getThreadRecords(threadId, ["turnItems"]);
      const secret = items.turnItems.find(
        (item) =>
          RuntimeRequestId.make(item.id) === shell.pendingRuntimeRequest?.id &&
          item.type === "secret_request" &&
          item.status === "waiting",
      );
      if (!secret) return null;
      runId = secret.runId;
      identity = secret.id;
    }
  }
  if (!identity || !runId) return null;
  const author = yield* runInputAuthor(threadId, runId, store.getThreadRecords);
  if (!author) return null;
  return {
    eventId: `push:${kind}:${identity}`,
    threadId,
    userId: author.id,
    kind,
    title: state.headline,
    body: shell.title.slice(0, 200),
  } satisfies Omit<PushNotification, "expiresAt">;
});

export const pushEffect = (notification: PushNotification, threadId: ThreadId) => ({
  id: notification.eventId,
  commandId: CommandId.make(notification.eventId),
  threadId,
  request: { type: "baskule.push" as const, notification },
});

export function pushEventThreads(events: ReadonlyArray<OrchestrationV2StoredEvent>) {
  return new Set(
    events
      .filter(
        ({ event }) =>
          event.type === "run.updated" ||
          event.type === "runtime-request.updated" ||
          event.type === "provider-thread.updated" ||
          (event.type === "turn-item.updated" &&
            (event.payload.type === "secret_request" ||
              turnItemUpdateCanEndBackgroundWork(event.payload))),
      )
      .map(({ event }) => event.threadId),
  );
}
