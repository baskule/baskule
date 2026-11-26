import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  NodeId,
  RunId,
  RunAttemptId,
  MessageId,
  EventId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeSubagentChildThread,
  subagentResultForRun,
  makeSubagentConversationArtifacts,
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
  PROVIDER_STOP_REASON_SIGNAL,
} from "@t3tools/provider-core/server/subagentProjection";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { resolveAutoSettlementAt } from "./ThreadSettlementService.ts";

const parentThreadId = ThreadId.make("thread:subagent-snoozed-parent");
const childThreadId = ThreadId.make("thread:subagent-awake-child");
const parentProviderInstanceId = ProviderInstanceId.make("codex");
const childProviderInstanceId = ProviderInstanceId.make("claude");
const parentModelSelection = {
  instanceId: parentProviderInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const childModelSelection = {
  instanceId: childProviderInstanceId,
  model: "claude-opus-4-1",
} satisfies ModelSelection;
const parentCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const childCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeParentThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: parentThreadId,
    projectId: ProjectId.make("project:subagent-snooze"),
    title: "Snoozed parent",
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:subagent-snoozed-parent"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: parentThreadId,
    },
    forkedFrom: null,
    createdAt: parentCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
    historyOrigin: "v1_import",
  };
}

it.effect.each(["provider", "mcp"] as const)(
  "a %s child does not inherit parent settlement protections and settles once its parent settles",
  (creationSource) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const parentThread = {
        ...makeParentThread(),
        pinnedAt: parentCreatedAt,
        pinOrderKey: "a0",
        autoSettleDisabledAt: parentCreatedAt,
      };
      const childThread = makeSubagentChildThread({
        parentThread,
        childThreadId,
        parentNodeId: NodeId.make("node:subagent-parent"),
        activeProviderThreadId: null,
        providerInstanceId: childProviderInstanceId,
        modelSelection: childModelSelection,
        title: "Child",
        now: childCreatedAt,
        createdBy: "agent",
        creationSource,
      });

      assert.equal(parentThread.pinnedAt, parentCreatedAt);
      assert.equal(parentThread.pinOrderKey, "a0");
      assert.isNull(childThread.pinnedAt);
      assert.isNull(childThread.pinOrderKey);
      assert.isNull(childThread.autoSettleDisabledAt);

      for (const thread of [parentThread, childThread]) {
        yield* store.apply({
          id: EventId.make(`event:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: thread.createdAt,
          payload: thread,
        });
      }
      const savedParent = yield* store.getThread(parentThreadId);
      assert.deepEqual(savedParent.pinnedAt, parentCreatedAt);
      assert.equal(savedParent.pinOrderKey, "a0");
      assert.deepEqual(savedParent.autoSettleDisabledAt, parentCreatedAt);
      // A subagent child waits for its parent, so settle the pinned parent first.
      assert.deepEqual(yield* store.getSettlementCandidates(), []);
      yield* store.apply({
        id: EventId.make(`event:${parentThreadId}:settled`),
        type: "thread.settled",
        threadId: parentThreadId,
        occurredAt: childCreatedAt,
        payload: {
          ...savedParent,
          settledOverride: "settled",
          settledAt: childCreatedAt,
          pinnedAt: null,
          pinOrderKey: null,
        },
      });
      const candidates = yield* store.getSettlementCandidates();
      assert.deepEqual(
        candidates.map((candidate) => candidate.id),
        [childThreadId],
      );
      const settledAt = resolveAutoSettlementAt({
        thread: candidates[0]!,
        nowMs: DateTime.toEpochMillis(DateTime.add(childCreatedAt, { days: 4 })),
        autoSettleAfterDays: 3,
      });
      assert.equal(settledAt && DateTime.formatIso(settledAt), DateTime.formatIso(childCreatedAt));
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

function taskFixture() {
  const projection = ProjectionStore.emptyProjection({
    type: "thread.created",
    id: EventId.make("task-fixture"),
    threadId: parentThreadId,
    occurredAt: parentCreatedAt,
    payload: makeParentThread(),
  });
  const run: OrchestrationV2Run = {
    id: RunId.make("initial"),
    threadId: parentThreadId,
    ordinal: 1,
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("prompt"),
    rootNodeId: NodeId.make("root"),
    activeAttemptId: RunAttemptId.make("attempt"),
    status: "completed",
    requestedAt: parentCreatedAt,
    startedAt: parentCreatedAt,
    completedAt: childCreatedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
  return { projection: { ...projection, runs: [run] }, run };
}

it("exposes the provider failure rather than a progress message from the failed run", () => {
  const { projection, run } = taskFixture();
  const failedRun = { ...run, status: "failed" as const };
  const artifacts = makeSubagentConversationArtifacts({
    messageId: MessageId.make("progress"),
    turnItemId: TurnItemId.make("error"),
    threadId: parentThreadId,
    rootNodeId: NodeId.make("root"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    role: "assistant",
    text: "Starting the audit.",
    ordinal: 1,
    now: childCreatedAt,
  });
  if (artifacts.turnItem.type !== "assistant_message") throw new Error("Expected assistant item");
  const failure = {
    class: "unknown" as const,
    message: "You've hit your usage limit. Try again Sep 14 at 7:20 PM.",
    code: null,
    retryable: false,
  };
  const result = subagentResultForRun(
    {
      ...projection,
      messages: [{ ...artifacts.message, runId: run.id }],
      turnItems: [{ ...artifacts.turnItem, type: "error", runId: run.id, failure }],
    },
    failedRun,
  );
  assert.equal(result.text, failure.message);
  assert.equal(result.turnItemId, artifacts.turnItem.id);
  assert.isNull(result.messageId);
});

it("reports a provider's stop reason with and without assistant progress", () => {
  const { projection, run } = taskFixture();
  const notice = {
    id: IdAllocator.derive.runSignalTurnItem({
      runId: run.id,
      signal: PROVIDER_STOP_REASON_SIGNAL,
    }),
    threadId: parentThreadId,
    runId: run.id,
    nodeId: NodeId.make("root"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 98,
    status: "completed",
    title: "Stopped by the provider",
    startedAt: childCreatedAt,
    completedAt: childCreatedAt,
    updatedAt: childCreatedAt,
    type: "system_notice",
    level: "warning",
    message: "sessionStart hook (user): Plugin guard blocked this session.",
  } satisfies OrchestrationV2TurnItem;
  assert.equal(
    subagentResultForRun({ ...projection, turnItems: [notice] }, run).text,
    `Child task completed without an assistant result.\n\n${notice.message}`,
  );
  const progress = makeSubagentConversationArtifacts({
    messageId: MessageId.make("before-hook-stop"),
    turnItemId: TurnItemId.make("before-hook-stop"),
    threadId: parentThreadId,
    rootNodeId: NodeId.make("root"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    role: "assistant",
    text: "I am checking the remaining files.",
    ordinal: 1,
    now: childCreatedAt,
  });
  assert.equal(
    subagentResultForRun(
      {
        ...projection,
        messages: [{ ...progress.message, runId: run.id }],
        turnItems: [{ ...progress.turnItem, runId: run.id }, notice],
      },
      run,
    ).text,
    `${progress.message.text}\n\n${notice.message}`,
  );
  const interruptResult = {
    ...notice,
    id: IdAllocator.derive.runSignalTurnItem({ runId: run.id, signal: "interrupt-result" }),
    status: "interrupted",
    title: "Interrupted",
    type: "run_interrupt_result",
  } satisfies OrchestrationV2TurnItem;
  assert.equal(
    subagentResultForRun(
      {
        ...projection,
        messages: [{ ...progress.message, runId: run.id }],
        turnItems: [{ ...progress.turnItem, runId: run.id }, interruptResult],
      },
      { ...run, status: "interrupted" },
    ).text,
    `${progress.message.text}\n\n${notice.message}`,
  );
});

it("keeps the final report of a run that failed after its turn ended", () => {
  const { projection, run } = taskFixture();
  const failedRun = { ...run, status: "failed" as const };
  const artifacts = makeSubagentConversationArtifacts({
    messageId: MessageId.make("report"),
    turnItemId: TurnItemId.make("report"),
    threadId: parentThreadId,
    rootNodeId: NodeId.make("root"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    role: "assistant",
    text: "Review complete: no blocking issues.",
    ordinal: 1,
    now: childCreatedAt,
  });
  if (artifacts.turnItem.type !== "assistant_message") throw new Error("Expected assistant item");
  const failure = {
    class: "unknown" as const,
    message: "Connection failed repeatedly",
    code: null,
    retryable: false,
  };
  const result = subagentResultForRun(
    {
      ...projection,
      messages: [{ ...artifacts.message, runId: run.id }],
      turnItems: [
        { ...artifacts.turnItem, runId: run.id },
        {
          ...artifacts.turnItem,
          id: TurnItemId.make("error"),
          ordinal: 2,
          type: "error",
          runId: run.id,
          failure,
        },
      ],
    },
    failedRun,
  );
  assert.include(result.text, failure.message);
  assert.include(result.text, "Review complete: no blocking issues.");
});

it("orders a task's assistant messages by turn item, not by timestamps", () => {
  const { projection, run } = taskFixture();
  const at = DateTime.makeUnsafe("2026-07-24T10:05:00.000Z");
  const message = (id: string, text: string, ordinal: number) => {
    const artifacts = makeSubagentConversationArtifacts({
      messageId: MessageId.make(id),
      turnItemId: TurnItemId.make(id),
      threadId: parentThreadId,
      rootNodeId: NodeId.make("root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role: "assistant",
      text,
      ordinal,
      now: at,
    });
    return {
      message: { ...artifacts.message, runId: run.id },
      turnItem: { ...artifacts.turnItem, runId: run.id },
    };
  };
  const progress = message("progress", "Starting step 0.", 1);
  const report = message("report", "All steps passed.", 2);
  const result = subagentResultForRun(
    {
      ...projection,
      messages: [progress.message, report.message],
      turnItems: [report.turnItem, progress.turnItem],
    },
    run,
  );
  assert.equal(result.text, "All steps passed.");
  assert.equal(result.messageId, report.message.id);
  assert.equal(result.turnItemId, report.turnItem.id);
  const reported = { runAttemptId: run.activeAttemptId, ordinal: 1, model: "gpt-5.4-mini" };
  assert.equal(
    subagentResultForRun(
      { ...projection, messages: [report.message], providerTurns: [reported as never] },
      run,
    ).text,
    "Requested model gpt-5.4; the provider reported running gpt-5.4-mini.\n\nAll steps passed.",
  );
});

it.effect("ends an orphaned native subagent's node when only its record already ended", () =>
  Effect.gen(function* () {
    const id = NodeId.make("node:orphaned-native-subagent");
    const subagent = { id, origin: "provider_native", status: "running", runId: null };
    const events = yield* endOrphanedNativeSubagent({
      projection: {
        subagents: [subagent],
        nodes: [{ id, status: "running", runId: null }],
        turnItems: [],
      } as never,
      subagentId: id,
      status: "cancelled",
      now: yield* DateTime.now,
      emitted: [
        { type: "subagent.updated", payload: { ...subagent, status: "cancelled" } },
      ] as never,
      allocateEventId: () => Effect.succeed(EventId.make("event:orphaned-native-subagent")),
    });
    assert.deepEqual(
      events.map((event) => [event.type, event.type === "node.updated" && event.payload.status]),
      [["node.updated", "cancelled"]],
    );
  }),
);

it.effect("ends a runless root turn's items when its node already ended", () =>
  Effect.gen(function* () {
    const root = {
      id: NodeId.make("node:runless-root"),
      kind: "root_turn",
      status: "running",
      runId: null,
    };
    const item = (id: string) => ({ id, nodeId: root.id, runId: null, status: "running" });
    const events = yield* endRunlessRootTurns({
      threadId: childThreadId,
      providerInstanceId: parentProviderInstanceId,
      projection: {
        nodes: [root],
        providerTurns: [],
        turnItems: [item("turn-item:command"), item("turn-item:reasoning")],
      } as never,
      status: "cancelled",
      now: yield* DateTime.now,
      emitted: [
        {
          type: "turn-item.updated",
          payload: { ...item("turn-item:command"), status: "cancelled" },
        },
        { type: "node.updated", payload: { ...root, status: "cancelled" } },
      ] as never,
      allocateEventId: () => Effect.succeed(EventId.make("event:runless-root")),
    });
    assert.deepEqual(
      events.map(
        (event) => `${event.type} ${event.type === "turn-item.updated" && event.payload.id}`,
      ),
      ["turn-item.updated turn-item:reasoning"],
    );
  }),
);
