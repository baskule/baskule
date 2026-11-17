import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);

const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-git-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerEmptyInstances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  getInstance: () => Effect.undefined,
});
const makeLayerTest = <E>(
  ingestorEventSink: Layer.Layer<EventSink.EventSinkV2, E>,
  instances = layerEmptyInstances,
) =>
  Layer.mergeAll(
    instances,
    layerTestDatabase,
    layerTestStores,
    layerTestEventSink,
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    layerGit,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          instances,
          layerTestStores,
          ingestorEventSink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          layerGit,
        ),
      ),
    ),
  );
const layerTest = makeLayerTest(layerTestEventSink);

// EventSink reports a lock that outlasted busy_timeout at BEGIN IMMEDIATE this way.
const lockTimeout = new EventSink.EventSinkWriteError({
  eventCount: 1,
  cause: new SqlError.SqlError({ reason: new SqlError.LockTimeoutError({ cause: null }) }),
});
const constraintFailure = new EventSink.EventSinkWriteError({
  eventCount: 1,
  cause: new SqlError.SqlError({ reason: new SqlError.ConstraintError({ cause: null }) }),
});

/** The ingestor's next sink writes of `events` fail with `errors`, in order; the rest go through. */
const layerFailingWrites = (
  errors: ReadonlyArray<EventSink.EventSinkWriteError>,
  matches: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => boolean = () => true,
) =>
  makeLayerTest(
    Layer.effect(
      EventSink.EventSinkV2,
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const pending = [...errors];
        const failNext = <A, R>(
          events: ReadonlyArray<OrchestrationV2DomainEvent>,
          write: Effect.Effect<A, EventSink.EventSinkV2Error, R>,
        ) => Effect.suspend(() => (matches(events) ? (pending.shift() ?? write) : write));
        return EventSink.EventSinkV2.of({
          ...eventSink,
          write: (input) => failNext(input.events, eventSink.write(input)),
          writeIfRunCurrent: (input) => failNext(input.events, eventSink.writeIfRunCurrent(input)),
          writeIfProviderThreadOwner: (input) =>
            failNext(input.events, eventSink.writeIfProviderThreadOwner(input)),
        });
      }),
    ).pipe(Layer.provide(layerTestEventSink)),
  );
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const isProviderEvent = Schema.is(ProviderAdapter.ProviderAdapterV2Event);

function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<
  OrchestrationV2DomainEvent,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const layer = it.layer(layerTest);

it.effect(
  "reports invalid provider questions as typed errors and still ingests valid questions",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const threadId = threadEvent.threadId;
      yield* eventSink.write({ events: [threadEvent] });
      const providerInstanceId = ProviderInstanceId.make("pi");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId,
        threadId,
      });
      const question = { id: "input", header: "Enter a value", question: "", options: [] };
      const item = {
        id: TurnItemId.make(`${threadId}:question`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: "Enter a value",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId: RuntimeRequestId.make(`${threadId}:question`),
        questions: [question],
      } satisfies OrchestrationV2TurnItem;
      const event = {
        type: "turn_item.updated",
        driver: ProviderDriverKind.make("pi"),
        turnItem: item,
      } satisfies ProviderAdapter.ProviderAdapterV2Event;
      const input = { providerSessionId, providerInstanceId, threadId, event };

      assert.isFalse(isProviderEvent(event));
      const error = yield* ingestor.ingestNormalized(input).pipe(Effect.flip);
      assert.instanceOf(error, ProviderEventIngestor.ProviderEventNormalizeError);
      assert.equal(
        error.message,
        `Failed to normalize provider event turn_item.updated for thread ${threadId}.`,
      );
      assert.instanceOf(error.cause, Schema.SchemaError);
      assert.equal(yield* eventStore.latestSequence({ threadId }), 1);
      assert.isEmpty((yield* projectionStore.getThreadProjection(threadId)).turnItems);

      const validEvent = {
        ...event,
        turnItem: { ...item, questions: [{ ...question, question: "Enter a value" }] },
      };
      assert.isTrue(isProviderEvent(validEvent));
      const stored = yield* ingestor.ingestNormalized({ ...input, event: validEvent });
      assert.lengthOf(stored, 1);
      assert.equal(stored[0]?.event.type, "turn-item.updated");
      assert.deepEqual((yield* projectionStore.getThreadProjection(threadId)).turnItems, [
        validEvent.turnItem,
      ]);
    }).pipe(Effect.provide(layerTest)),
);

