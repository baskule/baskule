import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  RuntimeRequestId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Positions from "../orchestration-v2/TurnItemPositionStore.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import { currentPushNotification, BaskulePushHost } from "./push.ts";

const threadId = ThreadId.make("push-thread"),
  runId = RunId.make("push-run"),
  messageId = MessageId.make("push-message");
const instanceId = ProviderInstanceId.make("opencode");
const now = DateTime.makeUnsafe("2026-10-01T12:00:00Z");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "My chat",
  createdBy: "user",
  creationSource: "mobile",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const run: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: messageId,
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
};
const message: OrchestrationV2ConversationMessage = {
  id: messageId,
  threadId,
  runId,
  nodeId: null,
  role: "user",
  text: "Work",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "mobile",
  author: { id: "alice", name: "Alice" },
  createdAt: now,
  updatedAt: now,
};
let sequence = 0;
const event = <T extends OrchestrationV2DomainEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationV2DomainEvent, { type: T }>["payload"],
) => ({ id: EventId.make(`push-event-${++sequence}`), threadId, occurredAt: now, type, payload });
const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  Receipts.layer,
  Positions.layer,
  Outbox.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory));
const sinkLayer = EventSink.layerFromStores.pipe(Layer.provideMerge(stores));
const hostLayer = Layer.succeed(BaskulePushHost, {
  deliver: async () => {},
  changed: async () => {},
});
const testLayer = sinkLayer.pipe(Layer.provideMerge(hostLayer));
const seed = (overrides: Partial<OrchestrationV2AppThread> = {}, sourceRun = run) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        event("thread.created", { ...thread, ...overrides }),
        event("message.updated", message),
        event("run.updated", sourceRun),
      ],
    });
  });

it.effect(
  "commits notification effects atomically, attributes completed runs and deduplicates metadata updates",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2,
        outbox = yield* Outbox.EffectOutboxV2,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* sink.write({
        events: [
          event("run.updated", { ...run, completedAt: DateTime.addDuration(now, "1 second") }),
        ],
      });
      const rows = yield* sql<{
        effect_id: string;
        payload_json: string;
      }>`select effect_id,payload_json from orchestration_v2_effect_outbox where effect_type='baskule.push'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.effect_id, "push:completion:push-run");
      assert.equal(JSON.parse(rows[0]!.payload_json).notification.userId, "alice");
      const next = yield* outbox.claimNext({ workerId: "worker1", leaseDurationMs: 1000 });
      assert.isTrue(Option.isSome(next));
      const recovery = yield* outbox.reconcileAfterProcessLoss;
      assert.equal(recovery.requeued, 1);
      const recovered = yield* outbox.claimNext({ workerId: "worker2", leaseDurationMs: 1000 });
      assert.isTrue(Option.isSome(recovered));
      const id = Option.getOrThrow(recovered).id;
      yield* outbox.retry({
        effectId: id,
        workerId: "worker2",
        error: "provider unavailable",
        delayMs: 5000,
      });
      const wake = yield* outbox.nextClaimableAt;
      assert.equal(
        DateTime.toEpochMillis(Option.getOrThrow(wake)),
        (yield* DateTime.now).epochMilliseconds + 5000,
      );
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "worker3", leaseDurationMs: 1000 })),
      );
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(
        Option.isSome(yield* outbox.claimNext({ workerId: "worker3", leaseDurationMs: 1000 })),
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rolls back both event and effect when projection storage rejects the write", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      sink = yield* EventSink.EventSinkV2;
    yield* seed();
    yield* sql`delete from orchestration_v2_effect_outbox`;
    yield* sql`CREATE TRIGGER reject_push BEFORE INSERT ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(ABORT, 'test interruption'); END`;
    const before = yield* sink.latestSequence();
    const result = yield* Effect.exit(sink.write({ events: [event("run.updated", run)] }));
    assert.equal(result._tag, "Failure");
    assert.equal(yield* sink.latestSequence(), before);
    assert.equal((yield* sql`select * from orchestration_v2_effect_outbox`).length, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("excludes subagents from committed push effects", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed({
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        rootThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
      },
    });
    assert.equal((yield* sql`select * from orchestration_v2_effect_outbox`).length, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("drops a resolved runtime request before provider delivery", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2,
      store = yield* ProjectionStore.ProjectionStoreV2;
    yield* seed();
    const nodeId = NodeId.make("approval-node");
    const requestId = RuntimeRequestId.make("approval1");
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId,
      runId,
      rootNodeId: nodeId,
      parentNodeId: null,
      kind: "user_input_request",
      status: "waiting",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const pending: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: now,
      resolvedAt: null,
    };
    yield* sink.write({
      events: [event("node.updated", node), event("runtime-request.updated", pending)],
    });
    const candidate = yield* currentPushNotification(threadId, store);
    assert.equal(candidate?.eventId, "push:input:approval1");
    assert.equal(candidate?.userId, "alice");
    yield* sink.write({
      events: [
        event("runtime-request.updated", { ...pending, status: "resolved", resolvedAt: now }),
      ],
    });
    assert.notEqual(
      (yield* currentPushNotification(threadId, store))?.eventId,
      "push:input:approval1",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("waits for committed background work to finish before enqueuing completion", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2,
      sql = yield* SqlClient.SqlClient;
    const providerThreadId = ProviderThreadId.make("background-thread");
    yield* seed(
      { activeProviderThreadId: providerThreadId },
      { ...run, status: "running", completedAt: null, providerThreadId },
    );
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: ProviderDriverKind.make("opencode"),
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor", awaited: true }],
      contextUsage: null,
      nativeMetadata: null,
      goal: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* sink.write({
      events: [
        event("provider-thread.updated", providerThread),
        event("run.updated", { ...run, providerThreadId }),
      ],
    });
    assert.equal((yield* sql`select * from orchestration_v2_effect_outbox`).length, 0);
    yield* sink.write({
      events: [event("provider-thread.updated", { ...providerThread, pendingBackgroundTasks: [] })],
    });
    assert.equal((yield* sql`select * from orchestration_v2_effect_outbox`).length, 1);
  }).pipe(Effect.provide(testLayer)),
);
