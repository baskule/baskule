import { formatThreadLink, hostedThreadLink } from "@t3tools/shared/threadLinks";
import { isLiveSubagentShell } from "@t3tools/contracts";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  NodeId,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpListScheduledTasksInput,
  type Project,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorThreadAboveModeLimitError } from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

describe("OrchestratorMcpService", () => {
  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const subagentReads = yield* Ref.make<ReadonlyArray<ProjectionRecordFilter | undefined>>([]);
      const appOwnedTask = (
        id: string,
        threadId: ThreadId,
        childId: ThreadId,
        settled?: "settled",
      ) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "opencode",
        model: "gpt-5.6-terra",
        status: settled === undefined ? "running" : "completed",
        result: settled === undefined ? null : "Done.",
        completionDelivery: { state: settled === undefined ? "pending" : "delivered" },
      });
      // Older tasks the parent and child dispatched and that have long settled.
      const settledThreadId = ThreadId.make("thread:mcp-cancel-grandchild-settled");
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-old",
                parentThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask(taskId, parentThreadId, childThreadId),
            ],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId, title: "Child" },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-done",
                childThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
          },
        ],
        [
          settledThreadId,
          {
            thread: { id: settledThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId, fields, filter) =>
            ((fields as ReadonlyArray<string>).includes("subagents")
              ? Ref.update(subagentReads, (reads) => [...reads, filter])
              : Effect.void
            ).pipe(Effect.as(projections.get(threadId)!)),
          listAppOwnedChildThreadIds: (threadId) =>
            Effect.succeed(
              projections
                .get(threadId)!
                .subagents.flatMap((task) =>
                  task.origin === "app_owned" && task.childThreadId !== null
                    ? [task.childThreadId]
                    : [],
                ),
            ),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest({
          projectSettingsFolded: false,
          providerInstances: {
            [ProviderInstanceId.make("opencode")]: {
              driver: ProviderDriverKind.make("opencode"),
              enabled: true,
            },
            [ProviderInstanceId.make("opencode_alt")]: {
              driver: ProviderDriverKind.make("opencode"),
              enabled: true,
            },
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("opencode"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        // No read decodes every task a thread has dispatched.
        for (const filter of yield* Ref.get(subagentReads)) {
          assert.isTrue(
            filter?.subagentIds !== undefined || filter?.omitSettledSubagents !== undefined,
          );
        }
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );

  it.effect("reports a task under the child that its user raises while it is being stopped", () =>
    Effect.gen(function* () {
      const outcome = yield* cancelOverRaisedGrandchild({ deleted: false, raisedDuringStop: true });
      assert.equal(outcome.code, "runtime_mode_escalation_denied");
      assert.isFalse(outcome.stoppedBelow);
    }),
  );

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("opencode_alt");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  describe("listed models", () => {
    const opencodeInstanceId = ProviderInstanceId.make("opencode");
    const model = (slug: string, extra: Partial<ServerProvider["models"][number]> = {}) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...extra,
    });
    const opencodeSlugs = Array.from(
      { length: 12 },
      (_, index) => `oc/m${String(index + 1).padStart(2, "0")}`,
    );
    const catalog: ReadonlyArray<ServerProvider> = [
      {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("opencode"),
        }),
        displayName: "Codex",
        models: [
          model("gpt-6", {
            name: "Sol",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning",
                  description: "How hard the model thinks.",
                  type: "select",
                  options: [
                    { id: "low", label: "Low", description: "Fast." },
                    { id: "high", label: "High", isDefault: true },
                  ],
                  promptInjectedValues: ["high"],
                },
                { id: "fastMode", label: "Fast", type: "boolean" },
                {
                  id: "agent",
                  label: "Agent",
                  type: "select",
                  options: [{ id: "build", label: "Build" }],
                  currentValue: "build",
                },
              ],
            },
          }),
          model("gpt-5", { name: "Code Legacy", isLegacy: true }),
          model("gpt-4", { isLegacy: true }),
          model("gpt-3", { name: "GPT-3", isLegacy: true }),
          model("my-alpha", { isCustom: true }),
        ],
      },
      {
        ...providerSnapshot({
          instanceId: opencodeInstanceId,
          driver: ProviderDriverKind.make("opencode"),
        }),
        models: [
          ...opencodeSlugs.map((slug) => model(slug, { isLegacy: slug === "oc/m03" })),
          model("oc-custom", { isCustom: true }),
        ],
      },
    ];

    const capabilitiesWith = (search?: string) =>
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.capabilities(scope, search === undefined ? {} : { search });
      }).pipe(
        Effect.provide(
          layerOrchestratorService.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  getThreadRecords: () =>
                    Effect.succeed(
                      parentProjection([], { instanceId: codexInstanceId, model: "gpt-3" }),
                    ),
                }),
                ServerSettings.layerTest({
                  projectSettingsFolded: false,
                  providerInstances: {
                    [ProviderInstanceId.make("opencode")]: {
                      driver: ProviderDriverKind.make("opencode"),
                      enabled: true,
                    },
                    [ProviderInstanceId.make("opencode_alt")]: {
                      driver: ProviderDriverKind.make("opencode"),
                      enabled: true,
                    },
                  },
                  favorites: [
                    { provider: codexInstanceId, model: "gpt-4" },
                    { provider: opencodeInstanceId, model: "oc/m10" },
                  ],
                  providerModelPreferences: {
                    [opencodeInstanceId]: { hiddenModels: ["oc/m02"], modelOrder: ["oc/m12"] },
                  },
                }),
                providerRegistryLayer(catalog),
                adapterRegistryLayer([codexInstanceId, opencodeInstanceId]),
                Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          ),
        ),
      );

    const listing = (capabilities: OrchestratorMcpCapabilitiesResult) =>
      capabilities.providers.map((provider) => ({
        id: provider.providerInstanceId,
        models: provider.models.map((entry) => entry.id),
        omitted: provider.omittedModels ?? 0,
      }));

    it.effect(
      "skips legacy models, lists the first 8 of large catalogs, and keeps pinned models",
      () =>
        Effect.gen(function* () {
          assert.deepEqual(listing(yield* capabilitiesWith()), [
            // gpt-4 is a favorite and gpt-3 is the caller's model; legacy gpt-5 is left out.
            { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
            {
              id: opencodeInstanceId,
              models: [
                "oc/m12",
                "oc/m01",
                "oc/m04",
                "oc/m05",
                "oc/m06",
                "oc/m07",
                "oc/m08",
                "oc/m09",
                "oc/m10",
                "oc-custom",
              ],
              omitted: 2,
            },
          ]);
        }),
    );

    it.effect("search matches every word and caps each provider's matches", () =>
      Effect.gen(function* () {
        assert.deepEqual(listing(yield* capabilitiesWith("GPT 5")), [
          { id: codexInstanceId, models: ["gpt-5"], omitted: 0 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        const opencode = listing(yield* capabilitiesWith("oc/m"))[1];
        assert.deepEqual(opencode, {
          id: opencodeInstanceId,
          models: ["oc/m12", "oc/m01", "oc/m03", "oc/m04", "oc/m05", "oc/m06", "oc/m07", "oc/m08"],
          omitted: 3,
        });
        // A word naming the provider matches all its models, so legacy ones stay out.
        assert.deepEqual(listing(yield* capabilitiesWith("Codex")), [
          { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        assert.deepEqual(listing(yield* capabilitiesWith(" ")), listing(yield* capabilitiesWith()));
        for (const search of ["code", "codex code", "  CODE  "]) {
          assert.deepEqual(listing(yield* capabilitiesWith(search))[0], {
            id: codexInstanceId,
            models: ["gpt-5"],
            omitted: 0,
          });
        }
        assert.deepEqual(
          listing(yield* capabilitiesWith("open"))[1],
          listing(yield* capabilitiesWith())[1],
        );
        assert.deepEqual(listing(yield* capabilitiesWith("codex gpt 5"))[0], {
          id: codexInstanceId,
          models: ["gpt-5"],
          omitted: 0,
        });
      }),
    );

    it.effect("describes models by id, distinct label, and option values", () =>
      Effect.gen(function* () {
        const codex = (yield* capabilitiesWith()).providers[0];
        assert.deepEqual(codex?.models.slice(0, 4), [
          {
            id: "gpt-6",
            label: "Sol",
            options: [
              { id: "effort", values: ["low", "high"], default: "high" },
              { id: "fastMode", values: [false, true] },
              { id: "agent", values: ["build"], default: "build" },
            ],
          },
          { id: "gpt-4" },
          { id: "gpt-3" },
          { id: "my-alpha" },
        ]);
      }),
    );
  });

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
      saved: ScheduledTask = tasks[0]!,
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolvePrimaryRemoteName: () => Effect.succeed("origin"),
            resolveDefaultBranchName: () => Effect.succeed("main"),
            resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest({
              projectSettingsFolded: false,
              providerInstances: {
                [ProviderInstanceId.make("opencode")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  enabled: true,
                },
                [ProviderInstanceId.make("opencode_alt")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  enabled: true,
                },
              },
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) =>
                Effect.succeedSome({
                  id,
                  workspaceRoot: "/repo/scheduled",
                  defaultModelSelection: saved.modelSelection,
                } as Project),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: saved })),
            }),
          ),
        ),
      );

    it.effect("lists a webhook task without its URL to a caller that may run it", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => [summary.webhookUrl, summary.webhookSignature]),
          [[undefined, "none"]],
        );
      }),
    );

    it.effect("lists only the named task within the requested project", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const first = task({});
        const second = task({ id: ScheduledTaskId.make("scheduled-task:second") });
        const elsewhere = task({
          id: ScheduledTaskId.make("scheduled-task:elsewhere"),
          projectId: ProjectId.make("project:elsewhere"),
        });
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service([first, second, elsewhere], null, upserted)),
        );
        const ids = (input: OrchestratorMcpListScheduledTasksInput) =>
          mcp
            .listScheduledTasks(supervisedClient, input)
            .pipe(Effect.map(({ tasks }) => tasks.map((summary) => summary.scheduledTaskId)));
        assert.deepEqual(yield* ids({ scheduledTaskId: second.id }), [second.id]);
        assert.deepEqual(yield* ids({ projectId, scheduledTaskId: elsewhere.id }), []);
      }),
    );

    it.effect("returns a webhook URL when creating a task, not when updating it", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const hook = task({});
        const timer = task({
          schedule: { type: "interval", everyMs: 3_600_000 },
          webhook: undefined,
        });
        const created = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.scheduleTask(supervisedClient, {
              projectId,
              prompt: hook.prompt,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([hook], null, upserted)),
        );
        assert.equal(created.webhookUrl, "https://t3.example/hooks/secret");
        const converted = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.updateScheduledTask(supervisedClient, {
              scheduledTaskId: timer.id,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([timer], null, upserted, hook)),
        );
        assert.equal(converted.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );
  });

  describe("the base branch of an unbound scheduled task", () => {
    const projectId = ProjectId.make("project:scheduled-base");
    const workspaceRoot = "/repo/scheduled-base";
    const existing: ScheduledTask = {
      id: ScheduledTaskId.make("scheduled-task:base"),
      title: "Nightly",
      prompt: "Check the build",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const client: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled-base"),
      requestNamespace: "client:scheduled-base",
      thread: undefined,
      client: {
        sessionId: "scheduled-base",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
      saved: Ref.Ref<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>,
      task: ScheduledTask = existing,
      inputs?: Ref.Ref<ReadonlyArray<ScheduledTaskUpsertInput>>,
      defaults: {
        readonly project: ScheduledTask["modelSelection"] | null;
        readonly environment?: ScheduledTask["modelSelection"];
      } = { project: existing.modelSelection },
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(null),
            }),
            ServerSettings.layerTest({
              projectSettingsFolded: false,
              providerInstances: {
                [ProviderInstanceId.make("opencode")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  enabled: true,
                },
                [ProviderInstanceId.make("opencode_alt")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  enabled: true,
                },
              },
              ...(defaults.environment === undefined
                ? {}
                : { defaultModelSelection: defaults.environment }),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeedSome({
                  id: projectId,
                  workspaceRoot,
                  defaultModelSelection: defaults.project,
                } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks: [task] }),
              upsert: (input) =>
                Ref.update(saved, (strategies) => [...strategies, input.workspaceStrategy]).pipe(
                  Effect.andThen(
                    inputs === undefined
                      ? Effect.void
                      : Ref.update(inputs, (all) => [...all, input]),
                  ),
                  Effect.as({ task }),
                ),
            }),
          ),
        ),
      );
    const masterRepository: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: (cwd, remoteName) =>
        Effect.succeed(cwd === workspaceRoot && remoteName === "origin" ? "master" : null),
      resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
    };
    const schedule = { type: "interval", everyMs: 3_600_000 } as const;

    it.effect("starts from the project's default branch", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect("uses the environment's default model when the project inherits it", () =>
      Effect.gen(function* () {
        const environmentDefault = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        };
        const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
              existing,
              inputs,
              { project: null, environment: environmentDefault },
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(
          (yield* Ref.get(inputs)).map((input) => input.modelSelection),
          [environmentDefault],
        );
      }),
    );

    it.effect.each([
      {
        name: "drops an emoji the limit splits",
        prompt: `${"a".repeat(79)}😀 rest`,
        title: "a".repeat(79),
      },
      {
        name: "keeps an emoji that ends at the limit",
        prompt: `${"a".repeat(78)}😀 rest`,
        title: `${"a".repeat(78)}😀`,
      },
    ])("a prompt-derived title $name", ({ prompt, title }) =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
              existing,
              inputs,
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt, schedule });
        assert.deepEqual(
          (yield* Ref.get(inputs)).map((input) => input.title),
          [title],
        );
      }),
    );

    it.effect("keeps one thread when fresh sessions are turned off before the first run", () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
              { ...existing, threadMode: "fresh_session" },
              inputs,
            ),
          ),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          freshSession: false,
        });
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(
          (yield* Ref.get(inputs)).map((input) => input.threadMode),
          ["continue", "new_thread"],
        );
      }),
    );

    it.effect(
      "refuses unbinding into fresh sessions in one call, which would keep the thread",
      () =>
        Effect.gen(function* () {
          const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
                {
                  ...existing,
                  threadId: ThreadId.make("thread:scheduled-base"),
                  threadMode: "continue",
                },
                inputs,
              ),
            ),
          );
          const refused = yield* mcp
            .updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              bindToCurrentThread: false,
              freshSession: true,
            })
            .pipe(Effect.flip);
          assert.include(refused.message, "first unbind it");
          assert.deepEqual(yield* Ref.get(inputs), []);
        }),
    );

    it.effect("follows the default branch when a task is unbound from its thread", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(masterRepository, saved, {
              ...existing,
              threadId: ThreadId.make("thread:scheduled-base"),
              threadMode: "continue",
            }),
          ),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect("keeps the saved workspace when an unbound task stays unbound", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(yield* Ref.get(saved), [{ type: "root" }]);
      }),
    );

    it.effect.each([
      {
        name: "no remote, only master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master"],
        baseRef: "master",
      },
      {
        name: "no remote, main and master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/heads/main"],
        baseRef: "main",
      },
      {
        name: "no remote, neither main nor master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/develop"],
        baseRef: "main",
      },
      {
        name: "no recorded HEAD, remote main and a stale local master",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/remotes/origin/main"],
        baseRef: "origin/main",
      },
      {
        name: "no recorded HEAD, master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, local main and master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, nothing conventional on the remote, local main",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/develop"],
        baseRef: "main",
      },
      {
        name: "a recorded HEAD whose branch is gone",
        remote: "origin",
        remoteDefault: "main",
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "a remote not called origin",
        remote: "upstream",
        remoteDefault: "develop",
        refs: ["refs/remotes/upstream/develop"],
        baseRef: "upstream/develop",
      },
      {
        name: "a remote not called origin, no recorded HEAD",
        remote: "upstream",
        remoteDefault: null,
        refs: ["refs/remotes/upstream/main"],
        baseRef: "upstream/main",
      },
    ])("$name starts from $baseRef", ({ remote, remoteDefault, refs, baseRef }) =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const gitFailure = (cwd: string, detail: string) =>
          new GitCommandError({ operation: "GitVcsDriver.test", command: "git", cwd, detail });
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              {
                resolvePrimaryRemoteName: (cwd) =>
                  remote === null
                    ? Effect.fail(gitFailure(cwd, "No git remote is configured."))
                    : Effect.succeed(remote),
                resolveDefaultBranchName: () => Effect.succeed(remoteDefault),
                resolveCommit: ({ cwd, revision }) =>
                  refs.includes(revision)
                    ? Effect.succeed({ commitSha: "abc123" })
                    : Effect.fail(gitFailure(cwd, "Needed a single revision")),
              },
              saved,
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef, startFromOrigin: true },
        ]);
      }),
    );
  });

  describe("resolveRuntimeMode", () => {
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* resolveRuntimeMode("full-access", "auto-accept-edits", muse).pipe(
          Effect.flip,
        );
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(yield* resolveRuntimeMode("full-access", "inherit", muse), "full-access");
        assert.equal(yield* resolveRuntimeMode("auto", undefined, muse), "approval-required");
      }),
    );
  });
});

