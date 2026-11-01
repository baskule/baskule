import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ChatAttachment,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { FULL_TEST_PROVIDER_CAPABILITIES } from "./testProviderCapabilities.ts";
const PRIMARY_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode_primary"),
  model: "openai/gpt-6-luna",
};
const SECONDARY_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode_secondary"),
  model: "anthropic/claude-sonnet-4-6",
};

const PRIMARY_DRIVER = ProviderDriverKind.make("opencode");
const SECONDARY_DRIVER = ProviderDriverKind.make("opencode");

interface CapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly nativeThreadId?: string | null;
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
}

function unimplemented(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

function makeTestAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly modelSelection: ModelSelection;
  readonly responseByRunOrdinal: Readonly<Record<number, string>>;
  readonly responseByThreadId?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injectedHistory?: Ref.Ref<ReadonlyArray<unknown>>;
  readonly failStartOnce?: Ref.Ref<boolean>;

  readonly failInjectionOnce?: Ref.Ref<boolean>;
  readonly nativeThreadGeneration?: Ref.Ref<number>;
  readonly failResume?: boolean;
  readonly failResumeOnce?: Ref.Ref<boolean>;
  readonly initialContextUsage?: OrchestrationV2ProviderThread["contextUsage"];
  readonly getModelContextWindow?: (selection: ModelSelection) => number | undefined;
  readonly canReuseContextUsage?: ProviderAdapter.ProviderAdapterV2SessionRuntime["canReuseContextUsage"];
  readonly tokenUsageByRunOrdinal?: Readonly<
    Record<number, Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">>
  >;
  readonly failure?: ReturnType<typeof makeProviderFailure>;
  readonly failedRunOrdinals?: ReadonlySet<number>;
  readonly interruptedRunOrdinals?: ReadonlySet<number>;
  readonly holdRunOrdinal?: number;
  readonly pendingBackgroundWork?: Ref.Ref<boolean>;
  readonly subagentOnlyBackgroundWork?: boolean;
  readonly holdFirstTurn?: Deferred.Deferred<void>;
  readonly releaseFirstTurn?: Deferred.Deferred<void>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ...(input.pendingBackgroundWork === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: (_thread, options) =>
                  input.subagentOnlyBackgroundWork && options?.includeSubagents !== true
                    ? Effect.succeed(false)
                    : Ref.get(input.pendingBackgroundWork!),
              }),
          ...(input.getModelContextWindow === undefined
            ? {}
            : { getModelContextWindow: input.getModelContextWindow }),
          ...(input.canReuseContextUsage === undefined
            ? {}
            : { canReuseContextUsage: input.canReuseContextUsage }),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const generation =
                input.nativeThreadGeneration === undefined
                  ? ""
                  : `:${yield* Ref.getAndUpdate(input.nativeThreadGeneration, (value) => value + 1)}`;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}${generation}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: input.initialContextUsage ?? null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              if (
                input.failResume ||
                (input.failResumeOnce !== undefined &&
                  (yield* Ref.getAndSet(input.failResumeOnce, false)))
              )
                return yield* unimplemented(input.driver, "simulated native resume failure");
              return providerThread;
            }),
          ...(input.injectedHistory === undefined
            ? {}
            : {
                injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                  Ref.update(input.injectedHistory!, (current) => [
                    ...current,
                    ...historyResponseItems(history.messages, history.context),
                  ]).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        if (
                          input.failInjectionOnce !== undefined &&
                          (yield* Ref.getAndSet(input.failInjectionOnce, false))
                        )
                          return yield* unimplemented(
                            input.driver,
                            "lost injection acknowledgement",
                          );
                        return true;
                      }),
                    ),
                  ),
              }),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              if (
                input.failStartOnce !== undefined &&
                (yield* Ref.getAndSet(input.failStartOnce, false))
              )
                return yield* unimplemented(input.driver, "turn start failed after injection");

              yield* Effect.yieldNow;
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                  modelSelection: turnInput.modelSelection,
                  attachments: turnInput.message.attachments,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  providerTurnOrdinal: turnInput.providerTurnOrdinal,
                  ...(turnInput.nativeThreadHasTurns === undefined
                    ? {}
                    : { nativeThreadHasTurns: turnInput.nativeThreadHasTurns }),
                },
              ]);
              if (
                turnInput.runOrdinal === (input.holdRunOrdinal ?? 1) &&
                input.holdFirstTurn !== undefined
              ) {
                yield* Deferred.succeed(input.holdFirstTurn, undefined);
                if (input.releaseFirstTurn === undefined) return;
                yield* Deferred.await(input.releaseFirstTurn);
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const terminalStatus = input.failedRunOrdinals?.has(turnInput.runOrdinal)
                ? "failed"
                : input.interruptedRunOrdinals?.has(turnInput.runOrdinal)
                  ? "interrupted"
                  : "completed";
              const response =
                input.responseByThreadId?.[turnInput.threadId]?.[turnInput.runOrdinal] ??
                input.responseByRunOrdinal[turnInput.runOrdinal] ??
                `${input.driver} response for run ${turnInput.runOrdinal}`;
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: terminalStatus,
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: terminalStatus,
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  ...(terminalStatus === "failed"
                    ? {
                        status: terminalStatus,
                        failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                        failure:
                          input.failure ??
                          makeProviderFailure({
                            message: "Simulated provider failure.",
                            code: "simulated_failure",
                            class: "provider_error",
                          }),
                      }
                    : { status: terminalStatus, failure: null }),
                  threadDisposition: "reusable",
                },
              ];
              const reportedUsage = input.tokenUsageByRunOrdinal?.[turnInput.runOrdinal];
              const turnEvent = providerEvents[0];
              if (reportedUsage && turnEvent?.type === "provider_turn.updated") {
                yield* PubSub.publish(events, {
                  ...turnEvent,
                  providerTurn: {
                    ...turnEvent.providerTurn,
                    status: "running",
                    completedAt: null,
                    tokenUsage: { ...reportedUsage, updatedAt: DateTime.formatIso(eventTime) },
                  },
                });
              }
              for (const event of providerEvents) {
                yield* PubSub.publish(events, event);
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unimplemented(input.driver, "readThreadSnapshot unused in provider switch test"),
          rollbackThread: () =>
            unimplemented(input.driver, "rollbackThread unused in provider switch test"),
          forkThread: () =>
            unimplemented(input.driver, "forkThread unused in provider switch test"),
        };
        return runtime;
      }),
  };
}

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(targetThreadId);
  if (isIdle(current)) {
    return current;
  }
  // Projections commit with their events, so each later event is the only time to re-read.
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  if (idle === undefined) {
    return yield* Effect.die(
      new Error("Provider switch test event stream ended before the thread went idle"),
    );
  }
  return idle;
});

