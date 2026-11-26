import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type ApplicationStoredEvent,
  CheckpointId,
  CheckpointRef,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ROLLBACK_FAILED_MESSAGE } from "./CheckpointRollbackService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as DeviceHost from "../device/DeviceHost.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { FULL_TEST_PROVIDER_CAPABILITIES } from "./testkit/testProviderCapabilities.ts";

const taskActor = { id: "alice", name: "Alice" };
const layerPlatformTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mergeAll(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  layerNoTaskFolders,
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  }),
);
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const driver = ProviderDriverKind.make("opencode");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(FULL_TEST_PROVIDER_CAPABILITIES),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;
const legacyOpenCodeInstanceId = ProviderInstanceId.make("opencode_pre_2_2_5");
const legacyOpenCodeProviderInstance = {
  ...providerInstance,
  instanceId: legacyOpenCodeInstanceId,
  continuationIdentity: { driverKind: driver, continuationKey: "opencode:pre-2.2.5" },
  displayName: "OpenCode before 2.2.5",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: legacyOpenCodeInstanceId,
    getCapabilities: () =>
      Effect.succeed({
        ...FULL_TEST_PROVIDER_CAPABILITIES,
        turns: { ...FULL_TEST_PROVIDER_CAPABILITIES.turns, supportsNativeGoals: false },
      }),
  },
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.merge(
  ModelManifest.layerTest,
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(
        [providerInstance, alternateProviderInstance, legacyOpenCodeProviderInstance].find(
          (instance) => instanceId === instance.instanceId,
        ),
      ),
    listInstances: Effect.succeed([
      providerInstance,
      alternateProviderInstance,
      legacyOpenCodeProviderInstance,
    ]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  }),
);

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

// Read-only oracle: projections still equal a replay of these unpruned test logs.
const layerProjectionReplayTest = ProjectionReplay.layer.pipe(
  Layer.provide(
    Layer.merge(
      EventStore.layerFromOrchestrationEventStore.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
      ),
      ProjectionStore.layer,
    ),
  ),
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  layerProjectionReplayTest,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [modelSelection.instanceId]: { driver, enabled: true },
        [alternateInstanceId]: { driver, enabled: true },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerLegacyImportTest = Layer.merge(RuntimeLayer.layer, layerProjectionReplayTest).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [modelSelection.instanceId]: { driver, enabled: true },
        [alternateInstanceId]: { driver, enabled: true },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerScheduledTasksTest = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      // The orchestrator depends on this layer, so read the shell from its projection.
      Layer.unwrap(
        ProjectionStore.ProjectionStoreV2.pipe(
          Effect.map(({ getThreadShell }) =>
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) => getThreadShell(threadId).pipe(Effect.orDie),
            }),
          ),
        ),
      ).pipe(Layer.provide(ProjectionStore.layer)),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Scheduler.layer,
    ),
  ),
);
const bootedSimulatorReady: DeviceHost.DeviceHostAgentReady = {
  nodePath: process.execPath,
  hub: { origin: "http://device.test" },
  agentDevice: null,
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  run: () => Effect.die("Thread cleanup must not run host commands"),
  releaseAgentSession: () => Effect.void,
  devices: {
    list: Effect.succeed({
      devices: [
        {
          id: "phone",
          name: "iPhone",
          platform: "ios",
          version: "26",
          booted: true,
          physical: false,
        },
      ],
      detail: undefined,
    }),
    boot: () => Effect.die("The simulator is already booted"),
    attach: () => Effect.void,
    shutdown: () => Effect.die("Thread cleanup must keep the simulator booted"),
    screenshot: () => Effect.die("unused screenshot"),
  },
};
const bootedSimulatorHost = DeviceHost.DeviceHost.of({
  id: "local",
  label: "Local",
  summary: Effect.succeed({
    id: "local",
    label: "Local",
    kind: "local",
    hubInstalled: true,
    agentDeviceInstalled: true,
    platforms: [{ platform: "ios", available: true }],
  }),
  platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
  ensureReady: () => Effect.succeed(bootedSimulatorReady),
  ensureAgentReady: () => Effect.succeed(bootedSimulatorReady),
  current: Effect.succeed(bootedSimulatorReady),
  stopAgent: Effect.void,
  stop: Effect.void,
});
const layerResourceCleanupTest = ResourceCleanupService.layer.pipe(
  Layer.provideMerge(layerScheduledTasksTest),
  Layer.provideMerge(
    Layer.effect(
      DeviceService.DeviceService,
      DeviceService.makeWithHosts(new Map([[bootedSimulatorHost.id, bootedSimulatorHost]])),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    ),
  ),
);

const layerProjectDeletionTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      readRepositoryIdentity: () => Effect.succeed(null),
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provideMerge(layerResourceCleanupTest),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provideMerge(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [modelSelection.instanceId]: { driver, enabled: true },
        [alternateInstanceId]: { driver, enabled: true },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provideMerge(layerPlatformTest),
);