describe("OrchestratorMcpService thread lookup", () => {
  const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
  const launched = liveThreadShell(ThreadId.make(`mcp:${bareId}`));
  const deletedLaunched = { ...launched, deletedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z") };
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-lookup"),
    requestNamespace: "client:thread-lookup",
    thread: undefined,
    client: { sessionId: "thread-lookup", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const service = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    sent: Ref.Ref<number>,
    overrides: Partial<ThreadManagementService.ThreadManagementService["Service"]> = {},
  ) =>
    layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
            ...overrides,
          }),
          ServerSettings.layerTest({
            projectSettingsFolded: false,
            providerInstances: {
              [ProviderInstanceId.make("opencode")]: {
                driver: ProviderDriverKind.make("opencode"),
                enabled: true,
              },
              [ProviderInstanceId.make("opencode_alt")]: {
                driver: ProviderDriverKind.make("opencode"),
                enabled: true,
              },
            },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );
  const failuresFor = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const read = yield* mcp.readThread(client, { threadId: bareId }).pipe(Effect.flip);
        const send = yield* mcp
          .sendToThread(client, { threadId: bareId, message: "hello" })
          .pipe(Effect.flip);
        const wait = yield* mcp.waitForThread(client, { threadId: bareId }).pipe(Effect.flip);
        return { read, send, wait, sends: yield* Ref.get(sent) };
      }).pipe(Effect.provide(service(shells, sent)));
    });

  it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
    Effect.gen(function* () {
      const { read, send, wait, sends } = yield* failuresFor([launched]);
      for (const error of [read, send, wait]) {
        assert.equal(error.code, "thread_not_found");
        assert.include(error.message, `mcp:${bareId}`);
      }
      assert.equal(sends, 0);
    }),
  );

  it.effect("points a pasted thread link at the thread it names", () =>
    Effect.gen(function* () {
      const delegated = liveThreadShell(ThreadId.make("thread:delegated-task:command%3Amcp%3Aabc"));
      const ref = { environmentId: client.environmentId, threadId: delegated.id };
      const sent = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const link of [
          `t3-thread://v2/${ref.environmentId}/${ref.threadId}`,
          formatThreadLink(ref, "Delegated task"),
          hostedThreadLink(ref),
        ]) {
          const read = yield* mcp
            .readThread(client, { threadId: ThreadId.make(link) })
            .pipe(Effect.flip);
          assert.equal(read.code, "thread_not_found");
          assert.include(read.message, `\`${delegated.id}\``, link);
          assert.include(read.message, "is a thread link");
          assert.notInclude(read.message, "no longer available");
        }
      }).pipe(Effect.provide(service([delegated], sent)));
    }),
  );

  it.effect("keeps the plain message for an id that matches nothing", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([]);
      assert.equal(read.code, "thread_not_found");
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.code, "thread_not_found");
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.code, "thread_not_found");
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("does not name an mcp: thread that was deleted", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([deletedLaunched]);
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("tells an agent steering a finished thread to start a new turn instead", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const mode of ["steer", "restart"] as const) {
          const error = yield* mcp
            .sendToThread(client, { threadId: launched.id, message: "hello", mode })
            .pipe(Effect.flip);
          assert.equal(error.code, "thread_not_sendable");
          assert.include(error.message, 'mode: "auto"');
          assert.include(error.message, '"queue"');
        }
      }).pipe(
        Effect.provide(
          service([launched], sent, {
            getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(launched)),
            sendToThread: (input) =>
              Effect.fail(
                new ThreadManagementService.ThreadManagementNoSteerableRunError({
                  threadId: input.threadId,
                  mode: input.mode === "restart" ? "restart" : "steer",
                }),
              ),
          }),
        ),
      );
    }),
  );

  it.effect("refuses waiting without orchestration capability before reading the target", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* mcp
          .waitForThread({ ...client, capabilities: new Set() }, { threadId: bareId })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unauthorized target access"),
          }),
        ),
      );
    }),
  );

  it.effect("waits on the caller's own thread without a separate shell lookup", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* mcp.waitForThread(
          {
            ...client,
            thread: {
              threadId: launched.id,
              providerSessionId: "provider-session:wait-self",
              providerInstanceId: ProviderInstanceId.make("opencode"),
            },
          },
          { threadId: launched.id },
        );
        assert.deepEqual(result, {
          threadId: launched.id,
          runId: null,
          status: "idle",
          timedOut: false,
        });
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unexpected shell lookup for the caller"),
            getThreadRecords: () => Effect.succeed(idleThreadProjection(launched)),
            waitForThread: () =>
              Effect.succeed({ threadId: launched.id, run: null, timedOut: false }),
          }),
        ),
      );
    }),
  );
});

