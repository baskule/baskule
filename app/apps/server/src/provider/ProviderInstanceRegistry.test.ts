import * as Deferred from "effect/Deferred";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import * as ModelManifest from "./ModelManifest.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderDriverError } from "./Errors.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

// The mock CLIs from makeTildeProviderFixtures are scripts Windows cannot execute.

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
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
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

describe("ProviderInstanceRegistry — OpenCode instances", () => {
  const layerInfra = OpenCodeRuntime.layer.pipe(
    Layer.provide(OpenCodeServerLedger.layerTest),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.empty),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  );
  const layerBaseDeps = Layer.empty.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "provider-instance-registry-all-drivers-test",
      }),
    ),
    Layer.provideMerge(layerInfra),
    Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerTestHttpClient),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
  );
  const layerBase = ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps));
  const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provideMerge(layerBase),
  );

  it.effect.each(["replacement", "removal", "creation failure"] as const)(
    "detaches retired provider scopes after repeated %s",
    (scenario) =>
      Effect.gen(function* () {
        const parent = yield* Scope.make();
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped();
        let creates = 0;
        let closes = 0;
        const driver: typeof OpenCodeDriver = {
          ...OpenCodeDriver,
          create: Effect.fn("ProviderInstanceRegistry.test.create")(function* (
            input: Parameters<typeof OpenCodeDriver.create>[0],
          ) {
            creates++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closes++;
              }),
            );
            if (input.config.binaryPath === "creation-failure") {
              return yield* new ProviderDriverError({
                driver: OpenCodeDriver.driverKind,
                instanceId: input.instanceId,
                detail: "fixture creation failed",
              });
            }
            return yield* OpenCodeDriver.create(input);
          }),
        };
        const siblingId = ProviderInstanceId.make("sibling");
        const retiredId = ProviderInstanceId.make("retired");
        const entry = {
          driver: OpenCodeDriver.driverKind,
          enabled: false,
          config: Object.assign({}, { homePath }),
        };
        yield* Effect.gen(function* () {
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: { [siblingId]: entry },
          });
          const sibling = yield* registry.getInstance(siblingId);
          const finalizerCount = () => {
            const state = parent.state;
            return state._tag === "Open" ? (state.finalizers?.size ?? 1) : 0;
          };
          const baseline = finalizerCount();
          for (let index = 0; index < 20; index++) {
            yield* mutator.reconcile({
              [siblingId]: entry,
              [retiredId]: {
                ...entry,
                config: Object.assign(
                  {},
                  {
                    homePath,
                    binaryPath:
                      scenario === "creation failure" ? "creation-failure" : "unused-opencode",
                    customModels: [`revision-${index}`],
                  },
                ),
              },
            });
            if (scenario === "removal") yield* mutator.reconcile({ [siblingId]: entry });
          }
          yield* mutator.reconcile({ [siblingId]: entry });
          expect(yield* registry.getInstance(siblingId)).toBe(sibling);
          expect(closes).toBe(creates - 1);
          expect(parent.state._tag).toBe("Open");
          expect(finalizerCount()).toBe(baseline);
        }).pipe(
          Effect.provideService(Scope.Scope, parent),
          Effect.ensuring(Scope.close(parent, Exit.void)),
        );
        expect(closes).toBe(creates);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["replacement", "removal"] as const)(
    "hides retired instances during reconcile (%s)",
    (scenario) =>
      Effect.gen(function* () {
        let closed = 0;
        const replacementStarted = yield* Deferred.make<void>();
        const releaseReplacement = yield* Deferred.make<void>();
        const driver: typeof OpenCodeDriver = {
          ...OpenCodeDriver,
          create: (input) =>
            Effect.gen(function* () {
              if (input.displayName === "Second") {
                yield* Deferred.succeed(replacementStarted, undefined);
                yield* Deferred.await(releaseReplacement);
              }
              const instance = yield* OpenCodeDriver.create(input);
              yield* Effect.addFinalizer(() => Effect.sync(() => closed++));
              return instance;
            }),
        };
        const retiredId = ProviderInstanceId.make("retired");
        const siblingId = ProviderInstanceId.make("sibling");
        const nextId = scenario === "replacement" ? retiredId : ProviderInstanceId.make("new");
        const entry = {
          driver: OpenCodeDriver.driverKind,
          enabled: false,
          config: Object.assign({}, {}),
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [retiredId]: entry, [siblingId]: entry },
        });
        const sibling = yield* registry.getInstance(siblingId);
        const reconcile = yield* mutator
          .reconcile({
            [siblingId]: entry,
            [nextId]: {
              ...entry,
              displayName: "Second",
              config: Object.assign({}, { customModels: ["replacement-model"] }),
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(replacementStarted);
        expect(closed).toBe(1);
        expect(yield* registry.getInstance(retiredId)).toBeUndefined();
        expect(yield* registry.listInstances).toEqual([sibling]);
        yield* Deferred.succeed(releaseReplacement, undefined);
        yield* Fiber.join(reconcile);
        expect((yield* registry.getInstance(nextId))?.displayName).toBe("Second");
        expect(yield* registry.getInstance(siblingId)).toBe(sibling);
        expect(closed).toBe(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.live("keeps two OpenCode instances independent with no provider probes while disabled", () =>
    Effect.gen(function* () {
      const first = ProviderInstanceId.make("opencode_first");
      const second = ProviderInstanceId.make("opencode_second");
      const driver = ProviderDriverKind.make("opencode");
      const { registry } = yield* makeProviderInstanceRegistry<OpenCodeDriverEnv>({
        drivers: [OpenCodeDriver],
        configMap: {
          [first]: { driver, enabled: false, config: {} },
          [second]: { driver, enabled: false, config: {} },
        },
      });
      expect(yield* registry.listUnavailable).toEqual([]);
      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(2);
      const snapshots = yield* Effect.forEach(
        instances,
        (instance) => instance.snapshot.getSnapshot,
      );
      expect(snapshots.map((snapshot) => snapshot.instanceId).sort()).toEqual([first, second]);
      expect(snapshots.every((snapshot) => snapshot.driver === driver && !snapshot.enabled)).toBe(
        true,
      );
    }).pipe(Effect.provide(layerTest)),
  );
});
