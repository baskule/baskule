import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId, // baskule: identify the initiating input in the scheduler fixture.
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

const taskActor = { id: "alice", name: "Alice" };

const raceTask = {
  id: ScheduledTaskId.make("task:authorship-race"),
  title: "Owned task",
  prompt: "Original prompt",
  enabled: false,
  schedule: { type: "webhook", signature: null },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

const raceTaskLayer = (
  checkScratch: Effect.Effect<boolean> = Effect.succeed(false),
  readOrigin: Effect.Effect<{ readonly relayHookBaseUrl: null }> = Effect.succeed({
    relayHookBaseUrl: null,
  }),
) =>
  ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => checkScratch,
        }),
        Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        Layer.succeed(ScheduledTasks.ScheduledTaskWebhookOrigin, readOrigin),
      ),
    ),
  );

it.effect.each(["created by another author", "replaced by another author", "recreated", "deleted"])(
  "an in-flight save cannot overwrite a task %s",
  (change) =>
    Effect.gen(function* () {
      const checked = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const checkScratch = Deferred.succeed(checked, undefined).pipe(
        Effect.andThen(Deferred.await(proceed)),
        Effect.as(false),
      );
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        if (change !== "created by another author") yield* tasks.upsert(raceTask, taskActor);
        const save = yield* Effect.forkChild(
          tasks
            .upsert(
              {
                ...raceTask,
                prompt: "Stale writer's prompt",
                workspaceStrategy: { type: "worktree", baseRef: "main" },
              },
              taskActor,
            )
            .pipe(Effect.result),
        );
        yield* Deferred.await(checked);
        if (change !== "created by another author") {
          yield* tasks.delete({ id: raceTask.id }, taskActor);
        }
        const replacementActor = change === "recreated" ? taskActor : { id: "bob", name: "Bob" };
        if (change === "recreated") yield* TestClock.adjust("1 second");
        const replacement =
          change === "deleted"
            ? null
            : (yield* tasks.upsert({ ...raceTask, prompt: "Replacement prompt" }, replacementActor))
                .task;
        yield* Deferred.succeed(proceed, undefined);
        const result = yield* Fiber.join(save);
        const remaining = (yield* tasks.list(replacementActor)).tasks;
        expect(remaining).toEqual(replacement === null ? [] : [replacement]);
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(raceTaskLayer(checkScratch)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["another author", "a new generation"])(
  "an in-flight enable cannot mutate a replacement owned by %s",
  (change) =>
    Effect.gen(function* () {
      const checked = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const pauseRead = yield* Ref.make(false);
      const readOrigin = Effect.gen(function* () {
        if (yield* Ref.getAndSet(pauseRead, false)) {
          yield* Deferred.succeed(checked, undefined);
          yield* Deferred.await(proceed);
        }
        return { relayHookBaseUrl: null };
      });
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        yield* tasks.upsert(raceTask, taskActor);
        yield* Ref.set(pauseRead, true);
        const enable = yield* Effect.forkChild(
          tasks.setEnabled({ id: raceTask.id, enabled: true }, taskActor).pipe(Effect.result),
        );
        yield* Deferred.await(checked);
        yield* tasks.delete({ id: raceTask.id }, taskActor);
        const replacementActor =
          change === "a new generation" ? taskActor : { id: "bob", name: "Bob" };
        if (change === "a new generation") yield* TestClock.adjust("1 second");
        const { task: replacement } = yield* tasks.upsert(raceTask, replacementActor);
        yield* Deferred.succeed(proceed, undefined);
        const result = yield* Fiber.join(enable);
        expect((yield* tasks.list(replacementActor)).tasks).toEqual([replacement]);
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(raceTaskLayer(undefined, readOrigin)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["on time", "after restart"])(
  "runs Scheduled Tasks and a persisted limit retry through the same scheduler %s",
  (scenario) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 60 }));
      const thread: OrchestrationV2ThreadShell = {
        id: ThreadId.make("thread:limited"),
        projectId: ProjectId.make("project:test"),
        title: "Limited",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
        branch: null,
        worktreePath: null,
        lineage: {
          rootThreadId: ThreadId.make("thread:limited"),
          parentThreadId: null,
          relationshipToParent: null,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        latestRunId: RunId.make("run:limited"),
        latestRunCompletedAt: now,
        activeRunId: null,
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: resetAt,
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: now,
        hasActionableProposedPlan: false,
        itemCount: 1,
        visibleItemCount: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        pinnedAt: null,
        deletedAt: null,
        limitRecovery: {
          runId: RunId.make("run:limited"),
          resetAt,
          autoResume: true,
          requestId: CommandId.make("recovery:choice"),
        },
      };
      if (scenario === "after restart") {
        yield* TestClock.adjust("65 seconds");
      }
      const current = yield* Ref.make(thread);
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const receipts = yield* Queue.unbounded<"task" | "retry">();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) => {
            expect(input.initialMessage?.author).toEqual(taskActor);
            return Queue.offer(receipts, "task").pipe(
              Effect.andThen(Effect.die("fixture dispatch failure")),
            );
          },
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          // baskule: the retry reads the initiating run and input before dispatch.
          getThreadRecords: () =>
            Effect.succeed({
              runs: [
                { id: RunId.make("run:limited"), userMessageId: MessageId.make("message:limited") },
              ],
              messages: [
                { id: MessageId.make("message:limited"), author: { id: "alice", name: "Alice" } },
              ],
            } as never),
          dispatch: (command) =>
            Ref.update(commands, (all) => [...all, command]).pipe(
              Effect.andThen(
                Ref.update(current, (shell) => ({ ...shell, status: "running" as const })),
              ),
              Effect.andThen(Queue.offer(receipts, "retry")),
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitRecoveryCandidates: () =>
            Ref.get(current).pipe(
              Effect.map((shell) => (shell.status === "failed" ? [shell] : [])),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const layerWorkers = Layer.mergeAll(
        ScheduledTasks.layer,
        UsageLimitRecoveryWorker.layer,
      ).pipe(Layer.provide(layerDependencies), Layer.provide(Scheduler.layer));
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const { task } = yield* tasks.upsert(
          {
            title: "Scheduled work",
            prompt: "Run scheduled work",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: thread.projectId,
            workspaceStrategy: { type: "root" },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          },
          taskActor,
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${resetAt} WHERE task_id = ${task.id}`;
        if (scenario === "on time") {
          yield* TestClock.adjust("55 seconds");
          assert.deepEqual(yield* Ref.get(commands), []);
        }
        yield* TestClock.adjust("5 seconds");
        // baskule: a swallowed worker defect must fail instead of hanging this test.
        const receipt = Queue.take(receipts).pipe(
          Effect.timeout("5 seconds"),
          TestClock.withLive,
          Effect.catchTags({
            TimeoutError: () => Effect.die("Expected scheduled task and limit retry receipts"),
          }),
        );
        assert.deepEqual([yield* receipt, yield* receipt].sort(), ["retry", "task"]);
        const delivered = yield* Ref.get(commands);
        assert.equal(delivered.length, 1);
        expect(delivered[0]).toMatchObject({
          type: "message.dispatch",
          author: { id: "alice", name: "Alice" }, // baskule: scheduler retries retain the initiating author.
          usageLimitContinuationOfRunId: thread.latestRunId,
          usageLimitRecoveryRequestId: thread.limitRecovery!.requestId,
          text: "Continue where you left off.",
        });
      }).pipe(Effect.provide(layerWorkers));
    }).pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, ManagedPolicy.layerTest()))),
);