it.layer(layerProjectDeletionTest)("project deletion during thread commands", (it) => {
  it.effect.each(["thread", "project"] as const)(
    "deleting a %s removes its thread-bound automations through the effect worker",
    (deletion) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const projectId = ProjectId.make(`automation-delete-project:${deletion}`);
        const threadId = ThreadId.make(`automation-delete-thread:${deletion}`);
        const otherThreadId = ThreadId.make(`automation-surviving-thread:${deletion}`);
        const otherProjectId = ProjectId.make("automation-other-project");
        yield* projects.create({
          commandId: CommandId.make(`automation-create-project:${deletion}`),
          projectId,
          title: "Automation lifecycle",
          workspaceRoot: `/work/automation-lifecycle/${deletion}`,
        });
        for (const id of [threadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`automation-create:${id}`),
            createdBy: "user",
            creationSource: "web",
            threadId: id,
            projectId: id === threadId ? projectId : otherProjectId,
            title: "Automation target",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
        }
        const save = (name: string, target: ThreadId | null, webhook = false) =>
          tasks.upsert(
            {
              // As schedule_task sends it, so clearing the thread unbinds the task.
              threadMode: target === null ? "new_thread" : "continue",
              id: ScheduledTaskId.make(`automation:${deletion}:${name}`),
              title: name,
              prompt: "Check orchestration progress",
              enabled: !webhook,
              schedule: webhook ? { type: "webhook" } : { type: "interval", everyMs: 60_000 },
              projectId: target === otherThreadId ? otherProjectId : projectId,
              threadId: target,
              workspaceStrategy: { type: "root" },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdBy: "agent",
              creationSource: "mcp",
            },
            taskActor,
          );
        const { task: bound } = yield* save("bound", threadId);
        const { task: webhook } = yield* save("webhook", threadId, true);
        const { task: independent } = yield* save("independent", null);
        yield* save("detached", threadId);
        const { task: detached } = yield* save("detached", null);
        yield* save("moved", threadId);
        const { task: moved } = yield* save("moved", otherThreadId);
        const { task: other } = yield* save("other", otherThreadId);
        yield* tasks.triggerWebhook({
          hookId: webhook.id,
          token: webhook.webhook!.path.split("/").at(-1)!,
          method: "POST",
          path: webhook.webhook!.path,
          query: "",
          headers: {},
          body: new Uint8Array(),
          bodyText: "",
        });
        assert.lengthOf(
          (yield* tasks.listWebhookDeliveries({ id: webhook.id }, taskActor)).deliveries,
          1,
        );

        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`automation-archive:${deletion}`),
          threadId,
        });
        yield* worker.drain();
        assert.include(
          (yield* tasks.list(taskActor)).tasks.map((task) => task.id),
          bound.id,
        );

        if (deletion === "thread") {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`automation-delete:${deletion}`),
            threadId,
          });
        } else {
          yield* projects.delete({
            commandId: CommandId.make(`automation-delete:${deletion}`),
            projectId,
            force: true,
          });
        }
        yield* worker.drain();
        const remainingIds = (yield* tasks.list(taskActor)).tasks.map((task) => task.id);
        assert.notInclude(remainingIds, bound.id);
        assert.notInclude(remainingIds, webhook.id);
        assert.includeMembers(remainingIds, [independent.id, detached.id, moved.id, other.id]);
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(
          yield* sql`SELECT 1 FROM scheduled_task_webhook_deliveries WHERE task_id = ${webhook.id}`,
          0,
        );
        const missingDeliveries = yield* tasks
          .listWebhookDeliveries({ id: webhook.id }, taskActor)
          .pipe(Effect.flip);
        assert.equal(missingDeliveries.message, "Schedule task not found.");
        const rejected = yield* tasks.runNow({ id: bound.id }, taskActor).pipe(Effect.flip);
        assert.equal(rejected.message, "Schedule task not found.");
        assert.equal(
          (yield* tasks.triggerWebhook({
            hookId: webhook.id,
            token: webhook.webhook!.path.split("/").at(-1)!,
            method: "POST",
            path: webhook.webhook!.path,
            query: "",
            headers: {},
            body: new Uint8Array(),
            bodyText: "",
          }))._tag,
          "not_found",
        );
        // Retried cleanup is harmless and cannot affect unrelated tasks.
        yield* tasks.deleteForThread(threadId);
        assert.sameMembers(
          (yield* tasks.list(taskActor)).tasks.map((task) => task.id),
          remainingIds,
        );
      }),
  );

  it.effect.each(["archive", "thread delete", "project delete"] as const)(
    "%s releases the thread's devices and keeps them booted",
    (lifecycle) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const devices = yield* DeviceService.DeviceService;
        yield* devices.configure({ enabled: true, agentAccessEnabled: true });
        const projectId = ProjectId.make(`device-cleanup-project:${lifecycle}`);
        const threadId = ThreadId.make(`device-cleanup-thread:${lifecycle}`);
        const otherThreadId = ThreadId.make(`device-surviving-thread:${lifecycle}`);
        yield* projects.create({
          commandId: CommandId.make(`device-cleanup-create-project:${lifecycle}`),
          projectId,
          title: "Device cleanup",
          workspaceRoot: `/work/device-cleanup/${lifecycle}`,
        });
        for (const id of [threadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`device-cleanup-create:${id}`),
            createdBy: "user",
            creationSource: "web",
            threadId: id,
            projectId: id === threadId ? projectId : ProjectId.make("device-cleanup-other-project"),
            title: "Device user",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* devices.open({ threadId: id, deviceId: "phone", platform: "ios" });
        }
        const otherSessions = yield* devices.sessionsForThread(otherThreadId);

        const commandId = CommandId.make(`device-cleanup:${lifecycle}`);
        if (lifecycle === "project delete") {
          yield* projects.delete({ commandId, projectId, force: true });
        } else {
          yield* orchestrator.dispatch({
            type: lifecycle === "archive" ? "thread.archive" : "thread.delete",
            commandId,
            threadId,
          });
        }
        yield* worker.drain();

        assert.deepEqual(yield* devices.sessionsForThread(threadId), []);
        assert.deepEqual(yield* devices.sessionsForThread(otherThreadId), otherSessions);
        assert.isTrue((yield* devices.state).devices[0]?.booted);
      }),
  );

  it.effect.each(["no fork", "a live fork"] as const)(
    "a queued edit's cleanup keeps a file earlier history still shows, with %s",
    (fork) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const key = `queued-edit-shared-file-${fork.replaceAll(" ", "-")}`;
        const threadId = ThreadId.make(key);
        const storedFile = (name: string) =>
          ({
            type: "image",
            id: createAttachmentId(threadId)!,
            name: `${name}.png`,
            mimeType: "image/png",
            sizeBytes: 5,
          }) as const;
        const shared = storedFile("shared");
        const dropped = storedFile("dropped");
        const filePath = (file: typeof shared) =>
          path.join(config.attachmentsDir, `${file.id}.png`);
        yield* fileSystem.writeFileString(filePath(shared), "bytes");
        yield* fileSystem.writeFileString(filePath(dropped), "bytes");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${key}:create`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make("queued-edit-shared-file-project"),
          title: "Shared file",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const writeRun = Effect.fn("test.writeQueuedEditRun")(function* (input: {
          readonly name: string;
          readonly ordinal: number;
          readonly status: "completed" | "queued";
          readonly attachments: ReadonlyArray<typeof shared>;
        }) {
          const now = yield* DateTime.now;
          const runId = RunId.make(`${key}:${input.name}`);
          const messageId = MessageId.make(`${key}:${input.name}`);
          const completed = input.status === "completed";
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${key}:${input.name}:run`),
                type: "run.created",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: runId,
                  threadId,
                  ordinal: input.ordinal,
                  providerInstanceId: modelSelection.instanceId,
                  modelSelection,
                  providerThreadId: null,
                  userMessageId: messageId,
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: input.status,
                  requestedAt: now,
                  startedAt: completed ? now : null,
                  completedAt: completed ? now : null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
              {
                id: EventId.make(`${key}:${input.name}:message`),
                type: "message.updated",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId,
                  nodeId: null,
                  role: "user",
                  text: `Send ${input.name} work`,
                  attachments: input.attachments,
                  streaming: false,
                  createdBy: "user",
                  creationSource: "web",
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
          return runId;
        });

        const sourceRunId = yield* writeRun({
          name: "source",
          ordinal: 1,
          status: "completed",
          attachments: [shared],
        });
        if (fork !== "no fork") {
          const forkThreadId = ThreadId.make(`${key}:fork`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${key}:fork`),
            sourceThreadId: threadId,
            targetThreadId: forkThreadId,
            sourcePoint: { type: "run", runId: sourceRunId },
            createdBy: "user",
            creationSource: "web",
          });
        }
        const queuedRunId = yield* writeRun({
          name: "queued",
          ordinal: 2,
          status: "queued",
          attachments: [shared, dropped],
        });
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make(`${key}:edit`),
          threadId,
          runId: queuedRunId,
          text: "Send queued work without files",
          attachments: [],
        });
        yield* worker.drain();

        assert.isFalse(yield* fileSystem.exists(filePath(dropped)));
        assert.equal(yield* fileSystem.readFileString(filePath(shared)), "bytes");

        if (fork !== "no fork") {
          const laterRunId = yield* writeRun({
            name: "later",
            ordinal: 3,
            status: "completed",
            attachments: [shared],
          });
          const laterForkId = ThreadId.make(`${key}:later-fork`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${key}:later-fork`),
            sourceThreadId: threadId,
            targetThreadId: laterForkId,
            sourcePoint: { type: "run", runId: laterRunId },
            createdBy: "user",
            creationSource: "web",
          });
          for (const id of [threadId, laterForkId]) {
            yield* orchestrator.dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`${key}:delete:${id}`),
              threadId: id,
            });
            yield* worker.drain();
            assert.equal(yield* fileSystem.readFileString(filePath(shared)), "bytes");
          }
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`${key}:delete-first-fork`),
            threadId: ThreadId.make(`${key}:fork`),
          });
          yield* worker.drain();
          assert.isFalse(yield* fileSystem.exists(filePath(shared)));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for an in-flight thread update before planning deletion", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-project-delete-concurrent");
      const threadId = ThreadId.make("runtime-thread-delete-concurrent");
      const updateCommandId = CommandId.make("runtime-thread-delete-concurrent-update");
      yield* projects.create({
        commandId: CommandId.make("runtime-project-delete-concurrent-create"),
        projectId,
        title: "Concurrent deletion",
        workspaceRoot: "/work/concurrent-deletion",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-thread-delete-concurrent-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const updateReady = yield* Deferred.make<void>();
      const releaseUpdate = yield* Deferred.make<void>();
      const deletionQueued = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const withLock = executor.withLock;
      let threadLockRequests = 0;
      const commitSpy = vi
        .spyOn(eventSink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === updateCommandId
            ? Deferred.succeed(updateReady, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUpdate)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== threadId || ++threadLockRequests !== 2) return withLock(key, effect);
        return Deferred.succeed(deletionQueued, undefined).pipe(
          Effect.andThen(withLock(key, effect)),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const updateFiber = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: updateCommandId,
            threadId,
            title: "Updated before deletion",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(updateReady),
          Fiber.join(updateFiber).pipe(
            Effect.andThen(Effect.die("The update completed before reaching its commit barrier.")),
          ),
        );
        const deleteFiber = yield* projects
          .delete({
            commandId: CommandId.make("runtime-project-delete-concurrent-delete"),
            projectId,
            force: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(deletionQueued),
          Fiber.join(deleteFiber).pipe(
            Effect.andThen(Effect.die("Project deletion bypassed the in-flight thread command.")),
          ),
        );
        yield* Deferred.succeed(releaseUpdate, undefined);
        yield* Fiber.join(updateFiber);
        const deletedProject = yield* Fiber.join(deleteFiber);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isNotNull(deletedProject.deletedAt);
        assert.isNotNull(projection.thread.deletedAt);
        assert.equal(projection.thread.title, "Updated before deletion");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            lockSpy.mockRestore();
          }),
        ),
      );
    }),
  );

  it.effect(
    "deletes a side chat with its parent only after the side chat's in-flight command",
    () =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const projectId = ProjectId.make("runtime-side-chat-delete");
        const parentId = ThreadId.make("runtime-side-chat-delete-parent");
        const sideChatId = ThreadId.make("runtime-side-chat-delete-child");
        const updateCommandId = CommandId.make("runtime-side-chat-delete-update");
        yield* projects.create({
          commandId: CommandId.make("runtime-side-chat-delete-project"),
          projectId,
          title: "Side chat deletion",
          workspaceRoot: "/work/side-chat-deletion",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("runtime-side-chat-delete-create"),
          createdBy: "user",
          creationSource: "web",
          threadId: parentId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("runtime-side-chat-delete-fork"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });

        const updateReady = yield* Deferred.make<void>();
        const releaseUpdate = yield* Deferred.make<void>();
        const deletionQueued = yield* Deferred.make<void>();
        const commitCommand = eventSink.commitCommand;
        const withLock = executor.withLock;
        let sideChatLockRequests = 0;
        const commitSpy = vi
          .spyOn(eventSink, "commitCommand")
          .mockImplementation((input) =>
            input.commandId === updateCommandId
              ? Deferred.succeed(updateReady, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseUpdate)),
                  Effect.andThen(commitCommand(input)),
                )
              : commitCommand(input),
          );
        const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
          key,
          effect,
        ) => {
          if (key !== sideChatId || ++sideChatLockRequests !== 2) return withLock(key, effect);
          return Deferred.succeed(deletionQueued, undefined).pipe(
            Effect.andThen(withLock(key, effect)),
          );
        };
        const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
        yield* Effect.gen(function* () {
          const updateFiber = yield* orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: updateCommandId,
              threadId: sideChatId,
              title: "Updated before deletion",
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(updateReady),
            Fiber.join(updateFiber).pipe(
              Effect.andThen(
                Effect.die("The update completed before reaching its commit barrier."),
              ),
            ),
          );
          const deleteFiber = yield* orchestrator
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make("runtime-side-chat-delete-parent"),
              threadId: parentId,
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(deletionQueued),
            Fiber.join(deleteFiber).pipe(
              Effect.andThen(Effect.die("Parent deletion bypassed the side chat's command.")),
            ),
          );
          yield* Deferred.succeed(releaseUpdate, undefined);
          yield* Fiber.join(updateFiber);
          yield* Fiber.join(deleteFiber);
          const sideChat = yield* orchestrator.getThreadProjection(sideChatId);
          assert.isNotNull(sideChat.thread.deletedAt);
          assert.equal(sideChat.thread.title, "Updated before deletion");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              commitSpy.mockRestore();
              lockSpy.mockRestore();
            }),
          ),
        );
      }),
  );

  // A fork from a side chat onto its parent used to lock the side chat, then the parent: the
  // reverse of the parent delete's order.
  it.effect("a parent delete and a fork from its side chat onto the parent do not deadlock", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-side-chat-lock-order");
      const parentId = ThreadId.make("runtime-side-chat-lock-order-parent");
      const sideChatId = ThreadId.make("runtime-side-chat-lock-order-child");
      yield* projects.create({
        commandId: CommandId.make("runtime-side-chat-lock-order-project"),
        projectId,
        title: "Side chat lock order",
        workspaceRoot: "/work/side-chat-lock-order",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-side-chat-lock-order-create"),
        createdBy: "user",
        creationSource: "web",
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("runtime-side-chat-lock-order-fork"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

      const deleteHoldsParent = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();
      const forkWaitsForParent = yield* Deferred.make<void>();
      const withLock = executor.withLock;
      let parentLockRequests = 0;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== parentId) return withLock(key, effect);
        // Dispatch builds locks it may not run, so count when one runs.
        return Effect.suspend(() =>
          ++parentLockRequests === 1
            ? withLock(
                key,
                Deferred.succeed(deleteHoldsParent, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDelete)),
                  Effect.andThen(effect),
                ),
              )
            : Deferred.succeed(forkWaitsForParent, undefined).pipe(
                Effect.andThen(withLock(key, effect)),
              ),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const deleteFiber = yield* orchestrator
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-side-chat-lock-order-delete"),
            threadId: parentId,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(deleteHoldsParent);
        const forkFiber = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("runtime-side-chat-lock-order-fork-back"),
            sourceThreadId: sideChatId,
            targetThreadId: parentId,
            sourcePoint: { type: "latest_stable" },
            sideChat: true,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(forkWaitsForParent);
        yield* Deferred.succeed(releaseDelete, undefined);
        yield* Fiber.join(deleteFiber);
        yield* Fiber.join(forkFiber);
        assert.isNotNull((yield* orchestrator.getThreadProjection(parentId)).thread.deletedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
      }).pipe(Effect.ensuring(Effect.sync(() => lockSpy.mockRestore())));
    }),
  );

  it.effect("deleted sources keep the html_render pages any live fork shows", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const projectId = ProjectId.make("html-fork-project");
      const sourceThreadId = ThreadId.make("html-fork-source");
      const forkThreadId = ThreadId.make("html-fork-target");
      yield* projects.create({
        commandId: CommandId.make("html-fork-project"),
        projectId,
        title: "Page family",
        workspaceRoot: "/work/html-fork",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("html-fork-create"),
        threadId: sourceThreadId,
        projectId,
        title: "Page source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const inherited = yield* writeHtmlRenderRun({
        threadId: sourceThreadId,
        key: "inherited",
        ordinal: 1,
      });
      const fork = (sourceThreadId: ThreadId, runId: RunId, targetThreadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`html-fork:${targetThreadId}`),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "run", runId },
          createdBy: "user",
          creationSource: "web",
        });
      yield* fork(sourceThreadId, inherited.runId, forkThreadId);
      const forkPage = yield* writeHtmlRenderRun({
        threadId: forkThreadId,
        key: "fork",
        ordinal: 1,
      });
      const [first, second] = [ThreadId.make("html-fork-first"), ThreadId.make("html-fork-second")];
      yield* fork(forkThreadId, forkPage.runId, first);
      // Project deletion goes newest first, so it reaches `second` before `first`.
      yield* TestClock.adjust("1 second");
      yield* fork(forkThreadId, forkPage.runId, second);
      const firstRun = yield* writeHtmlRenderRun({ threadId: first, key: "first", ordinal: 1 });
      const later = yield* writeHtmlRenderRun({
        threadId: sourceThreadId,
        key: "later",
        ordinal: 2,
      });
      const deleteThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`html-fork-delete:${threadId}`),
          threadId,
        });
      const pagesOnDisk = Effect.gen(function* () {
        yield* worker.drain();
        return yield* Effect.forEach([inherited, forkPage, later], (page) =>
          fileSystem.exists(page.pagePath),
        );
      });
      yield* deleteThread(forkThreadId);
      yield* deleteThread(sourceThreadId);
      assert.deepEqual(yield* pagesOnDisk, [true, true, false]);

      // `first`'s delete pauses after reading what to free. A fork of it and the project delete,
      // which reaches `second`, must each wait on a lock it holds rather than decide on the same
      // state; `blocked` hears each request for one.
      const firstPlanned = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const blocked = yield* Queue.unbounded<void>();
      const readAttachmentIds = projections.getThreadAttachmentIds;
      const attachmentSpy = vi
        .spyOn(projections, "getThreadAttachmentIds")
        .mockImplementation((threadId) =>
          threadId === first
            ? readAttachmentIds(threadId).pipe(
                Effect.tap(() => Deferred.succeed(firstPlanned, undefined)),
                Effect.tap(() => Deferred.await(releaseFirst)),
              )
            : readAttachmentIds(threadId),
        );
      const deletionHeld = yield* Ref.make(false);
      const requestsHeld = (held: Effect.Effect<boolean>) =>
        Effect.all([Deferred.isDone(firstPlanned), held]).pipe(
          Effect.flatMap(([planned, isHeld]) =>
            planned && isHeld ? Queue.offer(blocked, undefined) : Effect.void,
          ),
        );
      const { withLock, withDeletionLock } = executor;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => requestsHeld(Effect.succeed(key === first)).pipe(Effect.andThen(withLock(key, effect)));
      const observeDeletion: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withDeletionLock"] =
        (effect) =>
          requestsHeld(Ref.get(deletionHeld)).pipe(
            Effect.andThen(
              withDeletionLock(
                Ref.set(deletionHeld, true).pipe(
                  Effect.andThen(effect),
                  Effect.ensuring(Ref.set(deletionHeld, false)),
                ),
              ),
            ),
          );
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      const deletionSpy = vi
        .spyOn(executor, "withDeletionLock")
        .mockImplementation(observeDeletion);
      const forkOfDeleted = yield* Effect.gen(function* () {
        const firstFiber = yield* deleteThread(first).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(firstPlanned);
        const forkFiber = yield* fork(first, firstRun.runId, ThreadId.make("html-fork-late")).pipe(
          Effect.match({
            onSuccess: () => "created",
            onFailure: (error) => ("cause" in error ? String(error.cause) : error._tag),
          }),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.raceFirst(Queue.take(blocked), Fiber.await(forkFiber));
        const projectFiber = yield* projects
          .delete({ commandId: CommandId.make("html-fork-project-delete"), projectId, force: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(Queue.take(blocked), Fiber.await(projectFiber));
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(projectFiber);
        return yield* Fiber.join(forkFiber);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lockSpy.mockRestore();
            deletionSpy.mockRestore();
            attachmentSpy.mockRestore();
          }),
        ),
      );
      assert.deepEqual(
        { afterLastForks: yield* pagesOnDisk, forkOfDeleted },
        { afterLastForks: [false, false, false], forkOfDeleted: `Thread ${first} was deleted.` },
      );
    }),
  );
});