describe("OrchestratorMcpService thread list", () => {
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-list"),
    requestNamespace: "client:thread-list",
    thread: undefined,
    client: { sessionId: "thread-list", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const shell = (
    id: string,
    projectId: string,
    snoozed: boolean,
    waiting = false,
    pinned = false,
  ) => ({
    ...liveThreadShell(ThreadId.make(id)),
    projectId: ProjectId.make(projectId),
    status: "completed" as const,
    snoozedUntil: snoozed ? DateTime.makeUnsafe("2099-01-01T00:00:00Z") : null,
    pinnedAt: pinned ? DateTime.makeUnsafe("2026-01-01T00:00:00Z") : null,
    blockedOnThreadWait: waiting,
    pendingBackgroundTasks: waiting
      ? [
          {
            taskId: "task-subagent",
            kind: "subagent" as const,
            description: "Review the diff",
            parentTaskId: "task-parent",
            providerInstanceId: ProviderInstanceId.make("opencode"),
            childThreadId: ThreadId.make("thread:b-child"),
          },
          { taskId: "task-tests", kind: "command" as const, awaited: true as const },
        ]
      : [],
  });
  const shells = [
    shell("thread:a-snoozed", "project:a", true),
    shell("thread:a-awake", "project:a", false),
    shell("thread:b-snoozed", "project:b", true, true, true),
    {
      ...shell("thread:a-awaiting-command", "project:a", false),
      activityRunStatus: null,
      pendingBackgroundTasks: [
        { taskId: "sleep-600", kind: "command" as const, awaited: true as const },
      ],
    },
    {
      ...shell("thread:c-settled", "project:c", false),
      settledOverride: "settled" as const,
      settledAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z"),
    },
    {
      ...shell("thread:c-awaiting-command", "project:c", false),
      activityRunStatus: null,
      pendingBackgroundTasks: [
        { taskId: "sleep-600", kind: "command" as const, awaited: true as const },
      ],
    },
  ];
  const shellRequests: Array<ReadonlyArray<ThreadId>> = [];
  const service = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: (input) =>
            Effect.succeed(
              shells.filter(
                (thread) => input.projectId === undefined || thread.projectId === input.projectId,
              ),
            ),
          listActiveShellIndex: () =>
            Effect.succeed(
              shells.map((thread) => ({
                ...thread,
                mayBeLive: isLiveSubagentShell(thread),
                hasRemoteTasks: false,
              })),
            ),
          getShellSnapshot: (options) => {
            const threadIds = options?.threadIds ?? shells.map((thread) => thread.id);
            shellRequests.push(threadIds);
            return Effect.succeed({
              threads: shells.filter((thread) => threadIds.includes(thread.id)),
            } as never);
          },
        }),
        ServerSettings.layerTest({
          projectSettingsFolded: false,
          providerInstances: {
            [ProviderInstanceId.make("opencode")]: {
              driver: ProviderDriverKind.make("opencode"),
              enabled: true,
            },
            [ProviderInstanceId.make("opencode_alt")]: {
              driver: ProviderDriverKind.make("opencode"),
              enabled: true,
            },
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            shells.some((thread) => thread.projectId === id)
              ? Effect.succeedSome({
                  id,
                  title: id,
                  workspaceRoot: `/projects/${id}`,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-10-18T00:00:00.000Z",
                  updatedAt: "2026-10-18T00:00:00.000Z",
                  deletedAt: null,
                })
              : Effect.succeedNone,
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );

  it.effect("lists snoozed threads across every project with allProjects", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp.listThreads(client, {
        allProjects: true,
        projectId: ProjectId.make("project:a"),
        snoozed: true,
      });
      assert.equal(listed.projectId, null);
      assert.deepStrictEqual(
        listed.threads.map((thread) => [thread.threadId, thread.projectId]),
        [
          ["thread:a-snoozed", "project:a"],
          ["thread:b-snoozed", "project:b"],
        ],
      );
      assert.deepStrictEqual(
        listed.threads.map((thread) => thread.pinned),
        [false, true],
      );
      assert.deepStrictEqual(
        listed.threads.map((thread) => [thread.blockedOnThreadWait, thread.pendingBackgroundTasks]),
        [
          [false, []],
          [
            true,
            [
              {
                taskId: "task-subagent",
                kind: "subagent",
                description: "Review the diff",
                childThreadId: ThreadId.make("thread:b-child"),
              },
              { taskId: "task-tests", kind: "command", awaited: true },
            ],
          ],
        ],
      );
    }).pipe(Effect.provide(service)),
  );

  it.effect("refuses a projectId that names no project", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp
        .listThreads(client, { projectId: ProjectId.make("project:missing") })
        .pipe(Effect.result);
      if (Result.isSuccess(listed)) {
        assert.fail(`listed threads for a missing project: ${JSON.stringify(listed.success)}`);
      }
      assert.equal(listed.failure.code, "invalid_request");
      assert.include(listed.failure.message, "not found");
    }).pipe(Effect.provide(service)),
  );

  it.effect("counts a thread holding awaited background work as live in the status filter", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:a"),
        statuses: ["preparing", "queued", "starting", "running", "waiting"],
      });
      assert.deepStrictEqual(
        listed.threads.map((thread) => thread.threadId),
        ["thread:a-awaiting-command"],
      );
    }).pipe(Effect.provide(service)),
  );

  it.effect("skips building shells for settled threads when every status filter is live", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      shellRequests.length = 0;
      const listed = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:c"),
        statuses: ["preparing", "queued", "starting", "running", "waiting"],
      });
      assert.deepStrictEqual(
        listed.threads.map((thread) => thread.threadId),
        ["thread:c-awaiting-command"],
      );
      assert.notInclude(shellRequests.flat(), ThreadId.make("thread:c-settled"));
    }).pipe(Effect.provide(service)),
  );

  it.effect("builds shells only for the threads on the page", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      shellRequests.length = 0;
      const listed = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:a"),
        limit: 1,
      });
      assert.deepStrictEqual(
        [listed.threads.map((thread) => thread.threadId), listed.total, listed.nextCursor],
        [["thread:a-snoozed"], 3, 1],
      );
      assert.deepStrictEqual(shellRequests, [[ThreadId.make("thread:a-snoozed")]]);
    }).pipe(Effect.provide(service)),
  );

  it.effect("points a caller outside any thread at allProjects when it omits projectId", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* mcp.listThreads(client, {}).pipe(Effect.flip);
      assert.equal(error.code, "target_required");
      assert.include(error.message, "allProjects");
    }).pipe(Effect.provide(service)),
  );
});
