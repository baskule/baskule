import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";
import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const NATIVE_CLI_DRIVER = ProviderDriverKind.make("nativeCli");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const NATIVE_CLI_INSTANCE_ID = ProviderInstanceId.make("nativeCli");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();

// Pin Linux so raw command/args assertions bypass Windows shim resolution.
const layerNonWindowsPlatform = Layer.succeed(HostProcess.Platform, "linux");

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === NATIVE_CLI_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "native-agent",
      updateArgs: ["update"],
      updateLockKey: "native-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: "0.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseNativeCliProvider: ServerProvider = {
  ...baseProvider,
  instanceId: NATIVE_CLI_INSTANCE_ID,
  driver: NATIVE_CLI_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const layerLatestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv | undefined },
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: NodeJS.ProcessEnv | undefined };
      };
      return Effect.succeed(
        mockHandle(handler(childProcess.command, childProcess.args, childProcess.options)),
      );
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
  options?: {
    readonly installedVersionAfterUpdate?: string;
  },
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });

    const registry: ProviderRegistry.ProviderRegistry["Service"] = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshAfterUpdate: () => {
        const version = options?.installedVersionAfterUpdate;
        if (version === undefined) {
          return Ref.get(providersRef);
        }
        return Ref.updateAndGet(providersRef, (providers) =>
          providers.map((provider) => ({
            ...provider,
            version,
          })),
        );
      },
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      invalidateModelCaches: () => Effect.void,
      refreshModelCatalog: Effect.void,
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    return {
      registry,
      providersRef,
      updateStatesRef,
    };
  });
}

const makeTestRunner = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [CODEX_DRIVER, OPENCODE_DRIVER].map((driver) => ({
      driver,
      t3CodeRange: ">=0.0.42",
      ranges: [],
    })),
  },
  latestVersions: Layer.Layer<ProviderLatestVersions.ProviderLatestVersions> = ProviderLatestVersions.layer,
) =>
  Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.succeed(manifest),
              refreshOnDemand: Effect.succeed(manifest),
              refreshInBackground: Effect.void,
            }),
            latestVersions,
            // Layers memoize by reference, so a test that provides the gate shares it.
            ProviderInstallationGate.layer,
          ),
        ),
      ),
    ),
  );

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "native-agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => [state.status, state.message]),
        [
          ["queued", "Waiting for another provider update to finish."],
          ["running", "Checking for the latest version"],
          ["running", "Waiting for running provider work to finish."],
          ["running", "Running native-agent update"],
          ["running", "Verifying the installed version"],
          ["succeeded", "Provider updated."],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "keeps a successful update when the binary is present but its version is unreadable",
    () => {
      return Effect.gen(function* () {
        const { registry, providersRef } = yield* makeRegistry(baseNativeCliProvider);
        const updater = yield* makeTestRunner({
          ...registry,
          refreshAfterUpdate: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({ ...provider, installed: true, version: null })),
            ),
        });

        const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("1.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      );
    },
  );

  it("splits installer output into clean status lines", () => {
    assert.deepStrictEqual(ProviderMaintenanceRunner.splitOutputLines("Down", "loading\r\n 5"), {
      lines: ["Downloading"],
      partialLine: " 5",
    });
    assert.strictEqual(
      ProviderMaintenanceRunner.toProgressLine("\u001b[1m==>\u001b[0m  Pouring"),
      "==> Pouring",
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(" \t "), null);
    assert.strictEqual(
      ProviderMaintenanceRunner.splitOutputLines("x".repeat(5_000), "y").partialLine.length,
      4_096,
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine("x".repeat(300))?.length, 200);

    for (const redraw of [
      "\r",
      "\u001b[G",
      "\u001b[0G",
      "\u001b[1G",
      "\u001b[01G",
      "\u001b[999D",
      "\u001b[999D\u001b[J",
    ]) {
      const output = `first${redraw}second${redraw}last`;
      for (let boundary = 0; boundary <= output.length; boundary++) {
        let partialLine = "";
        for (const chunk of [output.slice(0, boundary), output.slice(boundary)]) {
          partialLine = ProviderMaintenanceRunner.splitOutputLines(partialLine, chunk).partialLine;
        }
        assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(partialLine), "last");
      }
    }
    for (const incomplete of ["\u001b", "\u001b[", "\u001b[0", "\u001b[01"]) {
      assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(`progress${incomplete}`), null);
    }
  });

  it.effect("reports the updater's error rather than a trailing hint after it", () =>
    Effect.forEach(
      [
        {
          stdout: "Current version: 2.1.310\nChecking for updates to latest version...\n",
          stderr: [
            "Error: Failed to install native update",
            "TelemetrySafeError: Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): Request failed with status code 403",
            'Try running "claude doctor" for diagnostics',
            "",
          ].join("\n"),
          reason: "Request failed with status code 403",
          hint: "claude doctor",
        },
        {
          stdout: "",
          stderr: [
            "Failed to check for updates",
            "Unable to fetch latest version from npm registry",
            "",
            "Possible causes:",
            "  • Network connectivity issues",
            "  • npm registry is unreachable",
            "  • Corporate proxy/firewall blocking npm",
            "",
            "Try:",
            "  • Check your internet connection",
            "  • Run with --debug flag for more details",
            "  • Manually check: npm view @anthropic-ai/claude-code version",
            "  • Check if you need to login: npm whoami",
            "",
          ].join("\n"),
          reason: "Failed to check for updates",
          hint: "npm whoami",
        },
      ],
      ({ stdout, stderr, reason, hint }) =>
        Effect.gen(function* () {
          const { registry } = yield* makeRegistry(baseNativeCliProvider);
          const updater = yield* makeTestRunner(registry);

          const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
          const message = result.providers[0]?.updateState?.message ?? "";

          assert.include(message, reason);
          assert.notInclude(message, hint);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerNonWindowsPlatform,
              layerLatestVersionHttpClient("0.0.0"),
              layerMockSpawner(() => ({ stdout, stderr, code: 1 })),
            ),
          ),
        ),
      { discard: true },
    ),
  );

  // A native updater such as `claude update` downloads a ~300 MB binary and
  // prints nothing while it does. Killed mid-download, it leaves a truncated
  // binary behind that later updates mistake for an install.
  it.effect.each([
    { runFor: "6 minutes", status: "succeeded", message: "Provider updated." },
    { runFor: "31 minutes", status: "failed", message: "Update timed out after 30 minutes." },
  ] as const)("lets a slow installer run for $runFor", ({ runFor, status, message }) => {
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);

      const update = yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(runFor);
      const result = yield* Fiber.join(update);

      assert.strictEqual(result.providers[0]?.updateState?.status, status);
      assert.strictEqual(result.providers[0]?.updateState?.message, message);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({
            exitCode: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.sleep(runFor)),
              Effect.as(ChildProcessSpawner.ExitCode(0)),
            ),
          })),
        ),
      ),
    );
  });

  it.effect("an interrupted update ends failed instead of running forever", () => {
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);
      const update = yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(update);
      const last = (yield* Ref.get(updateStatesRef)).at(-1);
      assert.deepStrictEqual(
        [last?.status, last?.message],
        ["failed", "Update stopped before it finished."],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({
            exitCode: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })),
        ),
      ),
    );
  });

  it.effect("a request dropped while the final state is written still records it", () => {
    const writing = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        setProviderMaintenanceActionState: (input) =>
          input.state?.status === "succeeded"
            ? Deferred.succeed(writing, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(registry.setProviderMaintenanceActionState(input)),
              )
            : registry.setProviderMaintenanceActionState(input),
      });

      const update = yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      update.interruptUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(update);

      assert.strictEqual((yield* Ref.get(updateStatesRef)).at(-1)?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });
});