const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  layerProjectionReplayTest,
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      readRepositoryIdentity: () => Effect.succeed(null),
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      refreshRepositoryIdentity: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [modelSelection.instanceId]: { driver, enabled: true },
        [alternateInstanceId]: { driver, enabled: true },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerTest)("OrchestrationV2LayerLive", (it) => {
  const seedFailingRollbackThread = (name: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make(name);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-create`),
        threadId,
        projectId: ProjectId.make(`${name}-project`),
        title: "Rollback failure",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: `/tmp/t3-${name}`,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-message`),
        threadId,
        messageId: MessageId.make(`${name}-message`),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const scope = (yield* orchestrator.getThreadProjection(threadId)).checkpointScopes[0]!;
      const now = yield* DateTime.now;
      const checkpointId = CheckpointId.make(`${name}-checkpoint`);
      yield* eventSink.write({
        commandId: CommandId.make(`${name}-seed`),
        events: [
          {
            id: EventId.make(`${name}-checkpoint-event`),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: checkpointId,
              threadId,
              scopeId: scope.id,
              runId: null,
              nodeId: scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make(`refs/t3/${name}`),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          },
        ],
      });
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "not under test",
      });
      return {
        threadId,
        rollback: (commandId: CommandId) =>
          orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          }),
      };
    });

  it.effect("projects a rollback that fails every attempt and clears it on the next one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const { threadId, rollback } = yield* seedFailingRollbackThread("runtime-rollback-failure");

      const rollbackCommandId = CommandId.make("runtime-rollback-failure-rollback");
      yield* rollback(rollbackCommandId);
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("30 seconds");
      }

      const [rollbackEffect] = yield* outbox.listByCommandId(rollbackCommandId);
      assert.equal(rollbackEffect?.status, "failed");
      const failed = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(failed.thread.rollbackFailure, {
        requestId: rollbackCommandId,
        message: ROLLBACK_FAILED_MESSAGE,
      });

      yield* rollback(CommandId.make("runtime-rollback-failure-retry"));
      const retried = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(retried.thread.rollbackFailure);
    }),
  );

  it.effect("captures and repeatedly rewinds non-Git conversations without losing run links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-non-git-rewind-" });
      const threadId = ThreadId.make("runtime-non-git-rewind");
      const rollbackThread = vi.fn(
        ({ providerThread }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({
            providerThread: {
              ...providerThread,
              nativeThreadRef: {
                driver,
                nativeId: "rewound-native-thread",
                strength: "strong" as const,
              },
            },
          }),
      );
      const sessionSpy = vi.spyOn(sessions, "open").mockReturnValue(
        Effect.succeed({
          rollbackThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("non-git-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("non-git-project"),
        title: "Non-Git rewind",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });

      const completeMessage = (name: string) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(name),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(name),
            text: name,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.userMessageId === name)!;
          const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          )!;
          const now = yield* DateTime.now;
          const commandId = CommandId.make(`${name}-complete`);
          // The provider completion is the fixture boundary; capture and rollback use real effects.
          yield* outbox.cancelUnsettled({
            threadId,
            effectTypes: ["provider-turn.start"],
            reason: "provider completion supplied by fixture",
          });
          yield* eventSink.writeWithEffects({
            commandId,
            events: [
              {
                id: EventId.make(`${name}-run`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "waiting", startedAt: now },
              },
              {
                id: EventId.make(`${name}-node`),
                type: "node.updated",
                threadId,
                runId: run.id,
                nodeId: node.id,
                occurredAt: now,
                payload: { ...node, status: "completed", completedAt: now },
              },
              {
                id: EventId.make(`${name}-turn`),
                type: "provider-turn.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`${name}-turn`),
                  providerThreadId: providerThread.id,
                  nodeId: node.id,
                  runAttemptId: run.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: run.ordinal,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
            effects: [
              {
                id: `${name}-capture`,
                commandId,
                threadId,
                request: {
                  type: "checkpoint.capture",
                  runId: run.id,
                  scopeId: node.checkpointScopeId!,
                },
              },
            ],
          });
          yield* worker.drain();
          const captured = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            captured.runs.find((candidate) => candidate.id === run.id)?.status,
            "completed",
          );
          const checkpoint = captured.checkpoints.find((candidate) => candidate.runId === run.id)!;
          assert.equal(checkpoint.status, "missing");
          return { run, checkpoint };
        });

      const first = yield* completeMessage("non-git-first");
      const second = yield* completeMessage("non-git-second");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        before.checkpoints.find((checkpoint) => checkpoint.id === first.checkpoint.id)?.runId,
        first.run.id,
        "capturing a later run must preserve the earlier checkpoint's run link",
      );
      const baseline = before.checkpoints.find(
        (checkpoint) => checkpoint.ordinalWithinScope === 0,
      )!;
      assert.equal(baseline.status, "missing");
      for (const checkpoint of [baseline, first.checkpoint]) {
        for (const restoreFiles of [undefined, true]) {
          const commandId = CommandId.make(`non-git-files-${checkpoint.id}-${restoreFiles}`);
          yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId,
              threadId,
              checkpointId: checkpoint.id,
              scopeId: checkpoint.scopeId,
              ...(restoreFiles === undefined ? {} : { restoreFiles }),
            })
            .pipe(Effect.flip);
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        }
      }
      assert.equal(rollbackThread.mock.calls.length, 0);

      const rewind = (name: string) =>
        Effect.gen(function* () {
          const commandId = CommandId.make(name);
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId: baseline.id,
            scopeId: baseline.scopeId,
            restoreFiles: false,
          });
          yield* worker.drain();
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.status),
            ["succeeded"],
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.ok(projection.runs.every((run) => run.status === "rolled_back"));
          assert.isNull(projection.providerThreads[0]!.lastRunOrdinal);
          assert.equal(
            projection.providerThreads[0]!.nativeThreadRef?.nativeId,
            "rewound-native-thread",
          );
          assert.isNull(projection.thread.rollbackFailure);
        });

      yield* rewind("non-git-rewind-first");
      assert.equal(rollbackThread.mock.calls[0]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[0]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-first-turn"), ProviderTurnId.make("non-git-second-turn")],
      );
      const discardedCommandId = CommandId.make("non-git-discarded-target");
      yield* orchestrator
        .dispatch({
          type: "checkpoint.rollback",
          commandId: discardedCommandId,
          threadId,
          checkpointId: second.checkpoint.id,
          scopeId: second.checkpoint.scopeId,
          restoreFiles: false,
        })
        .pipe(Effect.flip);
      assert.deepEqual(yield* outbox.listByCommandId(discardedCommandId), []);
      assert.equal(rollbackThread.mock.calls.length, 1);

      const resent = yield* completeMessage("non-git-resent");
      assert.isAbove(resent.run.ordinal, second.run.ordinal);
      yield* rewind("non-git-rewind-again");
      assert.equal(rollbackThread.mock.calls.length, 2);
      assert.equal(rollbackThread.mock.calls[1]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[1]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-resent-turn")],
      );
    }).pipe(Effect.provide(Layer.merge(Layer.fresh(layerTest), NodeServices.layer))),
  );

  it.effect("rejects non-ready rollback targets before persisting events or effects", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("runtime-rollback-readiness");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-rollback-readiness-create"),
        threadId,
        projectId: ProjectId.make("runtime-rollback-readiness-project"),
        title: "Rollback readiness",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-rollback-readiness-message"),
        threadId,
        messageId: MessageId.make("runtime-rollback-readiness-message"),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const scope = projection.checkpointScopes[0]!;
      const now = yield* DateTime.now;

      for (const status of ["missing", "error", "stale", "ready"] as const) {
        const checkpointId = CheckpointId.make("runtime-rollback-checkpoint");
        const commandId = CommandId.make(`runtime-rollback-${status}`);
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-rollback-${status}-seed`),
          events: [
            {
              id: EventId.make(`runtime-rollback-${status}-event`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: {
                id: checkpointId,
                threadId,
                scopeId: scope.id,
                runId: null,
                nodeId: scope.nodeId,
                parentCheckpointId: null,
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                ref: CheckpointRef.make(`refs/t3/runtime-rollback-${status}`),
                status,
                files: [],
                capturedAt: now,
              },
            },
          ],
        });
        const previousSequence = yield* orchestrator.getThreadEventSequence(threadId);
        const rollback = orchestrator.dispatch({
          type: "checkpoint.rollback",
          commandId,
          threadId,
          checkpointId,
          scopeId: scope.id,
        });

        if (status === "ready") {
          const accepted = yield* rollback;
          assert.deepEqual(
            accepted.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request.type),
            ["provider-thread.rollback"],
          );
          const path = yield* Path.Path.pipe(
            Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("runtime-rollback-ancestor-create"),
            threadId: ThreadId.make("runtime-rollback-ancestor"),
            projectId: ProjectId.make("runtime-rollback-readiness-project"),
            title: "Ancestor workspace owner",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: path.dirname(process.cwd()),
          });
          const overlapCommandId = CommandId.make("runtime-rollback-overlap");
          const overlapSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const overlap = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: overlapCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(overlap.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), overlapSequence);
          assert.deepEqual(yield* outbox.listByCommandId(overlapCommandId), []);
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("runtime-rollback-share"),
            threadId,
            worktreePath: null,
          });
          const sharedCommandId = CommandId.make("runtime-rollback-shared");
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          const shared = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: sharedCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(shared.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
          assert.deepEqual(yield* outbox.listByCommandId(sharedCommandId), []);
          const conversationOnly = yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("runtime-rollback-conversation"),
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          });
          assert.deepEqual(
            conversationOnly.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-rollback-delete"),
            threadId,
          });
          const deletedCommandId = CommandId.make("runtime-rollback-deleted");
          const deletedSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const deleted = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: deletedCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
              restoreFiles: false,
            })
            .pipe(Effect.flip);
          assert.instanceOf(deleted, Orchestrator.OrchestratorDispatchError);
          assert.equal(deleted.cause, `Thread ${threadId} is deleted.`);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), deletedSequence);
          assert.deepEqual(yield* outbox.listByCommandId(deletedCommandId), []);
        } else {
          const error = yield* rollback.pipe(Effect.flip);
          assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
          assert.equal(
            error.cause,
            `Checkpoint ${checkpointId} is ${status} and cannot be restored.`,
          );
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), previousSequence);
          assert.deepEqual(
            yield* eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect),
            [],
          );
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
          if (status === "error") {
            // A failed capture still pins the conversation.
            const conversationCommandId = CommandId.make("runtime-rollback-error-conversation");
            const conversationOnly = yield* orchestrator.dispatch({
              type: "checkpoint.rollback",
              commandId: conversationCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
              restoreFiles: false,
            });
            assert.deepEqual(
              conversationOnly.storedEvents.map((stored) => stored.event.type),
              ["thread.metadata-updated", "checkpoint.rollback-requested"],
            );
            assert.deepEqual(
              (yield* outbox.listByCommandId(conversationCommandId)).map(
                (effect) => effect.request.type,
              ),
              ["provider-thread.rollback"],
            );
          }
        }
      }
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("resolves delivery intent and protects scheduled steering", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const threadId = ThreadId.make("runtime-delivery-intent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-create"),
        threadId,
        projectId: ProjectId.make("runtime-delivery-intent-project"),
        title: "Delivery intent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-first"),
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-first"),
        text: "Start work.",
        scheduledTaskId: ScheduledTaskId.make("task:steering"),
        author: { id: "bob", name: "Bob" },
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const providerThread = initial.providerThreads[0]!;
      const now = yield* DateTime.now;
      const providerSession = {
        id: providerThread.providerSessionId!,
        driver,
        providerInstanceId: modelSelection.instanceId,
        status: "running" as const,
        cwd: process.cwd(),
        model: modelSelection.model,
        capabilities: FULL_TEST_PROVIDER_CAPABILITIES,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const providerTurn = {
        id: ProviderTurnId.make("runtime-delivery-intent-turn"),
        providerThreadId: providerThread.id,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-running"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-event"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-session-event"),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: providerSession,
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-event"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: providerTurn,
          },
        ],
      });
      const sessionSpy = vi.spyOn(sessions, "get").mockReturnValue(
        Effect.succeedSome({
          providerSession,
        } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));

      const beforeSteer = yield* orchestrator.getThreadProjection(threadId);
      for (const author of [{ id: "alice", name: "Alice" }, undefined]) {
        for (const mode of ["steer_active", "restart_active"] as const) {
          const commandId = CommandId.make(`forbidden:${author?.id}:${mode}`);
          const error = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId,
              threadId,
              messageId: MessageId.make(commandId),
              text: "Attacker instructions",
              attachments: [],
              ...(author === undefined ? {} : { author }),
              dispatchMode: { type: mode, targetRunId: run.id },
            })
            .pipe(Effect.flip);
          assert.include(String(error.cause), "Only the run's author");
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(threadId)).messages,
            beforeSteer.messages,
          );
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        }
      }
      const steerCommandId = CommandId.make("runtime-delivery-intent-auto");
      const steerMessageId = MessageId.make("runtime-delivery-intent-auto");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: steerCommandId,
        threadId,
        messageId: steerMessageId,
        text: "Include this in the active work.",
        author: { id: "bob", name: "Bob" },
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      const steered = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(steered.runs, 1);
      assert.equal(
        steered.messages.find((message) => message.id === steerMessageId)?.runId,
        run.id,
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(steerCommandId)).map((effect) => effect.request),
        [
          {
            type: "provider-turn.steer",
            providerSessionId: providerSession.id,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            messageId: steerMessageId,
            modelSelection: run.modelSelection,
            steerFollowUpAfterRunOrdinal: run.ordinal,
          },
        ],
      );

      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-completed"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-completed"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...providerTurn, status: "completed", completedAt: now },
          },
        ],
      });
      const nextCommandId = CommandId.make("runtime-delivery-intent-next");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: nextCommandId,
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-next"),
        text: "The previous run finished before this arrived.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "restart",
      });
      const restarted = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        restarted.runs.map((candidate) => candidate.status),
        ["completed", "starting"],
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(nextCommandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );
    }),
  );

  // regression: #37412 one thread's busy lock held up every other thread's run-end reaction
  it.effect("starts an idle thread's queued run while another thread's lock is busy", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const now = yield* DateTime.now;
      const startRun = Effect.fnUntraced(function* (threadId: ThreadId) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make("runtime-run-end-isolation-project"),
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:first`),
          threadId,
          messageId: MessageId.make(`${threadId}:first`),
          text: "Start work.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* eventSink.write({
          commandId: CommandId.make(`${threadId}:running`),
          events: [
            {
              id: EventId.make(`${threadId}:running-event`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now },
            },
          ],
        });
        return run;
      });
      const endRun = (run: OrchestrationV2Run) =>
        eventSink.write({
          commandId: CommandId.make(`${run.threadId}:completed`),
          events: [
            {
              id: EventId.make(`${run.threadId}:completed-event`),
              type: "run.updated",
              threadId: run.threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
      const busyThreadId = ThreadId.make("runtime-run-end-isolation-busy");
      const idleThreadId = ThreadId.make("runtime-run-end-isolation-idle");
      const busyRun = yield* startRun(busyThreadId);
      const idleRun = yield* startRun(idleThreadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${idleThreadId}:queue`),
        threadId: idleThreadId,
        messageId: MessageId.make(`${idleThreadId}:queued`),
        text: "Run this after the current turn.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedRun = (yield* orchestrator.getThreadProjection(idleThreadId)).runs.find(
        (run) => run.status === "queued",
      );
      assert.isDefined(queuedRun);

      const order: string[] = [];
      const queuedRunStarted = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queuedRun.id &&
            event.payload.status !== "queued",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(Effect.sync(() => order.push("idle thread's queued run started"))),
        Effect.forkScoped,
      );
      // Stands in for a long send or delegated bookkeeping holding the busy thread's lock.
      const lockHeld = yield* Deferred.make<void>();
      const busyLock = yield* executor
        .withLock(
          busyThreadId,
          Deferred.succeed(lockHeld, undefined).pipe(
            Effect.andThen(Effect.sleep("1 minute")),
            Effect.andThen(Effect.sync(() => order.push("busy thread's lock released"))),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(lockHeld);

      yield* endRun(busyRun);
      yield* endRun(idleRun);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(busyLock);
      yield* Fiber.join(queuedRunStarted);

      assert.deepEqual(order, ["idle thread's queued run started", "busy thread's lock released"]);
    }),
  );

  // regression: one coordinator's busy lock held up every other coordinator's question wake
  it.effect("wakes an idle coordinator for its task's question while another's lock is busy", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const now = yield* DateTime.now;
      const delegate = Effect.fnUntraced(function* (parentThreadId: ThreadId) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${parentThreadId}:create`),
          threadId: parentThreadId,
          projectId: ProjectId.make("runtime-question-wake-project"),
          title: parentThreadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${parentThreadId}:first`),
          threadId: parentThreadId,
          messageId: MessageId.make(`${parentThreadId}:first`),
          text: "Delegate the research.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`${parentThreadId}:delegate`),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Research the sources.",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "settled_only",
        });
        const childThreadId = (yield* orchestrator.getThreadProjection(parentThreadId))
          .subagents[0]!.childThreadId!;
        const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
        const requestId = RuntimeRequestId.make(`${childThreadId}:question`);
        return {
          wakeMessageId: MessageId.make(
            `message:delegated-task-question:${parentThreadId}:${requestId}`,
          ),
          ask: eventSink.write({
            events: [
              {
                id: EventId.make(`${childThreadId}:question-event`),
                type: "runtime-request.updated",
                threadId: childThreadId,
                runId: childRun.id,
                occurredAt: now,
                payload: {
                  id: requestId,
                  nodeId: childRun.rootNodeId!,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "message" },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
            ],
          }),
        };
      });
      // Started as server.ts starts it, so its wakes come from its own event stream.
      yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor.pipe(
        Effect.flatMap((reactor) => reactor.start()),
        Effect.provide(DelegatedTaskQuestionReactor.layer),
      );
      const busyThreadId = ThreadId.make("runtime-question-wake-busy");
      const busy = yield* delegate(busyThreadId);
      const idle = yield* delegate(ThreadId.make("runtime-question-wake-idle"));

      const order: string[] = [];
      const idleWoken = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "message.updated" && event.payload.id === idle.wakeMessageId,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(Effect.sync(() => order.push("idle coordinator woken"))),
        Effect.forkScoped,
      );
      // Stands in for a long send or delegated bookkeeping holding the busy coordinator's lock.
      const lockHeld = yield* Deferred.make<void>();
      const busyLock = yield* executor
        .withLock(
          busyThreadId,
          Deferred.succeed(lockHeld, undefined).pipe(
            Effect.andThen(Effect.sleep("1 minute")),
            Effect.andThen(Effect.sync(() => order.push("busy coordinator's lock released"))),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(lockHeld);

      yield* busy.ask;
      yield* idle.ask;
      // The wake reads the workspace from disk; behind the busy lock it would never arrive here.
      yield* Fiber.join(idleWoken);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(busyLock);

      assert.deepEqual(order, ["idle coordinator woken", "busy coordinator's lock released"]);
    }),
  );

  const seedPendingQuestion = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId | null,
    responseCapability: OrchestrationV2RuntimeRequest["responseCapability"],
  ) {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`${threadId}:request`);
    const nodeId = NodeId.make(`${threadId}:node`);
    const itemId = TurnItemId.make(`${threadId}:item`);
    yield* eventSink.write({
      commandId: CommandId.make(`${threadId}:seed`),
      events: [
        {
          id: EventId.make(`${threadId}:node-event`),
          type: "node.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
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
        {
          id: EventId.make(`${threadId}:request-event`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:item-event`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: itemId,
            type: "user_input_request",
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            requestId,
            questions: [
              { id: "color", header: "Color", question: "Which color?", options: [] },
              {
                id: "sizes",
                header: "Sizes",
                question: "Which sizes?",
                options: [],
                multiSelect: true,
              },
              {
                id: "note",
                header: "Note",
                question: "Anything else?",
                options: [],
                required: false,
              },
            ],
          },
        },
      ],
    });
    return { requestId, nodeId, itemId };
  });

  it.effect.each([
    { trigger: "startup", scope: "run" },
    { trigger: "shutdown", scope: "session" },
  ] as const)(
    "recovers only reconstructable user questions and keeps their cards pending on $trigger ($scope)",
    ({ trigger, scope }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`runtime-recovered-question-${trigger}-${scope}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`runtime-recovered-question-create-${trigger}-${scope}`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make(`runtime-recovered-question-project-${trigger}-${scope}`),
          title: "Async question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        if (scope === "run") {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:run`),
            threadId,
            messageId: MessageId.make(`${threadId}:message`),
            text: "Ask me a question",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
        }
        const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.id ?? null;
        const { requestId, nodeId, itemId } = yield* seedPendingQuestion(threadId, runId, {
          type: "live",
          providerSessionId: ProviderSessionId.make(`lost-session-${trigger}-${scope}`),
        });
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const original = yield* orchestrator.getThreadProjection(threadId);
        const request = original.runtimeRequests[0]!;
        const questionItem = original.turnItems.find((item) => item.type === "user_input_request")!;
        const nativeThreadId = ThreadId.make(`runtime-recovered-native-child-${trigger}-${scope}`);
        const nativeRequestId = RuntimeRequestId.make(
          `runtime-recovered-native-request-${trigger}-${scope}`,
        );
        const approvalId = RuntimeRequestId.make(`runtime-recovered-approval-${trigger}-${scope}`);
        const missingTextId = RuntimeRequestId.make(
          `runtime-recovered-missing-text-${trigger}-${scope}`,
        );
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`recovery-approval-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: { ...request, id: approvalId, kind: "command" },
            },
            {
              id: EventId.make(`recovery-missing-text-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: { ...request, id: missingTextId },
            },
            {
              id: EventId.make(`recovery-native-thread-${trigger}-${scope}`),
              type: "thread.created",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: {
                ...original.thread,
                id: nativeThreadId,
                creationSource: "provider",
                lineage: {
                  parentThreadId: threadId,
                  rootThreadId: threadId,
                  relationshipToParent: "subagent",
                },
              },
            },
            {
              id: EventId.make(`recovery-native-request-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: { ...request, id: nativeRequestId },
            },
            {
              id: EventId.make(`recovery-native-item-${trigger}-${scope}`),
              type: "turn-item.updated",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: {
                ...questionItem,
                id: TurnItemId.make(`recovery-native-item-${trigger}-${scope}`),
                type: "user_input_request",
                threadId: nativeThreadId,
                runId: null,
                requestId: nativeRequestId,
                questions: [
                  { id: "color", header: "Color", question: "Which color?", options: [] },
                ],
              },
            },
          ],
        });
        yield* recovery.reconcile(trigger);
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        if (scope === "run") {
          assert.equal(recovered.runs[0]?.status, "cancelled");
        } else {
          assert.isEmpty(recovered.runs);
        }
        assert.deepEqual(
          recovered.runtimeRequests.find((row) => row.id === requestId),
          {
            ...request,
            responseCapability: { type: "message" },
          },
        );
        assert.equal(recovered.nodes.find((row) => row.id === nodeId)?.status, "waiting");
        assert.equal(recovered.turnItems.find((row) => row.id === itemId)?.status, "waiting");
        for (const id of [approvalId, missingTextId]) {
          const closed = recovered.runtimeRequests.find((row) => row.id === id);
          assert.equal(closed?.status, trigger === "startup" ? "expired" : "cancelled");
          assert.equal(closed?.responseCapability.type, "not_resumable");
        }
        const native = yield* orchestrator.getThreadProjection(nativeThreadId);
        assert.equal(
          native.runtimeRequests[0]?.status,
          trigger === "startup" ? "expired" : "cancelled",
        );
        assert.equal(native.runtimeRequests[0]?.responseCapability.type, "not_resumable");
        yield* recovery.reconcile("shutdown");
        yield* recovery.reconcile("startup");
        const rerecovered = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(rerecovered.runtimeRequests, recovered.runtimeRequests);
        const runItems = rerecovered.turnItems.filter((item) => item.runId === runId);
        const notices = runItems.filter((item) => item.type === "system_notice");
        assert.lengthOf(notices, scope === "run" ? 1 : 0);
        if (scope === "run") {
          assert.equal(notices[0]?.title, "Server restarted");
          assert.equal(notices[0]?.nodeId, recovered.runs[0]?.rootNodeId);
          assert.equal(notices[0]?.ordinal, Math.max(...runItems.map((item) => item.ordinal)));
        }
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`recovery-answer-${trigger}-${scope}`),
          threadId,
          requestId,
          answers: { color: "Blue", sizes: ["Small", "Large"] },
        });
        const answered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          answered.runtimeRequests.find((row) => row.id === requestId)?.status,
          "resolved",
        );
        assert.equal(answered.nodes.find((row) => row.id === nodeId)?.status, "completed");
        assert.equal(answered.turnItems.find((row) => row.id === itemId)?.status, "completed");
        assert.lengthOf(answered.runs, recovered.runs.length + 1);
        assert.equal(answered.messages.at(-1)?.runId, answered.runs.at(-1)?.id);
        assert.equal(
          answered.messages.at(-1)?.text,
          "Which color?\nBlue\n\nWhich sizes?\nSmall, Large",
        );
        assert.deepEqual(
          (yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make(`recovery-answer-${trigger}-${scope}`),
          )).map((effect) => effect.request.type),
          ["provider-turn.start"],
        );
      }),
  );

  it.effect("answers an async question after its provider exits and commits the answer once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-async-question");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-async-question-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-async-question-project"),
        title: "Async question",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const { requestId, nodeId, itemId } = yield* seedPendingQuestion(threadId, null, {
        type: "message",
      });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const beforeSnooze = yield* orchestrator.getThreadProjection(threadId);
      const snooze = {
        type: "thread.snooze" as const,
        commandId: CommandId.make("runtime-async-question-snooze"),
        threadId,
        snoozedUntil: "2099-07-25T09:00:00.000Z",
      };
      yield* orchestrator.dispatch(snooze);
      const snoozed = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(snoozed.thread.snoozedUntil);
      assert.deepEqual(snoozed.runtimeRequests, beforeSnooze.runtimeRequests);
      assert.deepEqual(snoozed.turnItems, beforeSnooze.turnItems);
      assert.deepEqual(snoozed.nodes, beforeSnooze.nodes);
      assert.deepEqual(snoozed.runs, beforeSnooze.runs);

      // A question arriving after an earlier snooze must be acknowledged even
      // when the user picks the same wake time again.
      const priorSnooze = DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 1_000);
      yield* eventSink.write({
        commandId: CommandId.make("runtime-async-question-earlier-snooze"),
        events: [
          {
            id: EventId.make("runtime-async-question-earlier-snooze-event"),
            type: "thread.snoozed",
            threadId,
            occurredAt: priorSnooze,
            payload: { ...snoozed.thread, snoozedAt: priorSnooze },
          },
        ],
      });
      yield* orchestrator.dispatch({
        ...snooze,
        commandId: CommandId.make("runtime-async-question-resnooze"),
      });
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedAt, now);
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-async-question-wake"),
        threadId,
        reason: "user",
      });
      const awake = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awake.thread.snoozedUntil);
      assert.deepEqual(awake.runtimeRequests, beforeSnooze.runtimeRequests);

      const beforeInvalid = yield* orchestrator.getThreadProjection(threadId);
      const beforeSequence = yield* eventSink.latestSequence();
      for (const [index, answers] of [
        { color: " ", sizes: ["Small"] },
        { color: "Blue", sizes: ["Small", " "] },
        { color: "Blue", sizes: ["Small"], extra: " " },
      ].entries()) {
        const commandId = CommandId.make(`runtime-async-question-invalid:${index}`);
        const invalid = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId,
            threadId,
            requestId,
            answers,
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure", JSON.stringify(answers));
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), beforeInvalid);
        assert.equal(yield* eventSink.latestSequence(), beforeSequence);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }

      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("runtime-async-question-answer"),
        threadId,
        requestId,
        answers: { color: "  Blue  ", sizes: [], note: "" },
      };
      const accepted = yield* orchestrator.dispatch(command);
      const repeated = yield* orchestrator.dispatch(command);
      assert.equal(repeated.sequence, accepted.sequence);
      const answered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(answered.runtimeRequests[0]?.status, "resolved");
      assert.deepEqual(answered.runtimeRequests[0]?.answers, command.answers);
      assert.equal(answered.nodes.find((node) => node.id === nodeId)?.status, "completed");
      assert.equal(answered.turnItems.find((item) => item.id === itemId)?.status, "completed");
      const answeredItem = answered.turnItems.find((item) => item.id === itemId);
      assert.equal(answeredItem?.type, "user_input_request");
      if (answeredItem?.type === "user_input_request") {
        assert.deepEqual(answeredItem.questionAnswer, {
          requestId,
          answers: command.answers,
          attachmentsByQuestionId: {},
          questionTextById: {
            color: "Which color?",
            sizes: "Which sizes?",
            note: "Anything else?",
          },
        });
      }
      assert.equal(answered.messages.length, 1);
      assert.equal(answered.messages[0]?.text, "Which color?\nBlue\n\nWhich sizes?\nNone selected");
      assert.equal(answered.messages[0]?.role, "user");
      assert.equal(answered.runs.length, 1);
      assert.deepEqual(
        (yield* outbox.listByCommandId(command.commandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );

      const duplicate = yield* orchestrator
        .dispatch({
          ...command,
          commandId: CommandId.make("runtime-async-question-duplicate"),
        })
        .pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
    }),
  );

  it.effect("sends an async answer's files as attachments on the answer message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-async-question-files");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-async-question-files-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-async-question-files-project"),
        title: "Async question with files",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const { requestId } = yield* seedPendingQuestion(threadId, null, { type: "message" });
      const screenshot = {
        type: "image" as const,
        id: createAttachmentId(threadId)!,
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("runtime-async-question-files-answer"),
        threadId,
        requestId,
        answers: { color: "", sizes: ["Small"], note: "" },
        attachmentsByQuestionId: { color: [screenshot] },
      });
      const answered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(answered.messages.length, 1);
      assert.equal(answered.messages[0]?.text, "Which color?\n\nWhich sizes?\nSmall");
      assert.deepEqual(answered.messages[0]?.attachments, [screenshot]);
    }),
  );

  it.effect("reports an answer that never reaches its provider without reopening it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("runtime-lost-answer");
      // Projected as attached, but no live session holds it, so every delivery fails.
      const providerSessionId = ProviderSessionId.make("runtime-lost-answer-session");
      const requestId = RuntimeRequestId.make("runtime-lost-answer-request");
      const nodeId = NodeId.make("runtime-lost-answer-node");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-lost-answer-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-lost-answer-project"),
        title: "Lost answer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* eventSink.write({
        commandId: CommandId.make("runtime-lost-answer-seed"),
        events: [
          {
            id: EventId.make("runtime-lost-answer-session-event"),
            type: "provider-session.attached",
            threadId,
            driver,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "running",
              cwd: process.cwd(),
              model: modelSelection.model,
              capabilities: FULL_TEST_PROVIDER_CAPABILITIES,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make("runtime-lost-answer-node-event"),
            type: "node.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
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
          {
            id: EventId.make("runtime-lost-answer-request-event"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "live", providerSessionId },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const commandId = CommandId.make("runtime-lost-answer-answer");
      const answers = { color: "Blue" };
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId,
        answers,
      });
      const errors = orchestrator
        .getThreadProjection(threadId)
        .pipe(
          Effect.map((projection) => projection.turnItems.filter((item) => item.type === "error")),
        );

      // A delivery that can still be retried reports nothing.
      yield* worker.drain();
      assert.deepEqual(yield* errors, []);
      for (let attempt = 1; attempt < 5; attempt++) {
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
      }

      const [deliveryEffect] = yield* outbox.listByCommandId(commandId);
      assert.equal(deliveryEffect?.request.type, "runtime-request.respond");
      assert.equal(deliveryEffect?.status, "failed");
      const failed = yield* orchestrator.getThreadProjection(threadId);
      const reported = failed.turnItems.filter((item) => item.type === "error");
      assert.equal(reported.length, 1);
      assert.equal(reported[0]?.status, "failed");
      assert.equal(reported[0]?.nodeId, nodeId);
      // The answer stays recorded; the user is not asked again.
      const request = failed.runtimeRequests.find((row) => row.id === requestId);
      assert.equal(request?.status, "resolved");
      assert.deepEqual(request?.answers, answers);
    }),
  );

  it.effect("dismisses message-capable questions directly and while settling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;

      const seedQuestion = Effect.fn("runtimeLayerTest.seedQuestion")(function* (name: string) {
        const threadId = ThreadId.make(`${name}-thread`);
        const requestId = RuntimeRequestId.make(`${name}-request`);
        const nodeId = NodeId.make(`${name}-node`);
        const itemId = TurnItemId.make(`${name}-item`);
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}-create`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make(`${name}-project`),
          title: "Dismissible question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* eventSink.write({
          commandId: CommandId.make(`${name}-seed`),
          events: [
            {
              id: EventId.make(`${name}-node-event`),
              type: "node.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: nodeId,
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
            {
              id: EventId.make(`${name}-request-event`),
              type: "runtime-request.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make(`${name}-item-event`),
              type: "turn-item.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: itemId,
                type: "user_input_request",
                threadId,
                runId: null,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                responseMode: "message",
                questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [] }],
              },
            },
          ],
        });
        return { threadId, requestId, nodeId, itemId };
      });

      const dismissed = yield* seedQuestion("runtime-dismiss-question");
      yield* orchestrator.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make("runtime-dismiss-question-command"),
        threadId: dismissed.threadId,
        requestId: dismissed.requestId,
      });
      const dismissedProjection = yield* orchestrator.getThreadProjection(dismissed.threadId);
      assert.equal(dismissedProjection.runtimeRequests[0]?.status, "resolved");
      assert.equal(dismissedProjection.runtimeRequests[0]?.decision, "cancel");
      assert.equal(
        dismissedProjection.nodes.find((node) => node.id === dismissed.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        dismissedProjection.turnItems.find((item) => item.id === dismissed.itemId)?.status,
        "cancelled",
      );
      assert.lengthOf(dismissedProjection.messages, 0);

      const settled = yield* seedQuestion("runtime-settle-question");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-settle-question-command"),
        threadId: settled.threadId,
      });
      const settledProjection = yield* orchestrator.getThreadProjection(settled.threadId);
      assert.equal(settledProjection.thread.settledOverride, "settled");
      assert.equal(settledProjection.runtimeRequests[0]?.status, "resolved");
      assert.equal(settledProjection.runtimeRequests[0]?.decision, "cancel");
      assert.equal(
        settledProjection.nodes.find((node) => node.id === settled.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        settledProjection.turnItems.find((item) => item.id === settled.itemId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("refuses busy merge-back targets without blocking the queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("runtime-layer-waiting-merge-project");
      const targetThreadId = ThreadId.make("runtime-layer-waiting-merge-target");
      const sourceThreadId = ThreadId.make("runtime-layer-waiting-merge-source");
      const baseRunId = RunId.make("runtime-layer-waiting-merge-base-run");
      const sourceRunId = RunId.make("runtime-layer-waiting-merge-source-run");
      const sourceProviderThreadId = ProviderThreadId.make(
        "runtime-layer-waiting-merge-provider-thread",
      );
      const forkTransferId = ContextTransferId.make("runtime-layer-waiting-merge-fork-transfer");

      yield* seedProject({
        projectId,
        title: "Merge-back project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-waiting-merge-create-target"),
        threadId: targetThreadId,
        projectId,
        title: "Waiting merge target",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);

      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-waiting-merge-seed"),
        events: [
          {
            id: EventId.make("runtime-layer-waiting-merge-source-thread-event"),
            type: "thread.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...target.thread,
              id: sourceThreadId,
              title: "Waiting merge source",
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: targetThreadId,
                relationshipToParent: "fork",
                rootThreadId: targetThreadId,
              },
              forkedFrom: {
                type: "run",
                threadId: targetThreadId,
                runId: baseRunId,
              },
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-fork-transfer-event"),
            type: "context-transfer.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: forkTransferId,
              type: "fork",
              sourceThreadId: targetThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { threadId: targetThreadId, runId: baseRunId },
              basePoint: null,
              sourceProviderInstanceId: modelSelection.instanceId,
              targetProviderInstanceId: modelSelection.instanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-provider-thread-event"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceProviderThreadId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: "native-waiting-merge-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-source-run-event"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: sourceProviderThreadId,
              userMessageId: MessageId.make("runtime-layer-waiting-merge-message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "waiting",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-merge-target-start"),
        threadId: targetThreadId,
        messageId: MessageId.make("runtime-layer-merge-target-message"),
        text: "Keep working in the parent.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const activeTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const targetRun = activeTarget.runs[0]!;
      for (const status of ["preparing", "starting", "waiting", "queued", "running"] as const) {
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-layer-merge-target-${status}`),
          events: [
            {
              id: EventId.make(`runtime-layer-merge-target-${status}-event`),
              type: "run.updated",
              threadId: targetThreadId,
              runId: targetRun.id,
              occurredAt: now,
              payload: { ...targetRun, status },
            },
          ],
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.merge_back",
            createdBy: "user",
            creationSource: "mobile",
            commandId: CommandId.make(`runtime-layer-merge-refused-${status}`),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "run", runId: sourceRunId },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.equal(
          error.cause,
          "Finish or stop the target thread's active work and clear its queue before merging back.",
        );
        const refusedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.deepEqual(refusedTarget.contextTransfers, activeTarget.contextTransfers);
        assert.equal(refusedTarget.runs[0]?.status, status);
      }
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-merge-target-queue"),
        threadId: targetThreadId,
        messageId: MessageId.make("runtime-layer-merge-target-queued-message"),
        text: "Run this after the current turn.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const queuedRun = queuedTarget.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-merge-target-cancel-queue"),
        threadId: targetThreadId,
        runId: queuedRun.id,
      });
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-merge-target-complete"),
        events: [
          {
            id: EventId.make("runtime-layer-merge-target-completed-event"),
            type: "run.updated",
            threadId: targetThreadId,
            runId: targetRun.id,
            occurredAt: now,
            payload: { ...targetRun, status: "completed", completedAt: now },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.merge_back",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make("runtime-layer-waiting-merge"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdAt: now,
      });

      const mergedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const transfer = mergedTarget.contextTransfers.find(
        (candidate) => candidate.type === "merge_back",
      );
      assert.isDefined(transfer);
      assert.equal(transfer.status, "pending");
      assert.equal(transfer.sourceThreadId, sourceThreadId);
      assert.equal(transfer.targetThreadId, targetThreadId);
      assert.equal(transfer.sourcePoint.runId, sourceRunId);
      assert.isUndefined(transfer.sourcePoint.checkpointId);
      assert.equal(transfer.sourcePoint.providerThreadRef?.nativeId, "native-waiting-merge-source");
      assert.equal(transfer.basePoint?.runId, baseRunId);
      assert.isNull(transfer.error);
    }),
  );
});

it.layer(layerLegacyImportTest)("OrchestrationV2 legacy import", (it) => {
  it.effect("hydrates imported transcripts before commands and propagates hydration failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const metadataThreadId = ThreadId.make("runtime-layer-legacy-metadata-thread");
      const failureThreadId = ThreadId.make("runtime-layer-legacy-failure-thread");
      const projectId = ProjectId.make("runtime-layer-legacy-project");

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
          ${projectId},
          'Legacy project',
          '/tmp/runtime-layer-legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
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
        ) VALUES
          (
            ${metadataThreadId},
            ${projectId},
            'Legacy metadata title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            ${failureThreadId},
            ${projectId},
            'Legacy failure title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
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
            'message:runtime-layer-legacy:1',
            ${metadataThreadId},
            NULL,
            'user',
            'First imported question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:2',
            ${metadataThreadId},
            NULL,
            'assistant',
            'First imported answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:3',
            ${metadataThreadId},
            NULL,
            'user',
            'Latest imported question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:failure',
            ${failureThreadId},
            NULL,
            'user',
            'Imported context must load before archive',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          )
      `;

      yield* importer.reconcileShells;
      assert.isTrue((yield* maintenance.verify).valid);

      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-legacy-metadata-update"),
        threadId: metadataThreadId,
        title: "Updated after import",
      });
      const updatedProjection = yield* threadManagement.getThreadProjection(metadataThreadId);
      assert.equal(updatedProjection.thread.title, "Updated after import");
      assert.deepEqual(
        updatedProjection.messages.map((message) => message.text),
        ["First imported question", "First imported answer", "Latest imported question"],
      );

      yield* sql`
        ALTER TABLE projection_thread_messages
        RENAME TO projection_thread_messages_unavailable
      `;
      const { projectionFailure, hydrationFailure } = yield* Effect.all({
        projectionFailure: threadManagement.getThreadProjection(failureThreadId).pipe(Effect.flip),
        hydrationFailure: threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("runtime-layer-legacy-failed-archive"),
            threadId: failureThreadId,
          })
          .pipe(Effect.flip),
      }).pipe(
        Effect.ensuring(
          sql`
            ALTER TABLE projection_thread_messages_unavailable
            RENAME TO projection_thread_messages
          `.pipe(Effect.orDie),
        ),
      );
      assert.instanceOf(projectionFailure, Orchestrator.OrchestratorProjectionError);
      assert.instanceOf(projectionFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);
      assert.instanceOf(hydrationFailure, Orchestrator.OrchestratorDispatchError);
      assert.instanceOf(hydrationFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);

      const projectionAfterFailure = yield* orchestrator.getThreadProjection(failureThreadId);
      assert.isNull(projectionAfterFailure.thread.archivedAt);

      yield* threadManagement.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-legacy-retried-archive"),
        threadId: failureThreadId,
      });
      const projectionAfterRetry = yield* threadManagement.getThreadProjection(failureThreadId);
      assert.isNotNull(projectionAfterRetry.thread.archivedAt);
    }),
  );
});

