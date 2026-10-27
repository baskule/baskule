import { vi } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert, expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  ServerProvider,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderInstanceRegistryHydration from "./ProviderInstanceRegistryHydration.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "./providerStatusCache.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { ProviderDriverError } from "./Errors.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeServerProvider = Schema.decodeSync(ServerProvider);
const encodeServerProvider = Schema.encodeSync(ServerProvider);
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodedDefaultServerSettings = encodeServerSettings(DEFAULT_SERVER_SETTINGS);

const disabledDefaultSlots = (
  ...drivers: ReadonlyArray<string>
): ContractServerSettings["providerInstances"] =>
  Object.fromEntries(
    drivers.map((driver) => [
      ProviderInstanceId.make(driver),
      { driver: ProviderDriverKind.make(driver), enabled: false },
    ]),
  );

const encoder = new TextEncoder();
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const withBundledCompatibility = (snapshot: ServerProvider) =>
  applyProviderCompatibility(
    snapshot,
    undefined,
    ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
  );

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
).pipe(Layer.provideMerge(ModelManifest.layerTest));

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      updateProviderInstance: (mutation, patch = {}) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = ServerSettingsModule.applyProviderInstanceMutation(
            applyServerSettingsPatch(current, patch),
            mutation,
          );
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      withSettingsSnapshot: (use) => Ref.get(settingsRef).pipe(Effect.flatMap(use)),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        );
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}

const awaitPersistedProvider = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  checkedAt: string,
) =>
  registry.streamChanges.pipe(
    Stream.filter((providers) => providers.some((provider) => provider.checkedAt === checkedAt)),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );

const layerTestNodeServices = Layer.mergeAll(
  ProviderLatestVersions.layer,
  NodeServices.layer,
  Layer.empty,
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
);

