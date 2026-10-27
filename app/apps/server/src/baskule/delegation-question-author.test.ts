import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DelegatedTaskQuestionReactor from "../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { FULL_TEST_PROVIDER_CAPABILITIES } from "../orchestration-v2/testkit/testProviderCapabilities.ts";

const alice = { id: "alice", name: "Alice" };
const instanceId = ProviderInstanceId.make("opencode");
const modelSelection = { instanceId, model: "fake" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("opencode"),
  getCapabilities: () => Effect.succeed(FULL_TEST_PROVIDER_CAPABILITIES),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for attribution"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "delegation-question-author" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const layerTest = Layer.merge(runtime, ProjectionStore.layer.pipe(Layer.provide(database)));

it.effect.each(["parent wake", "queued child answer"] as const)(
  "attributes the %s to the delegating author when Bob queues work",
  (phase) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const parentId = ThreadId.make("question-parent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parent"),
        threadId: parentId,
        projectId: ProjectId.make("question-project"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-parent"),
        threadId: parentId,
        messageId: MessageId.make("parent-input"),
        text: "Delegate",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        author: alice,
        createdBy: "user",
        creationSource: "web",
      });
      const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId: parentId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Research",
        completionWake: "always",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
      const childId = task.childThreadId!;
      const childRun = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
      for (const id of [parentId, childId]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`queue-bob:${id}`),
          threadId: id,
          messageId: MessageId.make(`bob:${id}`),
          text: "Later work",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          author: { id: "bob", name: "Bob" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const now = yield* DateTime.now;
      const requestId = RuntimeRequestId.make("child-question");
      const nodeId = NodeId.make("question-node");
      const question = {
        id: EventId.make("question-event"),
        type: "runtime-request.updated" as const,
        threadId: childId,
        runId: childRun.id,
        nodeId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: now,
          resolvedAt: null,
        },
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("question-node-event"),
            type: "node.updated",
            threadId: childId,
            runId: childRun.id,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId: childId,
              runId: childRun.id,
              parentNodeId: childRun.rootNodeId,
              rootNodeId: childRun.rootNodeId!,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          question,
          {
            id: EventId.make("question-item-event"),
            type: "turn-item.updated",
            threadId: childId,
            runId: childRun.id,
            nodeId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("question-item"),
              type: "user_input_request",
              threadId: childId,
              runId: childRun.id,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 5,
              status: "waiting",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              requestId,
              responseMode: "message",
              questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
            },
          },
        ],
      });
      if (phase === "parent wake") {
        const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
        yield* reactor.handle(question);
        const wake = (yield* orchestrator.getThreadProjection(parentId)).messages.find(
          (m) => m.notification?.source.kind === "delegated_task",
        );
        assert.isDefined(wake);
        assert.deepEqual(wake?.author, alice);
      } else {
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("answer"),
          threadId: childId,
          requestId,
          answers: { color: "Blue" },
        });
        const child = yield* orchestrator.getThreadProjection(childId);
        const answer = child.messages.find(
          (m) => m.id === MessageId.make(`async-answer:${requestId}`),
        );
        assert.isDefined(answer);
        assert.deepEqual(answer?.author, alice);
        assert.equal(child.runs.find((r) => r.userMessageId === answer?.id)?.status, "queued");
      }
    }).pipe(Effect.provide(DelegatedTaskQuestionReactor.layer.pipe(Layer.provideMerge(layerTest)))),
);