const writeHtmlRenderRun = Effect.fn("test.writeHtmlRenderRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly ordinal: number;
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`html-fork-run:${input.key}`);
  const messageId = MessageId.make(`html-fork-message:${input.key}`);
  const attachmentId = createAttachmentId(input.threadId, "html")!;
  const fileSystem = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const pagePath = (yield* Path.Path).join(attachmentsDir, `${attachmentId}.html`);
  yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
  yield* fileSystem.writeFileString(pagePath, "<p>Page</p>");
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`html-fork-run:${input.key}`),
        type: "run.created",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: input.threadId,
          ordinal: input.ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
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
        },
      },
      {
        id: EventId.make(`html-fork-message:${input.key}`),
        type: "message.updated",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId: input.threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "Publish a page",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`html-fork-item:${input.key}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`html-fork-item:${input.key}`),
          type: "dynamic_tool",
          threadId: input.threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          toolName: "mcp__t3-code__html_render",
          input: {},
          output: [
            {
              type: "text",
              text: JSON.stringify({ htmlRender: { attachmentId, title: "Page", height: 300 } }),
            },
          ],
        },
      },
    ],
  });
  return { runId, pagePath };
});

it.layer(layerSharedApplicationDataPlaneTest)("pending provider interruption", (it) => {
  it.effect("interrupts a pending provider start without launching provider work", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const projectId = ProjectId.make("runtime-layer-pending-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-pending-interrupt-thread");

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-pending-interrupt-project-create"),
        projectId,
        title: "Pending interrupt project",
        workspaceRoot: "/tmp/runtime-layer-pending-interrupt-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-create"),
        threadId,
        projectId,
        title: "Pending interrupt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-pending-interrupt-message"),
        text: "Do not reach the provider.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const starting = yield* orchestrator.getThreadProjection(threadId);
      const run = starting.runs[0];
      assert.isDefined(run);
      assert.equal(run.status, "starting");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-pending-interrupt-command"),
        threadId,
        runId: run.id,
        reason: "Cancelled before provider start",
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const interrupted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(interrupted.runs[0]?.status, "interrupted");
      assert.equal(interrupted.attempts[0]?.status, "interrupted");
      assert.equal(
        interrupted.nodes.find((node) => node.kind === "root_turn")?.status,
        "interrupted",
      );
      assert.deepEqual(
        interrupted.turnItems.filter((item) => item.runId === run.id).map((item) => item.type),
        ["user_message", "run_interrupt_request", "run_interrupt_result"],
      );
      assert.deepEqual(interrupted.providerTurns, []);
      assert.isFalse(yield* effectWorker.runOnce());
    }),
  );

  it.effect("cancels a named queued run and leaves the active one running", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-queued-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-queued-interrupt-thread");

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-queued-interrupt-project-create"),
        projectId,
        title: "Queued interrupt project",
        workspaceRoot: "/tmp/runtime-layer-queued-interrupt-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-interrupt-create"),
        threadId,
        projectId,
        title: "Queued interrupt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      for (const [key, dispatchMode] of [
        ["active", { type: "start_immediately" }],
        ["queued", { type: "queue_after_active" }],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-queued-interrupt-${key}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-queued-interrupt-${key}`),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode,
        });
      }
      const [active, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.equal(queued?.status, "queued");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-queued-interrupt-command"),
        threadId,
        runId: queued!.id,
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => run.status),
        [active!.status, "cancelled"],
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("run output after a stop", (it) => {
  it.effect("takes a result a completed turn still owes from the turn after it", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-owed-output-project");
      const threadId = ThreadId.make("runtime-layer-owed-output-thread");
      yield* projects.create({
        commandId: CommandId.make("runtime-layer-owed-output-project-create"),
        projectId,
        title: "Owed output project",
        workspaceRoot: "/tmp/runtime-layer-owed-output-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-owed-output-create"),
        threadId,
        projectId,
        title: "Owed output",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const send = (
        key: string,
        outputSchema?: { readonly type: "object" },
        freshContext?: boolean,
      ) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-owed-output-${key}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-owed-output-${key}`),
          text: key,
          attachments: [],
          modelSelection,
          ...(outputSchema === undefined ? {} : { outputSchema }),
          ...(freshContext === undefined ? {} : { freshContext }),
          dispatchMode: { type: "start_immediately" },
        });
      const runOf = Effect.fn(function* (key: string) {
        const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
        return runs.find(
          (run) => run.userMessageId === MessageId.make(`runtime-layer-owed-output-${key}`),
        )!;
      });
      // The agent ends its turn, to wait for something or because it is done.
      const complete = Effect.fn(function* (key: string) {
        const run = yield* runOf(key);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}-${key}-completed`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: run.requestedAt,
              payload: { ...run, status: "completed", completedAt: run.requestedAt },
            },
          ],
        });
      });
      const submit = (key: string, json = '{"head":"abc"}') =>
        threadManagement.submitRunOutput({
          threadId,
          commandId: CommandId.make(`runtime-layer-owed-output-submit-${key}`),
          json,
        });
      const refused = Effect.fn(function* (key: string) {
        const rejected = yield* submit(key).pipe(Effect.flip);
        assert.include(rejected.message, "not asked for a result");
      });
      yield* send("asked", { type: "object" });
      const asked = yield* runOf("asked");
      yield* complete("asked");
      yield* send("woken");

      const accepted = yield* submit("asked");
      assert.equal(accepted.runId, asked.id);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(after.runs.find((run) => run.id === asked.id)?.output?.value, {
        head: "abc",
      });

      // Its reply was lost, and the retry comes once the next step's turn asked for a result.
      yield* complete("woken");
      yield* send("next", { type: "object" });
      assert.equal((yield* submit("asked")).runId, asked.id);
      assert.isUndefined((yield* runOf("next")).output);

      // A correction gave the result `next` owed, so a later plain turn owes nothing.
      yield* complete("next");
      yield* send("correction", { type: "object" });
      yield* submit("correction");
      yield* complete("correction");
      yield* send("plain");
      yield* refused("plain");

      // A turn in a fresh conversation cannot answer for one the agent no longer sees.
      yield* complete("plain");
      yield* send("before-fresh", { type: "object" });
      yield* complete("before-fresh");
      yield* send("fresh", undefined, true);
      yield* refused("fresh");
    }),
  );

  it.effect("turns down a provider command asked for a result", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-command-output-project");
      const threadId = ThreadId.make("runtime-layer-command-output-thread");
      yield* projects.create({
        commandId: CommandId.make("runtime-layer-command-output-project-create"),
        projectId,
        title: "Command output project",
        workspaceRoot: "/tmp/runtime-layer-command-output-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-command-output-create"),
        threadId,
        projectId,
        title: "Command output",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const rejected = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-layer-command-output-message"),
          threadId,
          messageId: MessageId.make("runtime-layer-command-output-message"),
          text: "/goal Review the changes",
          attachments: [],
          modelSelection,
          outputSchema: { type: "object" },
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      assert.include(String(rejected.cause), "cannot be asked for a result");
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runs, []);

      // Nor can a queued request for a result be edited into one.
      for (const [key, text, dispatchMode] of [
        ["active", "Start", { type: "start_immediately" }],
        ["queued", "Return a verdict.", { type: "queue_after_active" }],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-command-output-${key}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-command-output-${key}`),
          text,
          attachments: [],
          modelSelection,
          ...(key === "queued" ? { outputSchema: { type: "object" } } : {}),
          dispatchMode,
        });
      }
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "queued",
      )!;
      const edit = (key: string, text: string) =>
        orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make(`runtime-layer-command-output-edit-${key}`),
          threadId,
          runId: queued.id,
          text,
        });
      const refused = yield* edit("goal", "/goal Review the changes").pipe(Effect.flip);
      assert.include(String(refused.cause), "cannot be asked for a result");
      yield* edit("prompt", "Return a verdict, briefly.");
    }),
  );

  it.effect("turns down a result submitted after a stop was requested", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-stopped-output-project");
      const threadId = ThreadId.make("runtime-layer-stopped-output-thread");
      yield* projects.create({
        commandId: CommandId.make("runtime-layer-stopped-output-project-create"),
        projectId,
        title: "Stopped output project",
        workspaceRoot: "/tmp/runtime-layer-stopped-output-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-stopped-output-create"),
        threadId,
        projectId,
        title: "Stopped output",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-stopped-output-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-stopped-output-message"),
        text: "Return a verdict.",
        attachments: [],
        modelSelection,
        outputSchema: { type: "object" },
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      // The stop is asked for while the provider has not settled it, so the run is still active.
      const at = run.requestedAt;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}-interrupt-request`),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: at,
            payload: {
              id: TurnItemId.make(`${threadId}-interrupt-request`),
              type: "run_interrupt_request",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 90,
              status: "completed",
              title: "Interrupt requested",
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              message: "Stopped by user",
            },
          },
        ],
      });

      const rejected = yield* threadManagement
        .submitRunOutput({
          threadId,
          commandId: CommandId.make("runtime-layer-stopped-output-submit"),
          json: "{}",
        })
        .pipe(Effect.flip);
      assert.include(String((rejected as { cause?: unknown }).cause), "was stopped");
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(after.runs[0]?.output);
    }),
  );
});

