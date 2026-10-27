import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderContinuationService from "../orchestration-v2/ProviderContinuationService.ts";
import { continueRestartedRun } from "../orchestration-v2/RestartContinuation.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as ServerSettings from "../serverSettings.ts";

const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };
const threadId = ThreadId.make("delegation-author");
const runId = RunId.make("delegating-run");
const originalId = MessageId.make("original");
const deliveryId = MessageId.make("delivery");
const providerThreadId = ProviderThreadId.make("provider-thread");
const instanceId = ProviderInstanceId.make("opencode");
const driver = ProviderDriverKind.make("opencode");
type Dispatch = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
>[0];

function projection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        userMessageId: originalId,
        ordinal: 1,
        status: "cancelled",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "fake" },
        requestedAt: DateTime.makeUnsafe("2026-10-26T00:00:00Z"),
        completedAt: DateTime.makeUnsafe("2026-10-26T00:01:00Z"),
        activeAttemptId: null,
        delegatedCompletion: {
          disposition: "open",
          nextGeneration: 2,
          delivery: { generation: 1, messageId: deliveryId, taskIds: ["task"] },
        },
      },
      {
        id: RunId.make("queued"),
        userMessageId: MessageId.make("later"),
        ordinal: 2,
        status: "queued",
      },
    ],
    messages: [
      { id: originalId, author: alice, text: "Delegate the work", attachments: [] },
      { id: MessageId.make("later"), author: bob },
    ],
    providerTurns: [],
    attempts: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

// Apply the message filter so the caller must actually load the originating input.
function records(
  state: OrchestrationV2ThreadProjection,
  options?: { readonly messageIds?: ReadonlyArray<MessageId> },
) {
  return Effect.succeed({
    ...state,
    messages:
      options?.messageIds === undefined
        ? state.messages
        : state.messages.filter((m) => options.messageIds?.includes(m.id)),
  });
}

it.effect(
  "attributes a delegated completion to its originating run even when Bob has queued work",
  () =>
    Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<Dispatch>();
      const state = projection();
      const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (_id, _fields, options) => records(state, options),
        dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
      });
      const dependencies = Layer.mergeAll(
        IdAllocator.layer,
        ProviderContinuationRequests.layer,
        threads,
      );
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: { parentRunId: runId, generation: 1, messageId: deliveryId },
        });
        const command = yield* Queue.take(dispatched).pipe(
          Effect.timeout("5 seconds"),
          TestClock.withLive,
          Effect.catchTag("TimeoutError", () => Effect.die("No completion dispatch received")),
        );
        assert.equal(command.type, "message.dispatch");
        if (command.type !== "message.dispatch") return;
        assert.deepEqual(command.author, alice);
      }).pipe(
        Effect.provide(
          Layer.merge(
            ProviderContinuationRequests.layer,
            ProviderContinuationService.layer.pipe(Layer.provide(dependencies)),
          ),
        ),
        Effect.scoped,
      );
    }),
);

it.effect(
  "attributes restart recovery to the interrupted input's author rather than a queued member",
  () =>
    Effect.gen(function* () {
      const commands: Dispatch[] = [];
      const state = projection();
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: (_id, _fields, options) => records(state, options),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                commands.push(command);
                return Effect.succeed({} as never);
              },
            }),
          ),
        ),
      );
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.deepEqual(command.author, alice);
    }),
);

it.effect("attributes usage-limit auto-resume to the limited run's author", () =>
  Effect.gen(function* () {
    const commands: Dispatch[] = [];
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const resetAt = DateTime.formatIso(DateTime.makeUnsafe(now - 1000));
    const candidate = {
      id: threadId,
      status: "failed",
      lastErrorClass: "usage_limit",
      latestRunId: runId,
      usageLimitResetAt: resetAt,
      archivedAt: null,
      settledOverride: null,
      pendingRuntimeRequest: null,
      snoozedUntil: null,
      latestRunCompletedAt: DateTime.makeUnsafe(now - 60000),
      limitRecovery: { runId, resetAt, autoResume: true },
    } as ProjectionStore.ProjectionLimitRecoveryCandidate;
    yield* Layer.build(UsageLimitRecoveryWorker.layer).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ autoResumeLimitedThreads: true }),
          Layer.mock(Scheduler.Scheduler)({ register: (_name, work) => work.pipe(Effect.orDie) }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () => Effect.succeed([candidate]),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (_id, _fields, options) => records(projection(), options),
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
        ),
      ),
      Effect.scoped,
    );
    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    assert.equal(command.type, "message.dispatch");
    if (command.type !== "message.dispatch") return;
    assert.deepEqual(command.author, alice);
  }),
);