it.effect.each([
  {
    mode: "default-precurrent",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "default",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "targeted",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "targeted-current",
    version: "1.14.20",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "unknown",
    version: "1.14.19",
    installation: { installedVersion: null },
    status: "unchanged",
  },
  { mode: "legacy", version: "1.14.20", installation: {}, status: "succeeded" },
] as const)(
  "verifies the $mode OpenCode update using the refreshed installation",
  ({ mode, version, installation, status }) => {
    const calls: string[] = [];
    const capabilities = lifecycleFor(OPENCODE_DRIVER);
    const pinnedCapabilities = {
      ...capabilities,
      update: { ...capabilities.update!, lockKey: "npm-global:/fixture" },
    };
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      compatibility: [
        {
          driver: OPENCODE_DRIVER,
          t3CodeRange: ">=0.0.42",
          recommendedVersion: "1.14.20",
          ranges: [{ range: "=1.14.20", status: "supported" }],
        },
      ],
    };
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseOpenCodeProvider, version });
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const updater = yield* makeTestRunner(
        {
          ...registry,
          refreshInstance: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({
                ...provider,
                ...(mode === "default-precurrent" ? installation : {}),
                checkedAt: "2026-04-10T00:00:01.000Z",
              })),
            ),
          getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(pinnedCapabilities),
          refreshAfterUpdate: () =>
            Effect.gen(function* () {
              assert.strictEqual(calls.length, 1);
              const refreshed = yield* enrichProviderSnapshotWithVersionAdvisory(
                { ...baseOpenCodeProvider, version, ...installation },
                pinnedCapabilities,
              ).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              );
              return yield* Ref.updateAndGet(providersRef, (providers) =>
                providers.map((provider) => ({ ...provider, ...refreshed })),
              );
            }),
        },
        manifest,
      );

      const result = yield* updater.updateProvider({
        provider: OPENCODE_DRIVER,
        ...(mode.startsWith("default") ? {} : { targetVersion: "1.14.20" }),
      });

      assert.deepStrictEqual(
        calls,
        mode === "default-precurrent"
          ? []
          : [`npm install -g opencode-ai@${mode.startsWith("default") ? "latest" : "1.14.20"}`],
      );
      const provider = result.providers[0];
      assert.ok(provider);
      assert.strictEqual(provider.updateState?.status, status);
      if (mode === "default" || mode === "default-precurrent" || mode === "targeted") {
        assert.strictEqual(
          provider.updateState?.message,
          "OpenCode CLI updated. Restart the configured local OpenCode server to use the new version.",
        );
      }
      assert.strictEqual(provider.version, version);
      assert.strictEqual("installedVersion" in provider, mode !== "legacy");
      if (mode === "default-precurrent") return;
      assert.strictEqual(
        provider.versionAdvisory?.status,
        mode === "unknown" ? "unknown" : "current",
      );
      assert.strictEqual(
        provider.versionAdvisory?.currentVersion,
        mode === "unknown" ? null : "1.14.20",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          ProviderLatestVersions.layer,
          layerLatestVersionHttpClient("1.14.20"),
          layerMockSpawner((command, args) => {
            calls.push([command, ...args].join(" "));
            return { stdout: "installed" };
          }),
        ),
      ),
    );
  },
);