it.layer(layerTest)("snooze queued runs", (it) => {
  it.effect.each(["notification", "delegated-completion", "user", "limited-user"] as const)(
    "only user messages block snooze with a queued %s run, unless a usage limit holds them",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`snooze-queued:${kind}`);
        const snoozedUntil = "2099-07-25T09:00:00.000Z";
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("snooze-queued-project"),
          title: "Snooze with held queued work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/snooze-queued",
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`active:${threadId}`),
          threadId,
          messageId: MessageId.make(`active:${threadId}`),
          text: "Active run",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        if (kind === "delegated-completion") {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`completion:${threadId}`),
                type: "run.updated",
                threadId,
                runId: activeRun.id,
                occurredAt: now,
                payload: {
                  ...activeRun,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: {
                      messageId: MessageId.make(`queued:${threadId}`),
                      generation: 1,
                      taskIds: [NodeId.make("snooze-queued-task")],
                    },
                  },
                },
              },
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`queued:${threadId}`),
          threadId,
          messageId: MessageId.make(`queued:${threadId}`),
          text: "Queued work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: kind === "user" || kind === "limited-user" ? "user" : "agent",
          creationSource: kind === "user" || kind === "limited-user" ? "web" : "server",
          ...(kind === "notification"
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : kind === "delegated-completion"
              ? {
                  delegatedCompletion: {
                    parentRunId: activeRun.id,
                    generation: 1,
                    taskIds: [NodeId.make("snooze-queued-task")],
                  },
                }
              : {}),
        });
        if (kind === "limited-user") {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`limited:${threadId}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`limited:${threadId}`),
                  type: "error",
                  threadId,
                  runId: activeRun.id,
                  nodeId: activeRun.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: "Usage limit reached",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  // A proxied provider can report no reset time.
                  failure: {
                    class: "usage_limit",
                    message: "Claude API rate limit reached. Try again later.",
                    code: "api_error_429",
                    retryable: true,
                    resetAt: null,
                  },
                },
              },
            ],
          });
        }
        const beforeRecovery = yield* orchestrator.getThreadProjection(threadId);
        yield* eventSink.commitCommand({
          commandId: CommandId.make(`recovery:${threadId}`),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: beforeRecovery.runs.map((run) => ({
            id: EventId.make(`recovery:${run.id}`),
            type: "run.updated" as const,
            threadId,
            runId: run.id,
            occurredAt: now,
            payload:
              run.status === "queued"
                ? // A usage limit stops the queue from starting without marking it held.
                  kind === "limited-user"
                  ? run
                  : { ...run, queueHeld: true }
                : {
                    ...run,
                    status: kind === "limited-user" ? ("failed" as const) : ("cancelled" as const),
                    completedAt: now,
                  },
          })),
          effects: [],
        });
        const beforeSnooze = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(
          beforeSnooze.runs.some(
            (run) => run.status === "queued" && (kind === "limited-user" || run.queueHeld),
          ),
        );
        const snooze = orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`snooze:${threadId}`),
          threadId,
          snoozedUntil,
        });
        if (kind === "user") {
          const error = yield* snooze.pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.equal(error.cause, `Thread ${threadId} has a queued run and cannot be snoozed.`);
          assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
        } else {
          yield* snooze;
          const snoozed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(DateTime.formatIso(snoozed.thread.snoozedUntil!), snoozedUntil);
          assert.deepEqual(snoozed.runs, beforeSnooze.runs);
          yield* orchestrator.dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(`unsnooze:${threadId}`),
            threadId,
            reason: "user",
          });
          const awake = yield* orchestrator.getThreadProjection(threadId);
          assert.isNull(awake.thread.snoozedUntil);
          assert.deepEqual(awake.runs, beforeSnooze.runs);
        }
      }),
  );

  it.effect.each(["notification", "user"] as const)(
    "a %s message on a snoozed thread keeps the snooze only when automatic",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`snooze-wake:${kind}`);
        const snoozedUntil = "2099-07-25T09:00:00.000Z";
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("snooze-wake-project"),
          title: "Snoozed long-running thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/snooze-wake",
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`snooze:${threadId}`),
          threadId,
          snoozedUntil,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`wake:${threadId}`),
          threadId,
          messageId: MessageId.make(`wake:${threadId}`),
          text: "Continue",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: kind === "user" ? "user" : "agent",
          creationSource: kind === "user" ? "web" : "provider",
          ...(kind === "notification"
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : {}),
        });
        const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
        if (kind === "user") {
          assert.isNull(thread.snoozedUntil);
        } else {
          assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
        }
      }),
  );
});

const SCRATCH_ROOT = "/tmp/runtime-layer-promotion-scratch";
const SCRATCH_PROJECT_ID = ProjectId.make("runtime-layer-promotion-scratch");
const layerScratchPromotionTest = ScratchThreadPromotion.layer.pipe(
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      scratchRoot: Effect.succeedSome(SCRATCH_ROOT),
      isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH_PROJECT_ID),
      namedProjectsRoot: "/projects",
    }),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(layerProjectDeletionTest),
);

it.layer(layerScratchPromotionTest)("turning a No project thread into a project", (it) => {
  const setup = Effect.fn(function* (name: string) {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const folder = `${SCRATCH_ROOT}/2026-01-01-${name}`;
    if (Option.isNone(yield* projects.getById(SCRATCH_PROJECT_ID))) {
      yield* projects.create({
        commandId: CommandId.make("promotion-scratch-create"),
        projectId: SCRATCH_PROJECT_ID,
        title: "No project",
        workspaceRoot: SCRATCH_ROOT,
      });
    }
    const createThread = (suffix: string, worktreePath: string) =>
      orchestrator
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`promotion-${name}-${suffix}-create`),
          threadId: ThreadId.make(`promotion-${name}-${suffix}`),
          projectId: SCRATCH_PROJECT_ID,
          title: `${name} ${suffix}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath,
        })
        .pipe(Effect.as(ThreadId.make(`promotion-${name}-${suffix}`)));
    return { folder, createThread };
  });
  const shellOf = (threadId: ThreadId) =>
    Orchestrator.OrchestratorV2.pipe(
      Effect.flatMap((orchestrator) => orchestrator.getThreadShell(threadId)),
    );

  it.effect("moves every thread in the folder and its bound tasks into one project", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const { folder, createThread } = yield* setup("moves");
      const threadId = yield* createThread("main", folder);
      const siblingId = yield* createThread("sibling", folder);
      const otherId = yield* createThread("other", `${SCRATCH_ROOT}/2026-01-01-elsewhere`);
      const { task } = yield* tasks.upsert(
        {
          id: ScheduledTaskId.make("promotion-moves-bound"),
          title: "Bound",
          prompt: "Check in",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: SCRATCH_PROJECT_ID,
          threadId: siblingId,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        },
        { id: "alice", name: "Alice" },
      );
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("promotion-moves-sibling-archive"),
        threadId: siblingId,
      });

      const { projectId } = yield* promotion.promote({ threadId });

      const project = yield* projects.getById(projectId);
      assert.equal(Option.getOrUndefined(project)?.workspaceRoot, folder);
      assert.equal(Option.getOrUndefined(project)?.title, "moves main");
      for (const id of [threadId, siblingId]) {
        const shell = yield* shellOf(id);
        assert.equal(shell?.projectId, projectId);
        assert.isNull(shell?.worktreePath);
      }
      assert.equal((yield* shellOf(otherId))?.projectId, SCRATCH_PROJECT_ID);
      const saved = (yield* tasks.list({ id: "alice", name: "Alice" })).tasks.find(
        (candidate) => candidate.id === task.id,
      );
      assert.equal(saved?.projectId, projectId);
      assert.deepEqual(yield* promotion.promote({ threadId }), { projectId });
    }),
  );

  it.effect("changes nothing while a thread in the folder is busy", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { folder, createThread } = yield* setup("busy");
      const threadId = yield* createThread("idle", folder);
      const busyId = yield* createThread("delegate", folder);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("promotion-busy-message"),
        threadId: busyId,
        messageId: MessageId.make("promotion-busy-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const error = yield* promotion.promote({ threadId }).pipe(Effect.flip);

      assert.equal(error.message, '"busy delegate" is still working. Finish or stop it first.');
      assert.isTrue(Option.isNone(yield* projects.getByWorkspaceRoot(folder)));
      assert.equal((yield* shellOf(threadId))?.projectId, SCRATCH_PROJECT_ID);
    }),
  );

  it.effect("finishes a partial move from either thread", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { folder, createThread } = yield* setup("partial");
      const movedId = yield* createThread("moved", folder);
      const leftId = yield* createThread("left", folder);
      const earlier = yield* projects.create({
        commandId: CommandId.make("promotion-partial-project"),
        projectId: ProjectId.make("promotion-partial-project"),
        title: "Earlier",
        workspaceRoot: folder,
      });
      yield* orchestrator.dispatch({
        type: "thread.project.adopt-folder",
        commandId: CommandId.make("promotion-partial-adopt"),
        threadId: movedId,
        projectId: earlier.id,
      });

      assert.deepEqual(yield* promotion.promote({ threadId: movedId }), { projectId: earlier.id });
      assert.equal((yield* shellOf(leftId))?.projectId, earlier.id);
    }),
  );

  it.effect("refuses a thread outside No project", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("promotion-regular-project");
      const threadId = ThreadId.make("promotion-regular-thread");
      yield* projects.create({
        commandId: CommandId.make("promotion-regular-project"),
        projectId,
        title: "Regular",
        workspaceRoot: "/tmp/runtime-layer-promotion-regular",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("promotion-regular-thread-create"),
        threadId,
        projectId,
        title: "Regular",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const error = yield* promotion.promote({ threadId }).pipe(Effect.flip);

      assert.equal(
        error.message,
        "Only a No project thread with its own folder can become a project.",
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("snooze projection", (it) => {
  it.effect("carries snooze, settle and title state through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-snoozed-project");
      const threadId = ThreadId.make("runtime-layer-snoozed-thread");
      const snoozedUntil = "2099-07-25T09:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-snoozed-project-create"),
        projectId,
        title: "Snoozed shell projection",
        workspaceRoot: "/tmp/runtime-layer-snoozed-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-thread-create"),
        threadId,
        projectId,
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze"),
        threadId,
        snoozedUntil,
      });

      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstSnoozedAt = firstProjection.thread.snoozedAt;
      assert.isNotNull(firstSnoozedAt);

      // Restamp snoozedAt for identical wake times so previously waking failures do not keep the thread awake.
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-again"),
        threadId,
        snoozedUntil,
      });

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
      assert.equal(
        DateTime.toEpochMillis(thread.snoozedAt!),
        DateTime.toEpochMillis(firstSnoozedAt!) + 1_000,
      );
      assert.deepEqual(thread.updatedAt, thread.snoozedAt);

      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-wake"),
        threadId,
        reason: "user",
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(ProjectionStore.layer),
      );
      const [candidate] = yield* projections.getSettlementCandidates(threadId);
      assert.deepEqual(candidate?.lastSnoozeWakeAt, yield* DateTime.now);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-snoozed-thread-settle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-after-wake"),
        threadId,
        snoozedUntil,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-snoozed-message"),
        text: "Wake this thread.",
        titleSeed: "Woken thread",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const awakened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awakened.thread.snoozedUntil);
      assert.isNull(awakened.thread.snoozedAt);
      assert.isNull(awakened.thread.settledOverride);
      assert.isNull(awakened.thread.settledAt);
      assert.equal(awakened.thread.title, "Woken thread");
      assert.equal(
        awakened.thread.titleRegeneration?.requestId,
        CommandId.make("runtime-layer-snoozed-message"),
      );
    }),
  );

  it.effect("moves a thread into a project rooted at its own folder", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const scratchProjectId = ProjectId.make("runtime-layer-adopt-scratch");
      const folderProjectId = ProjectId.make("runtime-layer-adopt-folder");
      const otherProjectId = ProjectId.make("runtime-layer-adopt-other");
      const folder = "/tmp/runtime-layer-adopt-scratch/2026-01-01-notes-a1b2c3d4";
      const createProject = (projectId: ProjectId, workspaceRoot: string) =>
        projects.create({
          commandId: CommandId.make(`${projectId}-create`),
          projectId,
          title: projectId,
          workspaceRoot,
        });
      const createThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}-create`),
          threadId,
          projectId: scratchProjectId,
          title: "Scratch work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: folder,
        });
      const adopt = (threadId: ThreadId, projectId: ProjectId, suffix: string) =>
        orchestrator.dispatch({
          type: "thread.project.adopt-folder",
          commandId: CommandId.make(`${threadId}-adopt-${suffix}`),
          threadId,
          projectId,
        });
      yield* createProject(scratchProjectId, "/tmp/runtime-layer-adopt-scratch");
      yield* createProject(folderProjectId, folder);
      yield* createProject(otherProjectId, "/tmp/runtime-layer-adopt-other");
      const idleThreadId = ThreadId.make("runtime-layer-adopt-idle");
      const busyThreadId = ThreadId.make("runtime-layer-adopt-busy");
      yield* createThread(idleThreadId);
      yield* createThread(busyThreadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-adopt-busy-message"),
        threadId: busyThreadId,
        messageId: MessageId.make("runtime-layer-adopt-busy-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const otherFolder = yield* adopt(idleThreadId, otherProjectId, "other").pipe(Effect.flip);
      assert.equal(
        otherFolder.cause,
        `Thread ${idleThreadId} does not work in /tmp/runtime-layer-adopt-other.`,
      );
      const missing = yield* adopt(idleThreadId, ProjectId.make("missing"), "missing").pipe(
        Effect.flip,
      );
      assert.equal(missing.cause, `Thread ${idleThreadId} cannot move to missing project missing.`);
      const busy = yield* adopt(busyThreadId, folderProjectId, "busy").pipe(Effect.flip);
      assert.equal(
        busy.cause,
        `Thread ${busyThreadId} still has work in progress. Finish or stop it first.`,
      );

      yield* adopt(idleThreadId, folderProjectId, "folder");
      const shell = yield* orchestrator.getShellSnapshot();
      const moved = shell.threads.find((thread) => thread.id === idleThreadId);
      assert.equal(moved?.projectId, folderProjectId);
      assert.isNull(moved?.worktreePath);
      const stayed = shell.threads.find((thread) => thread.id === busyThreadId);
      assert.equal(stayed?.projectId, scratchProjectId);
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("visited projection", (it) => {
  it.effect("carries the visited watermark through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-visited-project");
      const threadId = ThreadId.make("runtime-layer-visited-thread");
      const visitedAt = "2026-07-24T01:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-visited-project-create"),
        projectId,
        title: "Visited shell projection",
        workspaceRoot: "/tmp/runtime-layer-visited-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-visited-thread-create"),
        threadId,
        projectId,
        title: "Visited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const created = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(created.thread.lastVisitedAt);
      const createdUpdatedAt = created.thread.updatedAt;
      const beforeVisit = yield* orchestrator.getThreadEventSequence(threadId);
      const liveVisit = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit"),
        threadId,
        visitedAt,
      });
      const visited = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(visited.thread.lastVisitedAt);
      assert.equal(DateTime.formatIso(visited.thread.lastVisitedAt!), visitedAt);
      assert.deepEqual(visited.thread.updatedAt, createdUpdatedAt);
      const sql = yield* SqlClient.SqlClient;
      const visitPayloadKeys = (commandId: string) =>
        sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_events WHERE command_id = ${commandId}
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => Object.keys(JSON.parse(row.payload_json)).toSorted()),
          ),
        );
      const liveEvent = Option.getOrThrow(yield* Fiber.join(liveVisit));
      assert.equal(liveEvent.type, "thread.visited");
      if (liveEvent.type !== "thread.visited") throw new Error("Expected a full visit event");
      assert.deepEqual(liveEvent.payload, visited.thread);
      const replay = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence: beforeVisit })
        .pipe(Stream.runHead);
      const replayEvent = Option.getOrThrow(replay).event;
      assert.equal(replayEvent.type, "thread.visited");
      assert.deepEqual(replayEvent, liveEvent);
      for (const keys of yield* visitPayloadKeys("runtime-layer-visited-thread-visit")) {
        assert.includeMembers(keys, ["lastVisitedAt", "id", "projectId", "title"]);
      }

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit-stale"),
        threadId,
        visitedAt: "2026-07-24T00:30:00.000Z",
      });
      const afterStaleVisit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(afterStaleVisit.thread.lastVisitedAt!), visitedAt);
      // A stale visit with no open changes nothing, so it stores nothing.
      assert.deepEqual(yield* visitPayloadKeys("runtime-layer-visited-thread-visit-stale"), []);

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread!.lastVisitedAt!), visitedAt);
      assert.deepEqual(thread!.updatedAt, createdUpdatedAt);

      const markUnread = yield* orchestrator
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("runtime-layer-visited-thread-mark-unread"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(markUnread, Orchestrator.OrchestratorDispatchError);

      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        'item:visited:unreadable-history', ${threadId}, 1, 'dynamic_tool', 'completed',
        ${visitedAt}, '{broken'
      )`;
      const nextVisitedAt = "2026-07-24T02:00:00.000Z";
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-without-history"),
        threadId,
        visitedAt: nextVisitedAt,
      });
      const [watermark] = yield* sql<{ readonly visited_at: string; readonly updated_at: string }>`
        SELECT json_extract(payload_json, '$.lastVisitedAt') AS visited_at, updated_at
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      assert.equal(watermark!.visited_at, nextVisitedAt);
      assert.equal(watermark!.updated_at, DateTime.formatIso(createdUpdatedAt));
      const invalidVisit = yield* orchestrator
        .dispatch({
          type: "thread.visit",
          commandId: CommandId.make("runtime-layer-visited-invalid-timestamp"),
          threadId,
          visitedAt: "invalid-timestamp",
        })
        .pipe(Effect.flip);
      assert.instanceOf(invalidVisit, Orchestrator.OrchestratorDispatchError);
    }),
  );

  it.effect("marks unread before the user's last turn when an automatic compaction followed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-mark-unread-compacted");
      const turnCompletedAt = DateTime.makeUnsafe("2026-07-24T10:00:00.000Z");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Compacted thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const runs = [
        { text: "Continue", at: turnCompletedAt },
        {
          text: "/compact",
          idleCompaction: "beforeCacheExpires" as const,
          at: DateTime.makeUnsafe("2026-07-24T11:00:00.000Z"),
        },
      ];
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make(`${threadId}:seed`),
        events: runs.flatMap(({ at, ...message }, index) => {
          const runId = RunId.make(`${threadId}:run-${index}`);
          const messageId = MessageId.make(`${threadId}:message-${index}`);
          return [
            {
              id: EventId.make(`${messageId}:event`),
              type: "message.updated" as const,
              threadId,
              occurredAt: at,
              payload: {
                ...message,
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "user" as const,
                attachments: [],
                streaming: false,
                createdBy: "user" as const,
                creationSource: "web" as const,
                createdAt: at,
                updatedAt: at,
              },
            },
            {
              id: EventId.make(`${runId}:event`),
              type: "run.created" as const,
              threadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: at,
              payload: {
                id: runId,
                threadId,
                ordinal: index + 1,
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed" as const,
                queuePosition: null,
                requestedAt: at,
                startedAt: at,
                completedAt: at,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ];
        }),
      });

      yield* orchestrator.dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make(`${threadId}:mark-unread`),
        threadId,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.thread.lastVisitedAt,
        DateTime.subtract(turnCompletedAt, { milliseconds: 1 }),
      );
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(shell!.latestRunCompletedAt, turnCompletedAt);
      assert.deepEqual(shell!.lastVisitedAt, projection.thread.lastVisitedAt);

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make(`${threadId}:visit`),
        threadId,
        visitedAt: DateTime.formatIso(turnCompletedAt),
      });
      const revisited = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(revisited!.lastVisitedAt, turnCompletedAt);
    }),
  );
});

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("thread opens", (it) => {
  it.effect(
    "counts opens on the server clock, merges quick reopens, and keeps picked queries",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-layer-opened-thread");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-layer-opened-thread-create"),
          threadId,
          projectId: ProjectId.make("runtime-layer-opened-project"),
          title: "Opened thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        let visits = 0;
        const visit = (input: { readonly opened?: boolean; readonly searchQuery?: string }) =>
          orchestrator.dispatch({
            type: "thread.visit",
            commandId: CommandId.make(`runtime-layer-opened-visit-${++visits}`),
            threadId,
            // A client clock far in the past must not move the open time.
            visitedAt: "2000-01-01T00:00:00.000Z",
            ...input,
          });
        const opens = Effect.map(
          orchestrator.getShellSnapshot(),
          (shell) => shell.threads.find((thread) => thread.id === threadId)?.opens ?? null,
        );
        const start = DateTime.toEpochMillis(yield* DateTime.now);

        yield* visit({ opened: true, searchQuery: "  Upl " });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [{ query: "upl", at: start }],
        });

        yield* TestClock.adjust("1 minute");
        yield* visit({ opened: true, searchQuery: "Uploadthing docs" });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [
            { query: "uploadthing docs", at: start + 60_000 },
            { query: "upl", at: start },
          ],
        });

        yield* TestClock.adjust("14 days");
        yield* visit({});
        yield* visit({ opened: true });
        const later = yield* opens;
        assert.closeTo(later!.score, 1 + 2 ** (-(14 * 24 * 60 + 1) / (14 * 24 * 60)), 1e-9);
        assert.equal(later!.openedAt, DateTime.toEpochMillis(yield* DateTime.now));
        // Opening without a query keeps each pick and its time.
        assert.deepEqual(later!.picks, [
          { query: "uploadthing docs", at: start + 60_000 },
          { query: "upl", at: start },
        ]);
      }),
  );
});

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("PR link events", (it) => {
  it.effect("persists only the changed PR link and replays it without losing other links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("compact-pr-sync");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("compact-pr-create"),
        threadId,
        projectId: ProjectId.make("compact-pr-project"),
        title: "PR sync",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      const repositoryWebUrl = "https://github.com/pingdotgg/t3code/pull/2";
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`compact-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
          ...(number === 2 ? { repositoryWebUrl } : {}),
        });
      }
      const watchedLink = {
        url: "https://github.com/pingdotgg/t3code/pull/3",
        repositoryWebUrl: "https://github.com/pingdotgg/t3code/pull/3",
        source: "manual" as const,
      };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-new"),
        threadId,
        ...key,
        number: 3,
        watching: true,
        link: watchedLink,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-existing"),
        threadId,
        ...key,
        number: 2,
        watching: true,
      });
      const before = yield* orchestrator.getThreadShell(threadId);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("compact-pr-sync"),
        threadId,
        ...key,
        number: 2,
        snapshot: {
          state: "open",
          title: "Updated PR",
          headBranch: "feature/pr",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-13T12:00:00.000Z",
        },
        stack: {
          kind: "native",
          id: "updated",
          number: 2,
          url: "https://github.com/pingdotgg/t3code/pull/2",
          base: "main",
          layers: [],
        },
      });
      const rows = yield* sql<{ event_type: string; payload_json: string }>`
        SELECT event_type, payload_json FROM orchestration_events
        WHERE command_id = ${"compact-pr-sync"}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_type, "thread.pull-request-link-updated");
      const payload = JSON.parse(rows[0]!.payload_json);
      assert.equal(payload.number, 2);
      assert.isUndefined(payload.pullRequests);
      const after = yield* orchestrator.getThreadShell(threadId);
      assert.equal(after?.pullRequests?.length, 3);
      assert.deepEqual(after?.pullRequests?.[0], before?.pullRequests?.[0]);
      assert.deepEqual(after?.pullRequests?.[2], before?.pullRequests?.[2]);
      assert.equal(after?.pullRequests?.[1]?.stack?.id, "updated");
      assert.propertyVal(after?.pullRequests?.[1], "repositoryWebUrl", repositoryWebUrl);
      assert.deepInclude(after?.pullRequests?.[2], watchedLink);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        after?.pullRequests,
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("shared application data plane", (it) => {
  it.effect("orders retained project transactions and V2 thread transactions in one source", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("runtime-layer-shared-project");
      const threadId = ThreadId.make("runtime-layer-shared-thread");
      const projectInput = {
        commandId: CommandId.make("runtime-layer-shared-project-create"),
        projectId,
        title: "Shared application source",
        workspaceRoot: "/tmp/runtime-layer-shared-project",
      };

      const created = yield* projects.create(projectInput);
      const retried = yield* projects.create(projectInput);
      assert.deepEqual(retried, created);

      const delivered = yield* Queue.unbounded<ApplicationStoredEvent>();
      yield* applicationEvents.streamApplicationEvents().pipe(
        Stream.take(2),
        Stream.runForEach((event) => Queue.offer(delivered, event)),
        Effect.forkScoped,
      );

      const projectEvent = yield* Queue.take(delivered);
      assert.isTrue("aggregateKind" in projectEvent && projectEvent.aggregateId === projectId);

      const threadResult = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-shared-thread-create"),
        threadId,
        projectId,
        title: "Shared thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const threadEvent = yield* Queue.take(delivered);

      assert.equal(threadEvent.sequence, threadResult.sequence);
      assert.isAbove(threadEvent.sequence, projectEvent.sequence);
      assert.isTrue("aggregateKind" in projectEvent);
      assert.isTrue("event" in threadEvent);
      assert.equal((yield* projects.getById(projectId))._tag, "Some");

      const retainedReceipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
      }>`
        SELECT aggregate_kind, aggregate_id
        FROM orchestration_command_receipts
        ORDER BY result_sequence ASC
      `;
      assert.deepEqual(retainedReceipts, [
        { aggregate_kind: "project", aggregate_id: projectId },
        { aggregate_kind: "thread", aggregate_id: threadId },
      ]);

      const retiredWrites = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) +
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS count
      `;
      assert.equal(retiredWrites[0]?.count, 0);
    }),
  );
});