it.layer(
  Layer.mergeAll(layerTestNodeServices, ServerSettingsModule.layerTest(), layerTestHttpClient),
)("ProviderRegistry", (it) => {
  describe("ProviderRegistry.layer", () => {
    it("stores workspace skills, commands and options without changing machine metadata", () => {
      const provider = {
        instanceId: ProviderInstanceId.make("example"),
        driver: ProviderDriverKind.make("example"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "1.0.0",
        models: [],
        slashCommands: [{ name: "global" }],
        skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
      } satisfies ServerProvider;
      const scopedSnapshot = {
        ...provider,
        checkedAt: "2026-03-25T00:01:00.000Z",
        slashCommands: [{ name: "project" }],
        skills: [{ name: "project", path: "/project/SKILL.md", enabled: true }],
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [{ id: "readonly", label: "Readonly" }],
          },
        ],
      } satisfies ProviderWorkspaceSnapshot;

      const result = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        scopedSnapshot,
      );

      assert.deepStrictEqual(result.slashCommands, provider.slashCommands);
      assert.deepStrictEqual(result.skills, provider.skills);
      assert.strictEqual(result.models, provider.models);
      const decoded = decodeServerProvider(encodeServerProvider(result));
      assert.deepStrictEqual(decoded.workspaceSnapshots, [
        {
          cwd: "/project",
          checkedAt: scopedSnapshot.checkedAt,
          slashCommands: scopedSnapshot.slashCommands,
          skills: scopedSnapshot.skills,
          optionDescriptors: scopedSnapshot.optionDescriptors,
        },
      ]);

      const pendingSnapshot = {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND],
        slashCommandsPending: true,
      } satisfies ProviderWorkspaceSnapshot;
      const partial = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        result,
        "/project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(partial.workspaceSnapshots?.[0]?.slashCommands, [{ name: "project" }]);
      assert.strictEqual(partial.workspaceSnapshots?.[0]?.slashCommandsPending, true);
      const otherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        partial,
        "/other-project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(otherProject.workspaceSnapshots?.[1]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
      ]);
      const recovered = ProviderRegistry.upsertProviderWorkspaceSnapshot(partial, "/project", {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND, { name: "replacement" }],
      });
      assert.deepStrictEqual(recovered.workspaceSnapshots?.[0]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
        { name: "replacement" },
      ]);
      assert.strictEqual(recovered.workspaceSnapshots?.[0]?.slashCommandsPending, undefined);

      const { optionDescriptors, ...failedSnapshot } = scopedSnapshot;
      const firstFailure = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(firstFailure.workspaceSnapshots![0]!, "optionDescriptors"),
        false,
      );
      const failedOtherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        recovered,
        "/other-project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(failedOtherProject.workspaceSnapshots![1]!, "optionDescriptors"),
        false,
      );

      for (const clearedDescriptors of [[], [{ ...optionDescriptors[0]!, options: [] }]]) {
        const cleared = ProviderRegistry.upsertProviderWorkspaceSnapshot(recovered, "/project", {
          ...scopedSnapshot,
          optionDescriptors: clearedDescriptors,
        });
        assert.deepStrictEqual(
          cleared.workspaceSnapshots?.[0]?.optionDescriptors,
          clearedDescriptors,
        );
      }

      const failedRefresh = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        failedOtherProject,
        "/project",
        failedSnapshot,
      );
      assert.deepStrictEqual(
        failedRefresh.workspaceSnapshots?.[1]?.optionDescriptors,
        optionDescriptors,
      );
    });

    it("preserves previously discovered provider models when a refresh returns none", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("secondary"),
        driver: ProviderDriverKind.make("secondary"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: "2026.04.09-f2b0fcd",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("reasoning", "Reasoning", [
                  { id: "high", label: "High", isDefault: true },
                ]),
                booleanDescriptor("fastMode", "Fast Mode"),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
        slashCommands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            name: "typescript",
            description: "TypeScript help",
            path: "/skills/typescript/SKILL.md",
            enabled: true,
          },
        ],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
        [],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
        [],
      );
    });

    it("drops custom models the refreshed snapshot no longer carries", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("tertiary"),
        driver: ProviderDriverKind.make("tertiary"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: "2.1.0",
        models: [
          {
            slug: "claude-sonnet-4-6",
            name: "Sonnet 4.6",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "removed-custom",
            name: "removed-custom",
            isCustom: true,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [previousProvider.models[0]],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...refreshedProvider.models],
      );
    });

    it("does not bring back models the installed CLI is too old to run", () => {
      const pendingProvider = {
        instanceId: ProviderInstanceId.make("tertiary"),
        driver: ProviderDriverKind.make("tertiary"),
        status: "warning",
        enabled: true,
        installed: false,
        auth: { status: "unknown" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: null,
        models: [
          { slug: "claude-old", name: "Old", isCustom: false, capabilities: null },
          { slug: "claude-next", name: "Next", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const probedProvider = {
        ...pendingProvider,
        status: "ready",
        installed: true,
        auth: { status: "authenticated" },
        version: "1.0.0",
        models: [pendingProvider.models[0]],
        updateRequiredModels: [{ slug: "claude-next", name: "Next", minVersion: "1.1.0" }],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(pendingProvider, probedProvider).models,
        [...probedProvider.models],
      );
    });

    it("drops stale OpenCode models missing from a successful refresh", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-07-17T00:00:00.000Z",
        version: "1.0.0",
        models: [
          {
            slug: "github/gpt-5",
            name: "GPT-5",
            subProvider: "GitHub",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "removed-plugin/model",
            name: "Removed Plugin Model",
            subProvider: "Removed Plugin",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-07-17T00:01:00.000Z",
        models: [
          {
            slug: "github/gpt-5",
            name: "GPT-5",
            subProvider: "GitHub",
            isCustom: false,
            capabilities: null,
          },
        ],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...refreshedProvider.models],
      );
    });

    it("retains stale OpenCode models when a refresh fails", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-07-17T00:00:00.000Z",
        version: "1.0.0",
        models: [
          {
            slug: "github/gpt-5",
            name: "GPT-5",
            subProvider: "GitHub",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            name: "typescript",
            description: "TypeScript help",
            path: "/skills/typescript/SKILL.md",
            enabled: true,
          },
        ],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        status: "error",
        auth: { status: "unknown" },
        checkedAt: "2026-07-17T00:01:00.000Z",
        models: [],
        message: "Failed to refresh OpenCode models.",
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
        previousProvider.slashCommands,
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
        previousProvider.skills,
      );
    });

    it("classifies pending, logout, uninstall, and reconnect OpenCode inventories", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-07-17T00:00:00.000Z",
        version: "1.0.0",
        models: [
          {
            slug: "github/gpt-5",
            name: "GPT-5",
            subProvider: "GitHub",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "removed-plugin/model",
            name: "Removed Plugin Model",
            subProvider: "Removed Plugin",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            name: "typescript",
            description: "TypeScript help",
            path: "/skills/typescript/SKILL.md",
            enabled: true,
          },
        ],
      } as const satisfies ServerProvider;
      const pendingProvider = {
        ...previousProvider,
        status: "warning",
        installed: false,
        auth: { status: "unknown" },
        checkedAt: "2026-07-17T00:01:00.000Z",
        version: null,
        models: [],
        message: "OpenCode provider status has not been checked in this session yet.",
      } satisfies ServerProvider;
      const loggedOutProvider = {
        ...previousProvider,
        status: "warning",
        auth: { status: "unknown" },
        checkedAt: "2026-07-17T00:02:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
        message: "OpenCode is available, but it did not report any connected upstream providers.",
      } satisfies ServerProvider;
      const missingProvider = {
        ...previousProvider,
        status: "error",
        installed: false,
        auth: { status: "unknown" },
        checkedAt: "2026-07-17T00:03:00.000Z",
        version: null,
        models: [],
        message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      } satisfies ServerProvider;
      const authoritativeProvider = {
        ...previousProvider,
        checkedAt: "2026-07-17T00:04:00.000Z",
        models: [previousProvider.models[0]!],
      } satisfies ServerProvider;
      const failedProvider = {
        ...authoritativeProvider,
        status: "error",
        auth: { status: "unknown" },
        checkedAt: "2026-07-17T00:05:00.000Z",
        models: [],
        message: "Failed to refresh OpenCode models.",
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, pendingProvider).models,
        [...previousProvider.models],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, loggedOutProvider).models,
        [],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, loggedOutProvider).slashCommands,
        [],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, loggedOutProvider).skills,
        [],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, missingProvider).models,
        [],
      );

      const afterRemoval = ProviderRegistry.mergeProviderSnapshot(
        previousProvider,
        authoritativeProvider,
      );
      const afterFailure = ProviderRegistry.mergeProviderSnapshot(afterRemoval, failedProvider);

      assert.deepStrictEqual(afterFailure.models, [authoritativeProvider.models[0]!]);
    });

    it("fills missing capabilities from the previous provider snapshot", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("secondary"),
        driver: ProviderDriverKind.make("secondary"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: "2026.04.09-f2b0fcd",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("reasoning", "Reasoning", [
                  { id: "high", label: "High", isDefault: true },
                ]),
                booleanDescriptor("fastMode", "Fast Mode"),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [],
            }),
          },
        ],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
    });

    it.effect("does not run provider probes during layer construction", () =>
      Effect.gen(function* () {
        const exampleDriver = ProviderDriverKind.make("example");
        const exampleInstanceId = ProviderInstanceId.make("example");
        const initialProvider = {
          instanceId: exampleInstanceId,
          driver: exampleDriver,
          status: "warning",
          enabled: true,
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: null,
          message: "Checking example provider status.",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshCalls = yield* Ref.make(0);
        const instance = {
          instanceId: exampleInstanceId,
          driverKind: exampleDriver,
          continuationIdentity: {
            driverKind: exampleDriver,
            continuationKey: "example:instance:example",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: exampleDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.never),
            ),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === exampleInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-background-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          assert.deepStrictEqual(yield* registry.getProviders, [initialProvider]);
          assert.strictEqual(yield* Ref.get(refreshCalls), 0);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    const updateScenarios = [
      "healthy",
      "unauthenticated",
      "sibling defects",
      "selected defect",
      "selected disabled",
    ] as const;
    it.effect.each(updateScenarios)("refreshes account caches after update (%s)", (scenario) =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("example");
        const packageName = "@example/provider";
        const manifestRefreshes = yield* Ref.make(0);
        const events: string[] = [];
        const manifest = {
          version: 1,
          currentModels: {},
          compatibility: [{ driver, t3CodeRange: ">=0.0.42", ranges: [] }],
        } satisfies ModelManifest.ModelManifestData;
        const makeInstance = (
          id: string,
          config: { binaryPath: string; home: string; model: string },
          enabled = true,
          driverKind = driver,
        ): ProviderInstance => {
          const instanceId = ProviderInstanceId.make(id);
          const provider = {
            instanceId,
            driver: driverKind,
            status: scenario === "unauthenticated" ? "error" : "ready",
            enabled,
            installed: true,
            auth: {
              status:
                scenario === "unauthenticated" || scenario === "selected defect"
                  ? "unauthenticated"
                  : "authenticated",
              label: config.home,
            },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: scenario === "selected defect" && id === "personal" ? "2.0.0" : "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          let cached = true;
          return {
            instanceId,
            driverKind,
            continuationIdentity: { driverKind, continuationKey: config.home },
            displayName: undefined,
            enabled,
            snapshot: {
              resolveMaintenance: () =>
                Effect.sync(() => {
                  if (id === "broken-maintenance" && events.includes("update")) {
                    throw new Error("Sibling maintenance failed");
                  }
                  return makeProviderMaintenanceCapabilities({
                    provider: driverKind,
                    packageName: scenario === "selected defect" ? null : packageName,
                    updateExecutable: config.binaryPath,
                    updateArgs: ["update"],
                    env: { PROVIDER_HOME: config.home },
                    updateLockKey: config.binaryPath,
                    latestVersion: scenario === "selected defect" ? null : "2.0.0",
                  });
                }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.sync(() => {
                events.push(`probe:${id}`);
                if (
                  id === "broken-discovery" ||
                  (scenario === "selected defect" && id === "personal")
                ) {
                  throw new Error("Provider discovery failed");
                }
                return cached
                  ? provider
                  : {
                      ...provider,
                      version: "2.0.0",
                      models: [
                        {
                          slug: config.model,
                          name: config.model,
                          isCustom: false,
                          capabilities: createModelCapabilities({ optionDescriptors: [] }),
                        },
                      ],
                    };
              }),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            invalidateCaches: Effect.sync(() => {
              cached = false;
              events.push(`invalidate:${id}`);
            }),
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          };
        };
        const instances = [
          makeInstance(
            "personal",
            { binaryPath: "/personal/agent", home: "/personal", model: "personal-model" },
            scenario !== "selected disabled",
          ),
          makeInstance("work", { binaryPath: "/work/agent", home: "/work", model: "work-model" }),
          ...(scenario === "sibling defects"
            ? ["broken-maintenance", "broken-discovery"].map((id) =>
                makeInstance(id, { binaryPath: `/${id}/agent`, home: `/${id}`, model: id }),
              )
            : []),
          makeInstance(
            "disabled",
            { binaryPath: "/disabled/agent", home: "/disabled", model: "disabled-model" },
            false,
          ),
          makeInstance(
            "unrelated",
            { binaryPath: "/other/agent", home: "/other", model: "other-model" },
            true,
            ProviderDriverKind.make("other"),
          ),
        ];
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderMaintenanceRunner.layer.pipe(
            Layer.provideMerge(ProviderRegistry.layer),
            Layer.provideMerge(
              Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
                getInstance: (instanceId) =>
                  Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
                listInstances: Effect.succeed(instances),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(ModelManifest.ModelManifest, {
                current: Effect.succeed(manifest),
                refresh: Effect.succeed(manifest),
                forceRefresh: Ref.update(manifestRefreshes, (count) => count + 1).pipe(
                  Effect.as(manifest),
                ),
                refreshInBackground: Effect.void,
              }),
            ),
            Layer.provideMerge(
              Layer.effect(
                ProviderLatestVersions.ProviderLatestVersions,
                ProviderLatestVersions.make([
                  [packageName, "1.0.0"],
                  ["unrelated-package", "1.0.0"],
                ]),
              ),
            ),
            Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provideMerge(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) =>
                  Effect.sync(() => {
                    assert.strictEqual(command._tag, "StandardCommand");
                    if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
                    assert.strictEqual(command.command, "/personal/agent");
                    assert.deepStrictEqual(command.args, ["update"]);
                    assert.strictEqual(command.options.env?.PROVIDER_HOME, "/personal");
                    events.push("update");
                    return mockHandle({ stdout: "updated", stderr: "", code: 0 });
                  }),
                ),
              ),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-update-caches-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
          const before = yield* registry.getProviders;
          if (scenario === "selected defect") {
            const selected = before.find((p) => p.instanceId === "personal");
            assert.strictEqual(selected?.version, "2.0.0");
            assert.strictEqual(selected?.status, "ready");
            assert.strictEqual(selected?.auth.status, "unauthenticated");
            assert.strictEqual(selected?.versionAdvisory, undefined);
          }
          const result = yield* runner.updateProvider({
            provider: driver,
            instanceId: ProviderInstanceId.make("personal"),
          });
          assert.strictEqual(
            result.providers.find((p) => p.instanceId === "personal")?.updateState?.status,
            scenario === "selected defect" ? "unchanged" : "succeeded",
          );
          assert.deepStrictEqual(
            events.filter((event) => event === "update"),
            ["update"],
          );
          assert.strictEqual(events[0], "update");
          assert.deepStrictEqual(
            events.filter((event) => event.startsWith("probe:")).toSorted(),
            [
              "probe:personal",
              "probe:work",
              ...(scenario === "sibling defects" ? ["probe:broken-discovery"] : []),
            ].toSorted(),
          );
          for (const id of ["personal", "work"]) {
            assert.isBelow(events.indexOf(`invalidate:${id}`), events.indexOf(`probe:${id}`));
            assert.include(events, `invalidate:${id}`);
            const provider = result.providers.find((p) => p.instanceId === id);
            assert.deepStrictEqual(
              provider?.models.map((model) => model.slug),
              scenario === "selected defect" && id === "personal" ? [] : [`${id}-model`],
            );
            assert.strictEqual(provider?.auth.label, `/${id}`);
            if (scenario === "unauthenticated") {
              assert.strictEqual(provider?.status, "error");
              assert.strictEqual(provider?.auth.status, "unauthenticated");
              assert.strictEqual(provider?.version, "2.0.0");
            }
          }
          for (const id of scenario === "sibling defects"
            ? ["broken-maintenance", "broken-discovery"]
            : scenario === "selected defect"
              ? ["personal"]
              : []) {
            assert.strictEqual(result.providers.find((p) => p.instanceId === id)?.status, "error");
          }
          assert.isAtLeast(yield* Ref.get(manifestRefreshes), 1);
          assert.strictEqual(
            yield* latestVersions.cached(packageName, Effect.succeed("2.0.0")),
            scenario === "selected defect" ? "1.0.0" : "2.0.0",
          );
          assert.strictEqual(
            yield* latestVersions.cached("unrelated-package", Effect.succeed("2.0.0")),
            "1.0.0",
          );
          assert.strictEqual(
            result.providers.find((p) => p.instanceId === "work")?.updateState,
            undefined,
          );
          for (const id of ["disabled", "unrelated"]) {
            assert.notInclude(events, `invalidate:${id}`);
            assert.deepStrictEqual(
              result.providers.find((p) => p.instanceId === id),
              before.find((p) => p.instanceId === id),
            );
          }
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("deduplicates cwd probes and clears snapshots when an instance rebuilds", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("example");
        const instanceId = ProviderInstanceId.make("example");
        const machineProvider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [{ name: "global" }],
          skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
        } as const satisfies ServerProvider;
        const scopedProvider = {
          ...machineProvider,
          checkedAt: "2026-06-10T00:01:00.000Z",
          slashCommands: [{ name: "project" }],
          skills: [{ name: "project", path: "/workspace/SKILL.md", enabled: true }],
        } as const satisfies ServerProvider;
        const snapshotCalls = yield* Ref.make(0);
        const scopedResult = yield* Ref.make<ProviderWorkspaceSnapshot>({
          ...scopedProvider,
          status: "error",
          slashCommands: [COMPACT_SLASH_COMMAND],
          slashCommandsPending: true,
        });
        const cacheInvalidations = yield* Ref.make(0);
        const scanGate = yield* Ref.make<{
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null>(null);
        const failScan = yield* Ref.make(true);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const makeInstance = (
          provider: ServerProvider,
          snapshotForCwd: NonNullable<ProviderInstance["snapshotForCwd"]>,
        ): ProviderInstance => ({
          instanceId,
          driverKind: driver,
          continuationIdentity: {
            driverKind: driver,
            continuationKey: "example:instance:example",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(provider),
            refresh: Effect.succeed(provider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd,
          invalidateCaches: Ref.update(cacheInvalidations, (count) => count + 1),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        });
        const firstInstance = makeInstance(machineProvider, () =>
          Effect.gen(function* () {
            yield* Ref.update(snapshotCalls, (count) => count + 1);
            if (yield* Ref.get(failScan)) {
              return yield* new ProviderDriverError({
                driver,
                instanceId,
                detail: "The workspace scan failed.",
              });
            }
            yield* Deferred.succeed(probeStarted, undefined);
            yield* Deferred.await(releaseProbe);
            const result = yield* Ref.get(scopedResult);
            const gate = yield* Ref.getAndSet(scanGate, null);
            if (gate) {
              yield* Deferred.succeed(gate.started, undefined);
              yield* Deferred.await(gate.release);
            }
            return result;
          }),
        );
        const rebuiltProvider = {
          ...machineProvider,
          checkedAt: "2026-06-10T00:02:00.000Z",
          status: "warning",
          installed: false,
          auth: { status: "unknown" },
        } satisfies ServerProvider;
        const rebuiltInstance = makeInstance(rebuiltProvider, () =>
          Ref.update(snapshotCalls, (count) => count + 1).pipe(Effect.as(scopedProvider)),
        );
        const registryChanges = yield* PubSub.unbounded<void>();
        const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([firstInstance]);
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Ref.get(instancesRef).pipe(
                Effect.map((instances) =>
                  instances.find((instance) => instance.instanceId === requestedId),
                ),
              ),
            listInstances: Ref.get(instancesRef),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.fromPubSub(registryChanges),
            subscribeChanges: PubSub.subscribe(registryChanges),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-workspace-snapshot-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual((yield* registry.getProviders)[0]?.workspaceSnapshots, undefined);
          yield* Ref.set(failScan, false);
          const workspaceUpdate = yield* registry.streamChanges.pipe(
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          const firstRefresh = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          const duplicateRefresh = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(snapshotCalls), 2);
          yield* Deferred.succeed(releaseProbe, undefined);
          yield* Fiber.join(firstRefresh);
          yield* Fiber.join(duplicateRefresh);
          const published = yield* Fiber.join(workspaceUpdate);
          assert.strictEqual(published._tag, "Some");
          const providers = yield* registry.getProviders;
          assert.deepStrictEqual(providers[0]?.skills, machineProvider.skills);
          assert.deepStrictEqual(
            providers[0]?.workspaceSnapshots?.[0]?.skills,
            scopedProvider.skills,
          );
          assert.deepStrictEqual(providers[0]?.workspaceSnapshots?.[0]?.slashCommands, [
            COMPACT_SLASH_COMMAND,
          ]);
          assert.strictEqual(providers[0]?.workspaceSnapshots?.[0]?.slashCommandsPending, true);
          yield* Ref.set(scopedResult, {
            ...scopedProvider,
            status: "error",
            slashCommandsPending: false,
          });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 3);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.[0]?.slashCommands,
            scopedProvider.slashCommands,
          );
          assert.strictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.[0]?.slashCommandsPending,
            undefined,
          );
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 3);
          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS - 1);
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 3);
          yield* TestClock.adjust(1);
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 4);
          const newSkills = [
            ...scopedProvider.skills,
            { name: "added", path: "/workspace/added/SKILL.md", enabled: true },
          ];
          yield* Ref.set(scopedResult, { ...scopedProvider, skills: newSkills });
          yield* registry.refreshWorkspaceSnapshot({
            instanceId,
            cwd: "/workspace",
            fresh: true,
          });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 5);
          assert.strictEqual(yield* Ref.get(cacheInvalidations), 1);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.map((s) => s.skills),
            [newSkills],
          );

          const slowStarted = yield* Deferred.make<void>();
          const releaseSlow = yield* Deferred.make<void>();
          yield* Ref.set(scanGate, { started: slowStarted, release: releaseSlow });
          yield* Ref.set(scopedResult, scopedProvider);
          const slowScan = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace", fresh: true })
            .pipe(Effect.forkChild);
          yield* Deferred.await(slowStarted);
          const latestSkills = [
            ...newSkills,
            { name: "latest", path: "/workspace/latest/SKILL.md", enabled: true },
          ];
          yield* Ref.set(scopedResult, { ...scopedProvider, skills: latestSkills });
          yield* registry.refreshWorkspaceSnapshot({
            instanceId,
            cwd: "/workspace",
            fresh: true,
          });
          yield* Deferred.succeed(releaseSlow, undefined);
          yield* Fiber.join(slowScan);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.map((s) => s.skills),
            [latestSkills],
          );

          // With no cached snapshot, an older scan must leave publication and
          // request deduplication to the forced scan even when it finishes first.
          const olderStarted = yield* Deferred.make<void>();
          const releaseOlder = yield* Deferred.make<void>();
          yield* Ref.set(scanGate, { started: olderStarted, release: releaseOlder });
          yield* Ref.set(scopedResult, scopedProvider);
          const olderScan = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace2" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(olderStarted);
          const newerStarted = yield* Deferred.make<void>();
          const releaseNewer = yield* Deferred.make<void>();
          yield* Ref.set(scanGate, { started: newerStarted, release: releaseNewer });
          yield* Ref.set(scopedResult, { ...scopedProvider, skills: latestSkills });
          const newerScan = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace2", fresh: true })
            .pipe(Effect.forkChild);
          yield* Deferred.await(newerStarted);
          yield* Deferred.succeed(releaseOlder, undefined);
          yield* Fiber.join(olderScan);
          assert.strictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.find(
              (snapshot) => snapshot.cwd === "/workspace2",
            ),
            undefined,
          );
          const callsWhileForced = yield* Ref.get(snapshotCalls);
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace2" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), callsWhileForced);
          yield* Deferred.succeed(releaseNewer, undefined);
          yield* Fiber.join(newerScan);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.find(
              (snapshot) => snapshot.cwd === "/workspace2",
            )?.skills,
            latestSkills,
          );

          yield* Ref.set(instancesRef, [rebuiltInstance]);
          yield* PubSub.publish(registryChanges, undefined);
          let rebuilt = yield* registry.getProviders;
          for (
            let attempt = 0;
            attempt < 50 && rebuilt[0]?.checkedAt !== rebuiltProvider.checkedAt;
            attempt += 1
          ) {
            yield* Effect.yieldNow;
            rebuilt = yield* registry.getProviders;
          }
          assert.strictEqual(rebuilt[0]?.checkedAt, rebuiltProvider.checkedAt);
          assert.strictEqual(rebuilt[0]?.workspaceSnapshots, undefined);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("publishes workspace skills while machine health is in error", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("example");
        const instanceId = ProviderInstanceId.make("example");
        const healthyProvider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [COMPACT_SLASH_COMMAND],
          skills: [],
        } as const satisfies ServerProvider;
        // example's account check failed; its skill scan did not.
        const unhealthyProvider = {
          ...healthyProvider,
          status: "error",
          auth: { status: "unknown" },
          message: "example app-server provider probe failed: unauthorized (401).",
          slashCommands: [],
        } as const satisfies ServerProvider;
        const firstSkills = [{ name: "first", path: "/workspace/first/SKILL.md", enabled: true }];
        const laterSkills = [{ name: "later", path: "/workspace/later/SKILL.md", enabled: true }];
        const scanResult = yield* Ref.make<ProviderWorkspaceSnapshot>({
          ...healthyProvider,
          skills: firstSkills,
        });
        const instance: ProviderInstance = {
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: "example:instance:example" },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(unhealthyProvider),
            refresh: Effect.succeed(unhealthyProvider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: () => Ref.get(scanResult),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        };
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(requestedId === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-unhealthy-workspace-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const workspaceOf = Effect.map(
            registry.getProviders,
            (providers) => providers[0]?.workspaceSnapshots?.[0],
          );
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.slashCommands, [COMPACT_SLASH_COMMAND]);

          // An expired scan runs while the account check fails: the skills are
          // current, but commands that ride on the health check are unknown.
          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const unhealthy = yield* workspaceOf;
          assert.deepStrictEqual(unhealthy?.skills, laterSkills);
          assert.deepStrictEqual(unhealthy?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(unhealthy?.slashCommandsPending, true);
          const provider = (yield* registry.getProviders)[0];
          assert.strictEqual(provider?.status, "error");
          assert.strictEqual(provider?.message, unhealthyProvider.message);

          // A pending entry is rescanned on the next request; an empty scan
          // removes the skills.
          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: [] });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.skills, []);

          // A driver that discovers its own commands reports them even while
          // health is in error.
          const discoveredCommand = { name: "review", description: "Review changes" };
          yield* Ref.set(scanResult, {
            ...unhealthyProvider,
            slashCommands: [discoveredCommand],
            slashCommandsPending: false,
          });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const discovered = yield* workspaceOf;
          assert.deepStrictEqual(discovered?.slashCommands, [discoveredCommand]);
          assert.strictEqual(discovered?.slashCommandsPending, undefined);

          // Once health recovers, the next scan restores the full entry.
          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...healthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const recovered = yield* workspaceOf;
          assert.deepStrictEqual(recovered?.skills, laterSkills);
          assert.deepStrictEqual(recovered?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(recovered?.slashCommandsPending, undefined);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("refreshes OpenCode catalogs and preserves other providers", () =>
      Effect.gen(function* () {
        const exampleDriver = ProviderDriverKind.make("example");
        const openCodeDriver = ProviderDriverKind.make("opencode");
        const exampleInstanceId = ProviderInstanceId.make("example");
        const openCodeInstanceId = ProviderInstanceId.make("opencode");
        const exampleRefreshCalls = yield* Ref.make(0);
        const openCodeRefreshCalls = yield* Ref.make(0);
        const exampleProvider = {
          instanceId: exampleInstanceId,
          driver: exampleDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const failedOpenCodeProvider = {
          instanceId: openCodeInstanceId,
          driver: openCodeDriver,
          status: "error",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          message: "Failed to refresh OpenCode models.",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const recoveredOpenCodeProvider = {
          ...failedOpenCodeProvider,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:01:00.000Z",
          message: "One upstream provider connected through OpenCode.",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
        } as const satisfies ServerProvider;
        const changedCatalogProvider = {
          ...recoveredOpenCodeProvider,
          checkedAt: "2026-06-10T00:02:00.000Z",
          models: [
            {
              slug: "anthropic/claude-sonnet-4",
              name: "Tertiary Sonnet 4",
              subProvider: "Anthropic",
              isCustom: false,
              capabilities: null,
            },
          ],
        } as const satisfies ServerProvider;
        const catalogSnapshot = yield* Ref.make<ServerProvider>(recoveredOpenCodeProvider);
        const instances = [
          {
            instanceId: exampleInstanceId,
            driverKind: exampleDriver,
            continuationIdentity: {
              driverKind: exampleDriver,
              continuationKey: "example:instance:example",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: exampleDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(exampleProvider),
              refresh: Ref.update(exampleRefreshCalls, (count) => count + 1).pipe(
                Effect.as(exampleProvider),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
          {
            instanceId: openCodeInstanceId,
            driverKind: openCodeDriver,
            continuationIdentity: {
              driverKind: openCodeDriver,
              continuationKey: "opencode:instance:opencode",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: openCodeDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(failedOpenCodeProvider),
              refresh: Ref.update(openCodeRefreshCalls, (count) => count + 1).pipe(
                Effect.andThen(Ref.get(catalogSnapshot)),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
        ] satisfies ReadonlyArray<ProviderInstance>;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-reconnect-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const initialProviders = yield* registry.getProviders;
          assert.strictEqual(
            initialProviders.find((provider) => provider.instanceId === openCodeInstanceId)?.status,
            "error",
          );

          const recoveredProviders = yield* registry.refresh();
          assert.deepStrictEqual(
            recoveredProviders.find((provider) => provider.instanceId === openCodeInstanceId)
              ?.models,
            recoveredOpenCodeProvider.models,
          );
          assert.deepStrictEqual(
            recoveredProviders.find((provider) => provider.instanceId === exampleInstanceId),
            withBundledCompatibility(exampleProvider),
          );

          yield* Ref.set(catalogSnapshot, changedCatalogProvider);
          const changedProviders = yield* registry.refresh();
          assert.deepStrictEqual(
            changedProviders.find((provider) => provider.instanceId === openCodeInstanceId)?.models,
            changedCatalogProvider.models,
          );
          assert.deepStrictEqual(
            changedProviders.find((provider) => provider.instanceId === exampleInstanceId),
            withBundledCompatibility(exampleProvider),
          );
        }).pipe(Effect.provide(runtimeServices));

        assert.strictEqual(yield* Ref.get(exampleRefreshCalls), 2);
        assert.strictEqual(yield* Ref.get(openCodeRefreshCalls), 2);
      }),
    );

    it("persists merged provider snapshots for the providers that were refreshed", () => {
      const previousProviders = [
        {
          instanceId: ProviderInstanceId.make("secondary"),
          driver: ProviderDriverKind.make("secondary"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        },
        {
          instanceId: ProviderInstanceId.make("example"),
          driver: ProviderDriverKind.make("example"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const satisfies ReadonlyArray<ServerProvider>;
      const refreshedsecondary = {
        ...previousProviders[0],
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [],
      } satisfies ServerProvider;

      const mergedProviders = ProviderRegistry.mergeProviderSnapshots(previousProviders, [
        refreshedsecondary,
      ]);
      const persistedProviders = ProviderRegistry.selectProvidersByKind(
        mergedProviders,
        new Set([ProviderDriverKind.make("secondary")]),
      );

      assert.deepStrictEqual(persistedProviders, [
        {
          ...refreshedsecondary,
          models: [...previousProviders[0].models],
        },
      ]);
    });

    it.effect("shares one in-flight pass between concurrent untargeted refreshes", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("example");
        const instanceId = ProviderInstanceId.make("example");
        const provider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshCalls = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const instances = [
          {
            instanceId,
            driverKind: driver,
            continuationIdentity: {
              driverKind: driver,
              continuationKey: "example:instance:example",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: driver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.gen(function* () {
                yield* Ref.update(refreshCalls, (count) => count + 1);
                yield* Deferred.succeed(probeStarted, undefined);
                yield* Deferred.await(releaseProbe);
                return provider;
              }),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
        ] satisfies ReadonlyArray<ProviderInstance>;
        const instanceRegistryLayer = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === requestedId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(instanceRegistryLayer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-shared-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const first = yield* registry.refresh().pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          const second = yield* registry.refresh().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);
          yield* Deferred.succeed(releaseProbe, undefined);
          expect(yield* Fiber.join(first)).toEqual([expect.objectContaining(provider)]);
          expect(yield* Fiber.join(second)).toEqual([expect.objectContaining(provider)]);
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);

          yield* registry.refresh();
          assert.strictEqual(yield* Ref.get(refreshCalls), 2);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("persists the merged snapshot when a live update has empty models", () =>
      Effect.gen(function* () {
        const secondaryDriver = ProviderDriverKind.make("secondary");
        const secondaryInstanceId = ProviderInstanceId.make("secondary");
        const initialProvider = {
          instanceId: secondaryInstanceId,
          driver: secondaryDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...initialProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const instance = {
          instanceId: secondaryInstanceId,
          driverKind: secondaryDriver,
          continuationIdentity: {
            driverKind: secondaryDriver,
            continuationKey: "secondary:instance:secondary",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: secondaryDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Effect.succeed(refreshedProvider),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === secondaryInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-merged-persist-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: secondaryInstanceId,
          });

          assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
            ...initialProvider.models,
          ]);
          const persisted = yield* awaitPersistedProvider(registry, refreshedProvider.checkedAt);
          yield* PubSub.publish(changes, refreshedProvider);
          yield* Fiber.join(persisted);
          const cachedProvider = yield* readProviderStatusCache(filePath);

          assert.deepStrictEqual(
            cachedProvider,
            withBundledCompatibility({
              ...refreshedProvider,
              models: [...initialProvider.models],
            }),
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect(
      "persists authoritative OpenCode removals without resurrecting them on a failed live refresh",
      () =>
        Effect.gen(function* () {
          const openCodeDriver = ProviderDriverKind.make("opencode");
          const openCodeInstanceId = ProviderInstanceId.make("opencode");
          const initialProvider = {
            instanceId: openCodeInstanceId,
            driver: openCodeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-07-17T00:00:00.000Z",
            version: "1.0.0",
            models: [
              {
                slug: "github/gpt-5",
                name: "GPT-5",
                subProvider: "GitHub",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: "removed-plugin/model",
                name: "Removed Plugin Model",
                subProvider: "Removed Plugin",
                isCustom: false,
                capabilities: null,
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const authoritativeProvider = {
            ...initialProvider,
            checkedAt: "2026-07-17T00:01:00.000Z",
            models: [initialProvider.models[0]!],
          } satisfies ServerProvider;
          const failedProvider = {
            ...authoritativeProvider,
            status: "error",
            auth: { status: "unknown" },
            checkedAt: "2026-07-17T00:02:00.000Z",
            models: [],
            message: "Failed to refresh OpenCode models.",
          } satisfies ServerProvider;
          const changes = yield* PubSub.unbounded<ServerProvider>();
          const instance = {
            instanceId: openCodeInstanceId,
            driverKind: openCodeDriver,
            continuationIdentity: {
              driverKind: openCodeDriver,
              continuationKey: "opencode:instance:opencode",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: openCodeDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(authoritativeProvider),
              streamChanges: Stream.fromPubSub(changes),
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === openCodeInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provideMerge(layerInstanceRegistry),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-opencode-authoritative-persist-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const config = yield* ServerConfig.ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: openCodeInstanceId,
            });

            const authoritativePersisted = yield* awaitPersistedProvider(
              registry,
              authoritativeProvider.checkedAt,
            );
            yield* PubSub.publish(changes, authoritativeProvider);
            yield* Fiber.join(authoritativePersisted);
            let cachedProvider = yield* readProviderStatusCache(filePath);

            assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);

            const failedPersisted = yield* awaitPersistedProvider(
              registry,
              failedProvider.checkedAt,
            );
            yield* PubSub.publish(changes, failedProvider);
            yield* Fiber.join(failedPersisted);
            cachedProvider = yield* readProviderStatusCache(filePath);

            assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);
            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
              authoritativeProvider.models[0]!,
            ]);
          }).pipe(Effect.provide(runtimeServices));
        }),
    );

    it.effect("returns the cached provider list when a manual refresh fails", () =>
      Effect.gen(function* () {
        const exampleDriver = ProviderDriverKind.make("example");
        const exampleInstanceId = ProviderInstanceId.make("example");
        const cachedProvider = {
          instanceId: exampleInstanceId,
          driver: exampleDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const instance = {
          instanceId: exampleInstanceId,
          driverKind: exampleDriver,
          continuationIdentity: {
            driverKind: exampleDriver,
            continuationKey: "example:instance:example",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: exampleDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(cachedProvider),
            refresh: Effect.die(new Error("simulated refresh failure")),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === exampleInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-refresh-failure-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;

          assert.deepStrictEqual(yield* registry.getProviders, [
            withBundledCompatibility(cachedProvider),
          ]);
          assert.deepStrictEqual(yield* registry.refresh(exampleDriver), [
            withBundledCompatibility(cachedProvider),
          ]);
          assert.deepStrictEqual(yield* registry.refreshInstance(exampleInstanceId), [
            withBundledCompatibility(cachedProvider),
          ]);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("keeps consuming registry changes after one sync fails", () =>
      Effect.gen(function* () {
        const exampleDriver = ProviderDriverKind.make("example");
        const exampleInstanceId = ProviderInstanceId.make("example");
        const claudeDriver = ProviderDriverKind.make("tertiary");
        const claudeInstanceId = ProviderInstanceId.make("tertiary");
        const exampleProvider = {
          instanceId: exampleInstanceId,
          driver: exampleDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const claudeProvider = {
          instanceId: claudeInstanceId,
          driver: claudeDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:01:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const makeInstance = (provider: ServerProvider): ProviderInstance => ({
          instanceId: provider.instanceId,
          driverKind: provider.driver,
          continuationIdentity: {
            driverKind: provider.driver,
            continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: provider.driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(provider),
            refresh: Effect.succeed(provider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        });
        const exampleInstance = makeInstance(exampleProvider);
        const claudeInstance = makeInstance(claudeProvider);
        const changes = yield* PubSub.unbounded<void>();
        const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([exampleInstance]);
        const failNextList = yield* Ref.make(false);
        const wait = () => Effect.yieldNow;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Ref.get(instancesRef).pipe(
                Effect.map((instances) =>
                  instances.find((instance) => instance.instanceId === instanceId),
                ),
              ),
            listInstances: Effect.gen(function* () {
              const shouldFail = yield* Ref.get(failNextList);
              if (shouldFail) {
                yield* Ref.set(failNextList, false);
                return yield* Effect.die(new Error("simulated registry list failure"));
              }
              return yield* Ref.get(instancesRef);
            }),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-sync-failure-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          assert.deepStrictEqual(yield* registry.getProviders, [
            withBundledCompatibility(exampleProvider),
          ]);

          yield* Ref.set(failNextList, true);
          yield* PubSub.publish(changes, undefined);

          yield* Ref.set(instancesRef, [exampleInstance, claudeInstance]);
          yield* PubSub.publish(changes, undefined);

          let providers = yield* registry.getProviders;
          for (
            let attempt = 0;
            attempt < 50 && !providers.some((provider) => provider.instanceId === claudeInstanceId);
            attempt += 1
          ) {
            yield* wait();
            providers = yield* registry.getProviders;
          }

          assert.deepStrictEqual(
            providers.map((provider) => provider.instanceId).toSorted(),
            [exampleInstanceId, claudeInstanceId].toSorted(),
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    const startupSettings = (instanceId?: string) =>
      decodeServerSettings({
        ...encodedDefaultServerSettings,
        providerInstances: {
          ...disabledDefaultSlots(
            "example",
            "tertiary",
            "secondary",
            "grok",
            "opencode",
            "antigravity",
            "pi",
            "muse",
          ),
          ...(instanceId ? { [instanceId]: { driver: "ghostDriver" } } : {}),
        },
      });

    const hydrateDuringSettingsChange = Effect.fnUntraced(function* (input: {
      seed: ContractServerSettings;
      saved: ContractServerSettings;
      current: ContractServerSettings;
      failCurrentRead?: boolean;
    }) {
      const changes = yield* PubSub.unbounded<ContractServerSettings | undefined>();
      const consume = yield* Deferred.make<void>();
      const drained: Array<Deferred.Deferred<void>> = [];
      let readSeed = true;
      let failCurrentRead = false;
      const settings = yield* makeMutableServerSettingsService(input.current);
      const serverSettings = {
        ...settings,
        getSettings: Effect.suspend(() => {
          if (!readSeed) {
            readSeed = true;
            return PubSub.publish(changes, input.saved).pipe(Effect.as(input.seed));
          }
          return failCurrentRead
            ? Effect.fail(
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  operation: "read-secret",
                  cause: new Error("secret materialization failed"),
                }),
              )
            : settings.getSettings;
        }),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const done = yield* Deferred.make<void>();
          drained.push(done);
          // The terminal marker acknowledges preceding reconciles, including no-op/failed reads.
          return Stream.fromEffectRepeat(
            Deferred.await(consume).pipe(Effect.andThen(PubSub.take(subscription))),
          ).pipe(
            Stream.takeWhile((next): next is ContractServerSettings => next !== undefined),
            Stream.ensuring(Deferred.succeed(done, undefined)),
          );
        }),
      } satisfies ServerSettingsModule.ServerSettingsService["Service"];
      const dependencies = yield* Layer.build(
        Layer.mergeAll(
          Layer.empty,
          ServerSecretStore.layer,
          OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
        ).pipe(
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-registry-" }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        ),
      );
      readSeed = false;
      const services = yield* Layer.build(ProviderInstanceRegistryHydration.layer).pipe(
        Effect.provide(dependencies),
      );
      failCurrentRead = input.failCurrentRead ?? false;
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.succeed(consume, undefined);
      yield* Effect.forEach(drained, Deferred.await);
      const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry.pipe(
        Effect.provide(services),
      );
      return (yield* registry.listUnavailable).map(
        (provider): string | undefined => provider.instanceId,
      );
    });

    it.effect("applies a settings change saved while the provider registry starts", () =>
      Effect.gen(function* () {
        const saved = startupSettings("ghost_late");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed: startupSettings(),
          saved,
          current: saved,
        });
        assert.include(unavailable, "ghost_late");
      }),
    );

    it.effect("does not apply a queued settings change older than the registry seed", () =>
      Effect.gen(function* () {
        const seed = startupSettings("ghost_current");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed,
          saved: startupSettings("ghost_stale"),
          current: seed,
        });
        assert.include(unavailable, "ghost_current");
        assert.notInclude(unavailable, "ghost_stale");
      }),
    );

    it.effect(
      "retains the newer registry seed when a queued stale change cannot read current settings",
      () =>
        Effect.gen(function* () {
          const seed = startupSettings("ghost_current");
          const unavailable = yield* hydrateDuringSettingsChange({
            seed,
            saved: startupSettings("ghost_stale"),
            current: seed,
            failCurrentRead: true,
          });
          assert.include(unavailable, "ghost_current");
          assert.notInclude(unavailable, "ghost_stale");
        }),
    );
  });
});