layer("ProviderEventIngestorV2", (it) => {
  it.effect(
    "recovers a missing Claude child once and preserves saved metadata on later recovery",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
        const driver = ProviderDriverKind.make("claude");
        const providerInstanceId = ProviderInstanceId.make("claude");
        const childThreadId = idAllocator.derive.threadFromProviderThread({
          driver,
          nativeThreadId: "recovered-claude-child",
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId,
          threadId: rootEvent.threadId,
        });
        const recovered: OrchestrationV2AppThread = {
          ...rootEvent.payload,
          id: childThreadId,
          title: "Recovered subagent",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet-4-6" },
          activeProviderThreadId: null,
          createdBy: "agent",
          creationSource: "provider",
          lineage: {
            parentThreadId: rootEvent.threadId,
            relationshipToParent: "subagent",
            rootThreadId: rootEvent.threadId,
          },
        };
        const ingest = (appThread: OrchestrationV2AppThread, createOnly: boolean) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId,
            threadId: rootEvent.threadId,
            event: { type: "app_thread.created", driver, appThread, createOnly },
          });
        yield* eventSink.write({ events: [rootEvent] });
        const created = yield* Effect.all([ingest(recovered, true), ingest(recovered, true)], {
          concurrency: "unbounded",
        });
        assert.deepEqual(
          created.flat().map((stored) => stored.event.type),
          ["thread.created"],
        );
        assert.deepEqual(yield* projectionStore.getThread(childThreadId), recovered);

        yield* ingest(
          {
            ...recovered,
            title: "Review authentication",
            modelSelection: { instanceId: providerInstanceId, model: "claude-opus-4-6" },
          },
          false,
        );
        const saved = yield* projectionStore.getThread(childThreadId);
        assert.equal(saved.title, "Review authentication");
        assert.equal(saved.modelSelection.model, "claude-opus-4-6");
        assert.deepEqual(yield* ingest(recovered, true), []);
        assert.deepEqual(yield* projectionStore.getThread(childThreadId), saved);
      }),
  );
});

const ingestCompletedProviderTurn = (
  guard: Pick<
    Parameters<ProviderEventIngestor.ProviderEventIngestorV2Shape["ingestNormalized"]>[0],
    "writeIfRunCurrent" | "writeIfProviderThreadOwner"
  >,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadEvent = yield* threadCreatedEvent(now);
    yield* eventSink.write({ events: [threadEvent] });
    const providerTurnId = ProviderTurnId.make("provider-turn:locked");
    const exit = yield* ingestor
      .ingestNormalized({
        providerSessionId: yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        }),
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_turn.updated",
          driver: CODEX_DRIVER,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: ProviderThreadId.make("provider-thread:locked"),
            nodeId: NodeId.make("node:locked-turn"),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        ...guard,
      })
      .pipe(Effect.exit);
    const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
    return { exit, providerTurnId, persisted: projection.providerTurns.map((turn) => turn.id) };
  });

// Neither guard matches a stored run, so a guarded write correctly commits nothing.
const runId = RunId.make("run:locked");
const activeAttemptId = RunAttemptId.make("attempt:locked");
it.effect.each([
  { route: "write", guard: {} },
  {
    route: "writeIfRunCurrent",
    guard: { writeIfRunCurrent: { runId, activeAttemptId, expectedStatus: "running" } },
  },
  {
    route: "writeIfProviderThreadOwner",
    guard: {
      writeIfProviderThreadOwner: {
        providerThreadId: ProviderThreadId.make("provider-thread:locked"),
        runId,
        activeAttemptId,
        expectedLastRunOrdinal: 1,
      },
    },
  },
] as const)("a provider event $route outlasts a brief database lock", ({ route, guard }) =>
  Effect.gen(function* () {
    const { exit, providerTurnId, persisted } = yield* ingestCompletedProviderTurn(guard);
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepEqual(persisted, route === "write" ? [providerTurnId] : []);
  }).pipe(Effect.provide(layerFailingWrites([lockTimeout, lockTimeout]))),
);

// The write after the queued errors would succeed, so failing proves the retries stopped.
it.effect.each([
  { failure: "stays locked", errors: [lockTimeout, lockTimeout, lockTimeout] },
  { failure: "fails for another reason", errors: [constraintFailure] },
])("fails a provider event write that $failure", ({ errors }) =>
  Effect.gen(function* () {
    const { exit, persisted } = yield* ingestCompletedProviderTurn({});
    assert.instanceOf(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
      ProviderEventIngestor.ProviderEventPublishError,
    );
    assert.isEmpty(persisted);
  }).pipe(Effect.provide(layerFailingWrites(errors))),
);