it.layer(layerTest)("usage-limit recovery", (it) => {
  it.effect.each(["interrupted", "usage_limit"] as const)(
    "manually resumes an %s run ahead of its queued message only once",
    (reason) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const events = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`manual-resume:${reason}`);
        const projectId = ProjectId.make(`manual-resume:project:${reason}`);
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        yield* seedProject({
          projectId,
          title: "Resume project",
          workspaceRoot: process.cwd(),
          defaultModelSelection: modelSelection,
          createdAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`manual-resume:create:${reason}`),
          threadId,
          projectId,
          title: "Interrupted thread",
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
          commandId: CommandId.make(`manual-resume:start:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:start:${reason}`),
          text: "Start work.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`manual-resume:queue:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:queue:${reason}`),
          text: "Follow up.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const [source, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
          OrchestrationV2Run,
          OrchestrationV2Run,
        ];
        // Hold the queue like user Stop so the terminal worker cannot start it before explicit resume.
        yield* events.write({
          events: [
            {
              id: EventId.make(`manual-resume:hold:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...queued, queueHeld: true },
            },
            {
              id: EventId.make(`manual-resume:stop:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...source,
                status: reason === "interrupted" ? "interrupted" : "failed",
                completedAt: now,
              },
            },
          ],
        });
        let scheduledResume: ReturnType<typeof limitRecoveryCommand> = null;
        if (reason === "usage_limit") {
          const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
          yield* events.write({
            events: [
              {
                id: EventId.make(`manual-resume:error:${reason}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`manual-resume:error:${reason}`),
                  type: "error",
                  threadId,
                  runId: source.id,
                  nodeId: source.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: "Usage limit reached",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  failure: {
                    class: "usage_limit",
                    message: "Plan limit reached.",
                    code: "usageLimitExceeded",
                    retryable: null,
                    resetAt,
                  },
                },
              },
            ],
          });
          const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          yield* orchestrator.dispatch(
            limitRecoveryCommand(shell, true, DateTime.toEpochMillis(now))!,
          );
          const armed = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          scheduledResume = limitRecoveryCommand(armed, true, Date.parse(resetAt));
          assert.isNotNull(scheduledResume);
        }
        const resume = (suffix: string) => ({
          type: "message.dispatch" as const,
          commandId: CommandId.make(`manual-resume:${suffix}:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:${suffix}:${reason}`),
          manualContinuationOfRunId: source.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" as const },
          createdBy: "user" as const,
          creationSource: "web" as const,
        });
        yield* orchestrator.dispatch(resume("first"));
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(after.runs, 3);
        assert.equal(after.runs[1]?.status, "queued");
        assert.equal(after.runs[2]?.status, "starting");
        assert.equal(after.runs[2]?.manualContinuationOfRunId, source.id);
        const resumeMessage = after.messages.find(
          (message) => message.id === resume("first").messageId,
        );
        assert.equal(resumeMessage?.text, "");
        assert.equal(resumeMessage?.notification?.summary, "Resumed thread");
        assert.isFalse(
          after.turnItems.some(
            (item) => item.runId === after.runs[2]?.id && item.type === "user_message",
          ),
        );
        assert.equal(
          (yield* orchestrator.dispatch(resume("second")).pipe(Effect.exit))._tag,
          "Failure",
        );
        if (scheduledResume !== null) {
          yield* TestClock.adjust("1 minute");
          yield* orchestrator.dispatch(scheduledResume);
        }
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 3);
      }),
  );

  it.effect.each([
    "resume",
    "resume-started",
    "resume-untagged",
    "queued-resume",
    "rearm",
    "snooze-race",
    "archive",
    "replacement",
    "manual-snooze",
    "invalid-snooze",
    "settled",
    "cancel-resume-keep-snooze",
    "independent-patches",
    "expired-snooze",
    "wake",
    "stop",
    "stop-before-arm",
    "stop-before-arm-mismatched-recovery",
  ] as const)("guards a scheduled usage-limit continuation against %s", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`recovery:${scenario}`);
      const projectId = ProjectId.make(`recovery:project:${scenario}`);
      yield* seedProject({
        projectId,
        title: "Recovery project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`recovery:create:${scenario}`),
        threadId,
        projectId,
        title: "Limited thread",
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
        commandId: CommandId.make(`recovery:message:${scenario}`),
        threadId,
        messageId: MessageId.make(`recovery:message:${scenario}`),
        text: "Work on this.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      if (scenario === "queued-resume") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:queued:${scenario}`),
          threadId,
          messageId: MessageId.make(`recovery:queued:${scenario}`),
          text: "Run after recovery.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const now = yield* DateTime.now;
      const resetAt =
        scenario === "invalid-snooze"
          ? "not-a-date"
          : DateTime.formatIso(DateTime.add(now, { minutes: 1 })).replace(
              "Z",
              scenario === "wake" ? "+00:00" : "Z",
            );
      yield* events.write({
        commandId: CommandId.make(`recovery:failure:${scenario}`),
        events: [
          {
            id: EventId.make(`recovery:run:${scenario}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`recovery:error:${scenario}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`recovery:error:${scenario}`),
              type: "error",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt,
              },
            },
          },
        ],
      });
      if (scenario === "queued-resume") {
        const queuedRun = projection.runs[1]!;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:held:queued-resume"),
              type: "run.updated",
              threadId,
              runId: queuedRun.id,
              occurredAt: now,
              payload: { ...queuedRun, queueHeld: true },
            },
          ],
        });
        const resumeHeldQueue = yield* orchestrator
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make("recovery:resume-held:queued-resume"),
            threadId,
          })
          .pipe(Effect.exit);
        assert.equal(resumeHeldQueue._tag, "Failure");
        assert.isTrue((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.queueHeld);
      }
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.isNull(limitRecoveryCommand(shell, false, DateTime.toEpochMillis(now)));
      if (scenario === "invalid-snooze") {
        const result = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:invalid-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.limitRecovery ?? null);
        assert.isNull(current.thread.snoozedUntil);
        return;
      }
      if (scenario === "settled") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:arm-before-settle:settled"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true, snooze: true },
        });
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("recovery:settle:settled"),
          threadId,
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:arm:settled"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, autoResume: true },
          })
          .pipe(Effect.flip);
        assert(error._tag === "OrchestratorDispatchError");
        assert.equal(error.cause, "The thread is settled. Un-settle it to resume at the reset.");
        assert.deepInclude(
          (yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery,
          {
            runId: run.id,
            autoResume: false,
            snooze: false,
          },
        );
        return;
      }
      const snooze = scenario === "wake" || scenario === "cancel-resume-keep-snooze";
      const autoResume = scenario !== "wake";
      const arm = limitRecoveryCommand(shell, autoResume, DateTime.toEpochMillis(now), snooze);
      assert(arm?.type === "thread.metadata.update" && arm.limitRecovery != null);
      const automaticArm = {
        commandId: arm.commandId,
        threadId,
        limitRecovery: arm.limitRecovery,
      };
      const stopBeforeArm =
        scenario === "stop-before-arm" || scenario === "stop-before-arm-mismatched-recovery";
      if (stopBeforeArm) {
        if (scenario === "stop-before-arm-mismatched-recovery") {
          const current = yield* orchestrator.getThreadProjection(threadId);
          yield* events.write({
            events: [
              {
                id: EventId.make(`recovery:older-window:${scenario}`),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...current.thread,
                  limitRecovery: {
                    runId: run.id,
                    resetAt: DateTime.formatIso(DateTime.add(now, { minutes: 2 })),
                    autoResume: true,
                    snooze: false,
                  },
                },
              },
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery:stop:${scenario}`),
          threadId,
        });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.isUndefined(
          (yield* projections.getLimitRecoveryCandidates({
            now,
            autoResume: true,
            snooze: false,
          })).find((row) => row.id === threadId),
        );
        const stoppedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isNull(limitRecoveryCommand(stoppedShell, true, DateTime.toEpochMillis(now)));
        yield* orchestrator.autoArmLimitRecovery(automaticArm);
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery, {
          runId: run.id,
          resetAt,
          autoResume: false,
          snooze: false,
          requestId: CommandId.make(`recovery:stop:${scenario}`),
        });
      }
      const armCommand = stopBeforeArm
        ? { ...arm, commandId: CommandId.make(`recovery:explicit-rearm:${scenario}`) }
        : arm;
      if (stopBeforeArm) yield* orchestrator.dispatch(armCommand);
      else yield* orchestrator.autoArmLimitRecovery(automaticArm);
      let armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.deepEqual(armedShell.limitRecovery, {
        runId: run.id,
        resetAt,
        autoResume,
        snooze,
        requestId: armCommand.commandId,
      });
      if (snooze)
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
      if (scenario === "cancel-resume-keep-snooze") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:independent-choice:${scenario}`),
          threadId,
          limitRecovery: {
            runId: run.id,
            resetAt,
            autoResume: false,
            snooze: true,
          },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(armedShell.snoozedAt!),
          DateTime.toEpochMillis(armedShell.updatedAt),
        );
        assert.isFalse(armedShell.limitRecovery!.autoResume);
      }
      if (scenario === "independent-patches") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-snooze"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, snooze: true },
        });
        let current = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-cancel-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
        current = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        assert.equal(DateTime.toEpochMillis(current.thread.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(current.thread.snoozedAt!),
          DateTime.toEpochMillis(current.thread.updatedAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isTrue(armedShell.limitRecovery!.autoResume);
        assert.isTrue(armedShell.limitRecovery!.snooze);
      }
      if (scenario === "manual-snooze") {
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`recovery:manual-snooze:${scenario}`),
          threadId,
          snoozedUntil: resetAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:manual-cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.equal(
          DateTime.toEpochMillis(
            (yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil!,
          ),
          Date.parse(resetAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`recovery:manual-wake:${scenario}`),
          threadId,
          reason: "user",
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      if (scenario === "wake") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:wake:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      assert.isNull(limitRecoveryCommand(armedShell, true, DateTime.toEpochMillis(now)));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:early:${scenario}`),
        messageId: MessageId.make(`recovery:early:${scenario}`),
        threadId,
        usageLimitContinuationOfRunId: run.id,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        scenario === "queued-resume" ? 2 : 1,
      );
      yield* TestClock.adjust("1 minute");
      const resume = limitRecoveryCommand(
        armedShell,
        true,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      if (autoResume && scenario !== "cancel-resume-keep-snooze") assert.isNotNull(resume);
      else assert.isNull(resume);
      if (scenario === "snooze-race") {
        const wakeAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("recovery:raced-snooze"),
          threadId,
          snoozedUntil: wakeAt,
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* TestClock.adjust("1 minute");
        const current = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          current,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "expired-snooze") {
        const staleSnooze = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:expired-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(staleSnooze._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.snoozedUntil);
        assert.isFalse(current.thread.limitRecovery!.snooze);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
      }

      if (scenario === "rearm")
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
      if (scenario === "archive")
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`recovery:archive:${scenario}`),
          threadId,
        });
      if (scenario === "stop") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery:stop:${scenario}`),
          threadId,
        });
        const stoppedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.deepInclude(stoppedShell.limitRecovery, { runId: run.id, autoResume: false });
      }
      if (scenario === "replacement") {
        const current = yield* orchestrator.getThreadProjection(threadId);
        const error = current.turnItems.find((item) => item.type === "error")!;
        if (error.type !== "error") throw new Error("Expected provider error");
        yield* events.write({
          commandId: CommandId.make(`recovery:replacement:${scenario}`),
          events: [
            {
              id: EventId.make(`recovery:replacement:${scenario}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...error,
                failure: {
                  ...error.failure,
                  class: "provider_error",
                  message: "A replacement failure.",
                },
              },
            },
          ],
        });
      }
      if (scenario === "rearm") {
        yield* orchestrator.dispatch(resume!);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:rearm:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        const rearmedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          rearmedShell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      if (resume !== null) {
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      if (
        scenario === "resume" ||
        scenario === "resume-started" ||
        scenario === "resume-untagged"
      ) {
        assert.deepInclude(after.messages.at(-1), {
          text: "Continue where you left off.",
          createdBy: "agent",
          creationSource: "server",
        });
        const continuation = after.runs.at(-1)!;
        assert.equal(continuation.status, "starting");
        if (scenario === "resume-started") {
          const startedAt = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make("recovery:continuation-started:resume-started"),
                type: "run.updated",
                threadId,
                runId: continuation.id,
                occurredAt: startedAt,
                payload: { ...continuation, status: "running", startedAt },
              },
              {
                id: EventId.make("recovery:continuation-accepted:resume-started"),
                type: "provider-turn.updated",
                threadId,
                runId: continuation.id,
                occurredAt: startedAt,
                payload: {
                  id: ProviderTurnId.make("recovery:continuation-turn:resume-started"),
                  providerThreadId: continuation.providerThreadId!,
                  nodeId: continuation.rootNodeId!,
                  runAttemptId: continuation.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt,
                  completedAt: null,
                },
              },
            ],
          });
        }
        if (scenario === "resume-untagged") {
          // A server older than the run tag stored the resume run without it.
          const { usageLimitContinuationOfRunId: _, ...untagged } = continuation;
          yield* events.write({
            events: [
              {
                id: EventId.make("recovery:continuation-untagged"),
                type: "run.updated",
                threadId,
                runId: continuation.id,
                occurredAt: yield* DateTime.now,
                payload: untagged,
              },
            ],
          });
        }
        yield* (yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService).reconcile(
          "startup",
        );
        const restartedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const retry = limitRecoveryCommand(
          restartedShell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        if (scenario === "resume-started") assert.isNull(retry);
        else assert(retry?.type === "message.dispatch");
        if (scenario === "resume") {
          assert.notEqual(retry!.commandId, resume!.commandId);
        } else {
          assert.equal(
            restartedShell.limitRecovery?.requestId,
            after.thread.limitRecovery?.requestId,
          );
        }
        if (retry !== null) {
          yield* orchestrator.dispatch(retry);
          yield* orchestrator.dispatch(retry);
        }
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        const visible = createOrchestrationV2TurnItemVisibility({
          runs: resumed.runs,
          attempts: resumed.attempts,
          items: resumed.turnItems,
        });
        assert.deepEqual(
          resumed.turnItems.flatMap((item) =>
            item.type === "user_message" && visible(item) ? [item.runId] : [],
          ),
          [run.id, resumed.runs.at(-1)!.id],
        );
        assert.deepEqual(
          resumed.turnItems.flatMap((item) =>
            item.type === "system_notice" && item.title === "Server restarted" ? [item.runId] : [],
          ),
          scenario === "resume" ? [] : [continuation.id],
        );
        assert.deepEqual(
          resumed.runs.map((row) => row.status),
          scenario === "resume" ? ["failed", "cancelled", "starting"] : ["failed", "cancelled"],
        );
      }
      assert.lengthOf(
        after.runs,
        before.runs.length +
          (scenario === "resume" ||
          scenario === "resume-started" ||
          scenario === "resume-untagged" ||
          stopBeforeArm ||
          scenario === "queued-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      assert.lengthOf(
        after.messages,
        before.messages.length +
          (scenario === "resume" ||
          scenario === "resume-started" ||
          scenario === "resume-untagged" ||
          stopBeforeArm ||
          scenario === "queued-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      if (scenario === "stop") {
        assert.deepInclude(after.thread.limitRecovery, { runId: run.id, autoResume: false });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sweep = { now: yield* DateTime.now, autoResume: true, snooze: false };
        assert.isUndefined(
          (yield* projections.getLimitRecoveryCandidates(sweep)).find((row) => row.id === threadId),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:rearm-after-stop"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        const rearmed = (yield* projections.getLimitRecoveryCandidates(sweep)).find(
          (row) => row.id === threadId,
        )!;
        assert.isDefined(rearmed);
        const freshResume = limitRecoveryCommand(rearmed, true, DateTime.toEpochMillis(sweep.now));
        assert.isNotNull(freshResume);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "queued-resume") {
        const held = after.runs[1]!;
        assert.equal(held.status, "queued");
        assert.isTrue(held.queueHeld);
        const continuation = after.runs[2]!;
        const completedAt = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:continuation-completed:queued-resume"),
              type: "run.updated",
              threadId,
              runId: continuation.id,
              occurredAt: completedAt,
              payload: { ...continuation, status: "completed", completedAt },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("recovery:resume-held-after-limit:queued-resume"),
          threadId,
        });
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          resumed.runs.map((run) => run.id),
          [run.id, continuation.id, held.id],
        );
        assert.equal(resumed.runs[2]?.status, "starting");
        assert.isFalse(resumed.runs[2]?.queueHeld);
      }
    }),
  );
});

const queueResumeDisabledInstanceProjectId = ProjectId.make(
  "project:queue-resume-disabled-instance",
);

const layerQueueResumeDisabledInstanceTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [alternateInstanceId]: { driver: "codex", enabled: true },
      },
      projectSettingsOverrides: {
        [queueResumeDisabledInstanceProjectId]: {
          providerInstances: { [alternateInstanceId]: { enabled: false } },
        },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerQueueResumeDisabledInstanceTest)(
  "queue.resume on a project-disabled instance",
  (it) => {
    it.effect(
      "holds a queued run instead of starting it on an instance the project turned off",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const events = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make("queue-resume-disabled-instance-thread");
          const queuedModelSelection = {
            instanceId: alternateInstanceId,
            model: "gpt-5.5",
          } satisfies ModelSelection;

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId: queueResumeDisabledInstanceProjectId,
            title: "Queue resume disabled instance",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:active`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:active`),
            text: "Active",
            attachments: [],
            dispatchMode: { type: "defer_start" },
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:queued`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:queued`),
            text: "Queued",
            attachments: [],
            modelSelection: queuedModelSelection,
            dispatchMode: { type: "queue_after_active" },
          });

          const before = yield* orchestrator.getThreadProjection(threadId);
          const activeRun = before.runs.find((run) => run.status !== "queued")!;
          const queuedRun = before.runs.find((run) => run.status === "queued")!;
          const now = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make(`${threadId}:active-completed`),
                type: "run.updated",
                threadId,
                runId: activeRun.id,
                occurredAt: now,
                payload: { ...activeRun, status: "completed", completedAt: now },
              },
            ],
          });

          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });

          const resumed = yield* orchestrator.getThreadProjection(threadId);
          const resumedQueuedRun = resumed.runs.find((run) => run.id === queuedRun.id);
          assert.equal(
            resumedQueuedRun?.status,
            "queued",
            "a disabled instance must not start the queued run",
          );
          assert.isTrue(
            resumedQueuedRun?.queueHeld,
            "a refused resume re-holds the queue instead of leaving it looking resumable",
          );
        }),
    );
  },
);