// Same tag as the adapter's unexported error raised when Claude never answers setMcpServers.

describe("orchestration v2 provider switching", () => {
  const importedFailureScenario = (queueBeforeFailure: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const importedThreadId = ThreadId.make("thread:provider-switch:legacy-import");
        const importedProjectId = ProjectId.make("project:provider-switch:legacy-import");
        const failedPrompt = "This first provider attempt should fail.";
        const recoveryPrompt = "What was the imported release marker?";
        const cwd = yield* checkpointWorkspace("provider-switch-legacy-import");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const firstTurnStarted = yield* Deferred.make<void>();
        const releaseFirstTurn = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: PRIMARY_MODEL_SELECTION.instanceId,
            driver: PRIMARY_DRIVER,
            capabilities: FULL_TEST_PROVIDER_CAPABILITIES,
            modelSelection: PRIMARY_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            failedRunOrdinals: new Set([1]),
            ...(queueBeforeFailure ? { holdFirstTurn: firstTurnStarted, releaseFirstTurn } : {}),
          }),
          makeTestAdapter({
            instanceId: SECONDARY_MODEL_SELECTION.instanceId,
            driver: SECONDARY_DRIVER,
            capabilities: FULL_TEST_PROVIDER_CAPABILITIES,
            modelSelection: SECONDARY_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "The imported release marker is violet." },
            capturedTurns,
          }),
        ]);
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
        const layerProjectionStoreProvided = ProjectionStore.layer.pipe(
          Layer.provideMerge(layerDatabase),
        );
        const layerStoresProvided = Layer.mergeAll(
          layerDatabase,
          layerEventStoreProvided,
          layerProjectionStoreProvided,
        );
        const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
        const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
          Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
        );
        const layerMaintenanceProvided = ProjectionMaintenance.layer.pipe(
          Layer.provide(layerStoresProvided),
        );
        const layerOrchestratorProvided = ProviderReplayHarness.layerWithRegistry(
          {
            name: "provider-switch-legacy-import",
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: {
                type: "readOnly",
                access: { type: "fullAccess" },
                networkAccess: false,
              },
            },
          },
          layerRegistry,
          { databaseLayer: layerDatabase },
        );
        const layerTest = Layer.mergeAll(
          layerStoresProvided,
          layerImporterProvided,
          layerMaintenanceProvided,
          layerOrchestratorProvided,
        );

        const projection = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

          yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${importedProjectId},
          'Imported provider switch project',
          ${cwd},
          '{"instanceId":"opencode_primary","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
          yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES (
          ${importedThreadId},
          ${importedProjectId},
          'Imported provider switch thread',
          '{"instanceId":"opencode_primary","model":"gpt-5.4"}',
          'full-access',
          'default',
          'main',
          ${cwd},
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL
        )
      `;
          yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:provider-switch:legacy-import:user',
            ${importedThreadId},
            NULL,
            'user',
            'Remember that the imported release marker is violet.',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:provider-switch:legacy-import:assistant',
            ${importedThreadId},
            NULL,
            'assistant',
            'I will remember violet.',
            '[]',
            0,
            '2026-01-01T01:01:00.000Z',
            '2026-01-01T01:01:00.000Z'
          )
      `;

          yield* importer.reconcileShells;
          yield* maintenance.rebuild;
          yield* importer.ensureTranscript(importedThreadId);

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:legacy-import:failed"),
            threadId: importedThreadId,
            messageId: MessageId.make("message:provider-switch:legacy-import:failed"),
            text: failedPrompt,
            attachments: [],
            modelSelection: PRIMARY_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          if (queueBeforeFailure) {
            yield* Deferred.await(firstTurnStarted);
          } else {
            yield* waitForIdle(importedThreadId);
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:legacy-import:recovery"),
            threadId: importedThreadId,
            messageId: MessageId.make("message:provider-switch:legacy-import:recovery"),
            text: recoveryPrompt,
            attachments: [],
            modelSelection: SECONDARY_MODEL_SELECTION,
            dispatchMode: {
              type: queueBeforeFailure ? "queue_after_active" : "start_immediately",
            },
          });
          if (queueBeforeFailure) {
            const queued = yield* orchestrator.getThreadProjection(importedThreadId);
            assert.deepEqual(
              queued.runs.map((run) => run.status),
              ["running", "queued"],
            );
            assert.deepEqual(
              queued.contextHandoffs.map((handoff) => handoff.targetRunId),
              [queued.runs[0]?.id],
            );
            yield* Deferred.succeed(releaseFirstTurn, undefined);
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                (event) =>
                  event.event.type === "run.updated" &&
                  event.event.runId === queued.runs[1]?.id &&
                  event.event.payload.status === "completed",
              ),
              Stream.runHead,
            );
            yield* worker.drain();
          } else {
            yield* waitForIdle(importedThreadId);
          }
          const beforeRebuild = yield* orchestrator.getThreadProjection(importedThreadId);
          for (const attempt of beforeRebuild.attempts) {
            const nativeId = beforeRebuild.providerThreads.find(
              (thread) => thread.id === attempt.providerThreadId,
            )?.nativeThreadRef?.nativeId;
            assert.isDefined(nativeId);
            assert.equal(attempt.nativeThreadId, nativeId);
          }
          yield* maintenance.rebuild;
          const rebuilt = yield* orchestrator.getThreadProjection(importedThreadId);
          assert.deepEqual(rebuilt.attempts, beforeRebuild.attempts);
          return rebuilt;
        }).pipe(Effect.provide(layerTest));

        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["opencode_primary", "failed"],
            ["opencode_secondary", "completed"],
          ],
        );
        assert.sameDeepMembers(
          projection.contextHandoffs.map((handoff) => [
            handoff.targetRunId,
            handoff.strategy,
            handoff.status,
          ]),
          [
            [projection.runs[0]?.id, "manual_context", "ready"],
            [projection.runs[1]?.id, "manual_context", "ready"],
            [projection.runs[1]?.id, "full_thread_summary", "ready"],
          ],
        );
        const recoveryHandoff = projection.contextHandoffs.find(
          (handoff) => handoff.id === projection.runs[1]?.contextHandoffId,
        );
        assert.equal(recoveryHandoff?.strategy, "full_thread_summary");
        assert.include(recoveryHandoff?.summaryText ?? "", failedPrompt);
        if (queueBeforeFailure) {
          const handoffItem = projection.turnItems.find(
            (item) => item.type === "handoff" && item.runId === projection.runs[1]?.id,
          );
          assert.equal(
            handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
            recoveryHandoff?.id,
          );
        }
        assert.include(turns[1]?.text ?? "", "Context handoff (manual_context):");
        assert.include(turns[1]?.text ?? "", "imported release marker is violet");
        assert.include(turns[1]?.text ?? "", "I will remember violet.");
        assert.include(turns[1]?.text ?? "", recoveryPrompt);
        assert.include(turns[1]?.text ?? "", failedPrompt);
      }),
    );
  it.live(
    "reissues imported v1 context when a queued provider starts after the first provider fails",
    () => importedFailureScenario(true),
  );
});
