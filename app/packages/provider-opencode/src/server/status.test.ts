import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { beforeEach } from "vite-plus/test";

import { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2Workspace,
  makeOpenCode2ModelLoader,
  type OpenCode2Model,
  type OpenCode2Workspace,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2SkillsToServerProviderSkills,
} from "./status.ts";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
import { probeOpenCodeRuntime } from "./versionProbe.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DEFAULT_VERSION_STDOUT = "opencode v2.0.18\n";

it.effect("reads Go limits with the instance's XDG credentials and preserves reset times", () =>
  Effect.gen(function* () {
    const resetsAt = "2026-09-17T12:00:00.000Z";
    const limits = yield* readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: "/instance/data", OPENCODE_API_KEY: "env-key" },
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            NodeAssert.equal(path, "/instance/data/opencode/auth.json");
            return Effect.succeed(
              JSON.stringify({ "opencode-go": { type: "api", key: "instance-key" } }),
            );
          },
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
          NodeAssert.equal(request.headers.authorization, "Bearer instance-key");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usage: {
                  rolling: { percent: 0, resetsAt },
                  weekly: { percent: 10, resetsAt },
                  monthly: { percent: 125, resetsAt },
                },
              }),
            ),
          );
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.equal(
      limits.credentialFingerprint,
      "aba48e85c981a8edc1c9fb4575121accc7235fa55d0f8689f66f153de5566a37",
    );
    NodeAssert.deepEqual(
      limits.windows.map(({ kind, usedPercent, resetsAt: reset }) => ({
        kind,
        usedPercent,
        reset,
      })),
      [
        { kind: "session", usedPercent: 0, reset: resetsAt },
        { kind: "weekly", usedPercent: 10, reset: resetsAt },
        { kind: "monthly", usedPercent: 100, reset: resetsAt },
      ],
    );
  }),
);

it.effect(
  "uses the selected public Console key for Go limits, falling back only on auth rejection",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataHome = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${dataHome}/opencode`);
      yield* fs.writeFileString(
        `${dataHome}/opencode/auth.json`,
        JSON.stringify({ "opencode-go": { type: "api", key: "go-key" } }),
      );
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${dataHome}/opencode/opencode.db`)),
        (database) => Effect.sync(() => database.close()),
      );
      database.exec(
        "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, value text, active integer, time_created integer, time_updated integer)",
      );
      const insert = database.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?)");
      const window = { percent: 1, resetsAt: "2026-09-17T12:00:00.000Z" };
      const consoleKey = { type: "key", key: "console-key" };
      const fingerprints = new Map([
        ["console-key", "3e45cfde9158185930d4cc7020a4e390895574fd54bd8f9631d23a336bbf94f0"],
        ["go-key", "d0e590e93fc9bd9353f2b993c0c287391cae505da2a78cb698b75418d2f5367e"],
        ["inline-key", "85649de18e63305548b6407e185f708483727ee6189cc4bc9512ddb17e23e776"],
      ]);
      for (const {
        consoleRow = consoleKey,
        active = 1,
        consoleStatus = 200,
        inline = false,
        databaseFile,
        requested,
      } of [
        {
          consoleRow: { ...consoleKey, metadata: { server: "https://opencode.ai/console" } },
          requested: ["console-key"],
        },
        { consoleStatus: 401, requested: ["console-key", "go-key"] },
        { consoleStatus: 403, requested: ["console-key", "go-key"] },
        { consoleStatus: 500, requested: ["console-key"] },
        { active: 0, requested: ["go-key"] },
        {
          consoleRow: {
            type: "oauth",
            methodID: "device",
            access: "token",
            refresh: "refresh",
            expires: 0,
          },
          requested: ["go-key"],
        },
        {
          consoleRow: { ...consoleKey, metadata: { server: "https://console.example" } },
          requested: ["go-key"],
        },
        { inline: true, requested: ["inline-key"] },
        { databaseFile: "selected.db", requested: ["console-key"] },
        { databaseFile: ":memory:", requested: ["go-key"] },
        { active: null, requested: ["console-key"] },
      ]) {
        database.exec("DELETE FROM credential");
        insert.run("cred_selected", "opencode", JSON.stringify(consoleRow), active, 2, 2);
        // Legacy selections follow creation order, even when an older key was updated later.
        insert.run(
          "cred_older",
          "opencode",
          JSON.stringify({ type: "key", key: "old-key" }),
          active === null ? null : 0,
          1,
          9,
        );
        insert.run("cred_other", "other", JSON.stringify(consoleKey), 1, 10, 10);
        if (databaseFile === "selected.db") {
          yield* fs.writeFile(
            `${dataHome}/opencode/selected.db`,
            yield* fs.readFile(`${dataHome}/opencode/opencode.db`),
          );
          database
            .prepare("UPDATE credential SET value = ? WHERE id = 'cred_selected'")
            .run(JSON.stringify({ type: "key", key: "old-key" }));
        }
        const before = yield* fs.readFile(`${dataHome}/opencode/opencode.db`);
        const authorizations: string[] = [];
        const limits = yield* readOpenCodeGoUsageLimits({
          enabled: true,
          serverUrl: "",
          environment: {
            XDG_DATA_HOME: dataHome,
            ...(databaseFile !== undefined ? { OPENCODE_DB: databaseFile } : {}),
            ...(inline
              ? { OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-key"}}' }
              : {}),
          },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              NodeAssert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
              const key = (request.headers.authorization ?? "").replace("Bearer ", "");
              authorizations.push(key);
              // The legacy key is expired in the regression; it only works in fallback scenarios.
              const status =
                key === "console-key" ? consoleStatus : requested.includes(key) ? 200 : 401;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    { usage: { rolling: window, weekly: window, monthly: window } },
                    { status },
                  ),
                ),
              );
            }),
          ),
        );
        NodeAssert.deepEqual(authorizations, requested);
        NodeAssert.deepEqual(yield* fs.readFile(`${dataHome}/opencode/opencode.db`), before);
        NodeAssert.equal(
          limits.unavailable?.reason,
          consoleStatus === 500 ? "probeFailed" : undefined,
        );
        NodeAssert.equal(limits.windows.length, consoleStatus === 500 ? 0 : 3);
        NodeAssert.equal(
          limits.credentialFingerprint,
          consoleStatus === 500 ? undefined : fingerprints.get(requested.at(-1)!),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not read local credentials for external or disabled OpenCode instances", () =>
  Effect.gen(function* () {
    for (const settings of [
      { enabled: true, serverUrl: "https://remote.example" },
      { enabled: false, serverUrl: "" },
    ]) {
      const limits = yield* readOpenCodeGoUsageLimits({ ...settings, environment: {} }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("unexpected credential read"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected usage request")),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    }
  }),
);

it.effect("keeps Go entitlement absence distinct from failed or malformed usage responses", () =>
  Effect.gen(function* () {
    for (const [status, reason] of [
      [403, "unsupported"],
      [401, "probeFailed"],
      [200, "probeFailed"],
    ] as const) {
      const limits = yield* readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-key"}}',
        },
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("inline credentials must bypass disk"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status }))),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, reason);
      NodeAssert.equal(limits.credentialFingerprint, undefined);
      NodeAssert.deepEqual(limits.windows, []);
    }
  }),
);

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    runVersionPending: false,
    runVersionDelay: null as Duration.Input | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.runVersionPending = false;
    this.state.runVersionDelay = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
  startOpenCodeServerProcess: () => Effect.die("A provider check must not start a server"),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionPending
      ? Effect.never
      : runtimeMock.state.runVersionError
        ? Effect.fail(
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "runOpenCodeCommand",
              detail: runtimeMock.state.runVersionError.message,
              cause: runtimeMock.state.runVersionError,
            }),
          )
        : runtimeMock.state.runVersionDelay
          ? Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }).pipe(
              Effect.delay(runtimeMock.state.runVersionDelay),
            )
          : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
};

beforeEach(() => {
  runtimeMock.reset();
});

const layerTest = Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

const checkProvider = (
  settings: OpenCodeSettings,
  server = replayOpenCodeServer(OPENCODE_2_RESPONSES, settings.serverPassword),
  openCode2Models: Effect.Effect<
    ReadonlyArray<OpenCode2Model>,
    OpenCodeRuntime.OpenCodeRuntimeError
  > = Effect.succeed([]),
) =>
  checkOpenCodeProviderStatus(
    settings,
    probeOpenCodeRuntime(settings).pipe(
      Effect.provideService(HttpClient.HttpClient, server),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, OpenCodeRuntimeTestDouble),
    ),
    openCode2Models,
  );

it.layer(layerTest)("checkOpenCodeProviderStatus", (it) => {
  it.effect("shows a missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      );
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("times out a hanging local CLI version probe", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionPending = true;
      const probeFiber = yield* checkProvider(makeOpenCodeSettings()).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const snapshot = yield* Fiber.join(probeFiber);

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Failed to execute OpenCode CLI health check: OpenCode CLI version probe timed out after 10 seconds.",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("waits for a slow but healthy local CLI version probe", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionDelay = "6 seconds";
      const probeFiber = yield* checkProvider(makeOpenCodeSettings()).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("6 seconds");
      const snapshot = yield* Fiber.join(probeFiber);

      NodeAssert.notEqual(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.version, "2.0.18");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rejects a local OpenCode 1.x binary", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode 1.14.20\n";
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.match(snapshot.message ?? "", /OpenCode v1\.14\.20 is not supported/);
    }),
  );

  it.effect("lists a local OpenCode 2 binary's models with every runtime mode", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings(),
        undefined,
        Effect.succeed([
          { providerID: "opencode", id: "big-pickle", name: "Big Pickle", variants: [] },
          {
            providerID: "opencode",
            id: "space-bunny-free",
            name: "Space Bunny Free",
            variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
          },
        ]),
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.version, "2.0.18");
      NodeAssert.equal("installedVersion" in snapshot, false);
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      NodeAssert.equal(snapshot.showInteractionModeToggle, true);
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        [],
      );
      NodeAssert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["opencode/big-pickle", "opencode/space-bunny-free"],
      );
      const variant = snapshot.models.find((model) => model.slug === "opencode/space-bunny-free")
        ?.capabilities?.optionDescriptors?.[0];
      NodeAssert.deepEqual(
        variant?.type === "select" ? variant.options.map((option) => option.id) : [],
        ["low", "medium", "high"],
      );
      NodeAssert.equal(
        variant?.type === "select"
          ? variant.options.find((option) => option.isDefault === true)?.id
          : undefined,
        "medium",
      );
    }),
  );

  it.effect("reports a failed OpenCode 2 model list without the server's response", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings(),
        undefined,
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "model.list",
            detail: 'status=500 body={"token":"leaked-response-body"}',
          }),
        ),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.message, "OpenCode could not load its model list.");
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        [],
      );
    }),
  );
});

it.layer(layerTest)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("checks a configured OpenCode 2 server without running the local binary", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("the local binary must not run");
      const settings = makeOpenCodeSettings({
        serverUrl: "http://127.0.0.1:9999",
        serverPassword: "secret-password",
      });
      const snapshot = yield* checkProvider(
        settings,
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
      );

      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.equal(snapshot.version, "2.0.18");
      NodeAssert.equal("installedVersion" in snapshot, false);
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
    }),
  );

  it.effect("labels each model with the sub-provider that listed it", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
        Effect.succeed([
          {
            providerID: "openai",
            id: "gpt-5.4",
            name: "GPT-5.4",
            providerName: "OpenAI",
            variants: [],
          },
          {
            providerID: "custom",
            id: "m1",
            name: "Custom 1",
            providerName: "OpenCode",
            variants: [],
          },
          { providerID: "anthropic", id: "claude", name: "Claude", variants: [] },
        ]),
      );

      const subProviderFor = (slug: string) =>
        snapshot.models.find((model) => model.slug === slug)?.subProvider;
      NodeAssert.equal(subProviderFor("openai/gpt-5.4"), "OpenAI");
      NodeAssert.equal(subProviderFor("custom/m1"), undefined);
      NodeAssert.equal(subProviderFor("anthropic/claude"), "anthropic");
    }),
  );

  it.effect("reports a rejected OpenCode 2 password as an auth error, not a version", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999", serverPassword: "wrong" }),
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("rejects a configured OpenCode 1.x server", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
        replayOpenCodeServer(OPENCODE_1_RESPONSES, ""),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.match(snapshot.message ?? "", /did not identify itself as OpenCode 2/);
    }),
  );

  it.effect("surfaces a friendly connection error for a configured server that hangs", () =>
    Effect.gen(function* () {
      const probeFiber = yield* checkProvider(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        HttpClient.make(() => Effect.never),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const snapshot = yield* Fiber.join(probeFiber);

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

const bigPickle: OpenCode2Model = {
  providerID: "opencode",
  id: "big-pickle",
  name: "Big Pickle",
  variants: [],
};

it.effect("waits for a fresh OpenCode 2 server to list its models", () =>
  Effect.gen(function* () {
    const replies: Array<ReadonlyArray<OpenCode2Model>> = [[], [], [bigPickle]];
    const load = yield* makeOpenCode2ModelLoader(Effect.sync(() => replies.shift() ?? [bigPickle]));
    const fiber = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(yield* Fiber.join(fiber), [bigPickle]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps the last OpenCode 2 model list while a fresh server's stays empty", () =>
  Effect.gen(function* () {
    let listed: ReadonlyArray<OpenCode2Model> = [bigPickle];
    const load = yield* makeOpenCode2ModelLoader(Effect.sync(() => listed));
    const first = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(yield* Fiber.join(first), [bigPickle]);
    listed = [];
    const fiber = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("6 seconds");
    NodeAssert.deepEqual(yield* Fiber.join(fiber), [bigPickle]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("waits for a growing OpenCode 2 catalog to settle before caching it", () =>
  Effect.gen(function* () {
    const first: OpenCode2Model = {
      providerID: "opencode",
      id: "first",
      name: "First",
      variants: [],
    };
    const second: OpenCode2Model = {
      providerID: "opencode",
      id: "second",
      name: "Second",
      variants: [],
    };
    const replies: Array<ReadonlyArray<OpenCode2Model>> = [
      [first],
      [first, second],
      [first, second],
    ];
    const load = yield* makeOpenCode2ModelLoader(
      Effect.sync(() => replies.shift() ?? [first, second]),
    );
    const fiber = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    NodeAssert.ok(fiber.pollUnsafe(), "A settled catalog should finish before the load deadline");
    NodeAssert.deepEqual(yield* Fiber.join(fiber), [first, second]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("waits for OpenCode 2 model names, provider labels, and variants to settle", () =>
  Effect.gen(function* () {
    const renamed = { ...bigPickle, name: "Bigger Pickle" };
    const labeled = { ...renamed, providerName: "OpenCode Zen" };
    const withVariants = { ...labeled, variants: [{ id: "low" }] };
    const complete = { ...labeled, variants: [{ id: "high" }, { id: "medium" }] };
    const reordered = { ...complete, variants: [{ id: "medium" }, { id: "high" }] };
    const replies = [[bigPickle], [renamed], [labeled], [withVariants], [complete], [reordered]];
    const load = yield* makeOpenCode2ModelLoader(Effect.sync(() => replies.shift() ?? [complete]));
    const fiber = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("1500 millis");
    NodeAssert.ok(
      fiber.pollUnsafe(),
      "Equivalent variant orders should settle before the deadline",
    );
    NodeAssert.deepEqual(yield* Fiber.join(fiber), [reordered]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("bounds an unsettled OpenCode 2 catalog and keeps its latest nonempty observation", () =>
  Effect.gen(function* () {
    let reads = 0;
    let latest: ReadonlyArray<OpenCode2Model> = [];
    const changing = () => {
      latest = [{ ...bigPickle, name: `Pickle ${++reads}` }];
      return latest;
    };
    let list = changing;
    const load = yield* makeOpenCode2ModelLoader(Effect.sync(() => list()));
    const cold = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    NodeAssert.ok(cold.pollUnsafe());
    NodeAssert.ok(reads > 1);
    NodeAssert.deepEqual(yield* Fiber.join(cold), latest);

    list = () => [];
    const empty = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    NodeAssert.ok(empty.pollUnsafe());
    NodeAssert.deepEqual(yield* Fiber.join(empty), latest);

    list = () => [bigPickle];
    const settled = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(yield* Fiber.join(settled), [bigPickle]);

    reads = 0;
    list = () => (reads++ === 0 ? [bigPickle] : changing());
    const fresh = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    NodeAssert.ok(fresh.pollUnsafe());
    NodeAssert.ok(reads > 1);
    NodeAssert.deepEqual(yield* Fiber.join(fresh), latest);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "refreshes a warm OpenCode 2 catalog when slow reads cannot settle before the deadline",
  () =>
    Effect.gen(function* () {
      let listed: ReadonlyArray<OpenCode2Model> = [bigPickle];
      let slow = false;
      const load = yield* makeOpenCode2ModelLoader(
        Effect.gen(function* () {
          if (slow) yield* Effect.sleep("3 seconds");
          return listed;
        }),
      );
      const warm = yield* load.pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      NodeAssert.deepEqual(yield* Fiber.join(warm), [bigPickle]);

      listed = [{ ...bigPickle, name: "Fresh Pickle" }];
      slow = true;
      const fresh = yield* load.pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      NodeAssert.ok(fresh.pollUnsafe());
      NodeAssert.deepEqual(yield* Fiber.join(fresh), listed);
    }).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "keeps a fresh OpenCode 2 observation if confirmation fails but propagates an initial failure",
  () =>
    Effect.gen(function* () {
      const error = new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "model.list",
        detail: "Model list failed",
      });
      let reads = 0;
      const load = yield* makeOpenCode2ModelLoader(
        Effect.suspend(() => (reads++ === 0 ? Effect.succeed([bigPickle]) : Effect.fail(error))),
      );
      const fresh = yield* load.pipe(Effect.forkChild);
      yield* TestClock.adjust("250 millis");
      NodeAssert.deepEqual(yield* Fiber.join(fresh), [bigPickle]);
      NodeAssert.equal(yield* load.pipe(Effect.flip), error);
    }).pipe(Effect.provide(TestClock.layer())),
);

const builtinCommands = [
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
];
const builtinSkills = [
  { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md" },
  { id: "report", name: "Report", path: "/builtin/report.md" },
];
const scanned: OpenCode2Workspace = {
  commands: [...builtinCommands, { name: "hello", description: "Say hello to the workspace" }],
  skills: [
    ...builtinSkills,
    {
      id: "greet",
      name: "greet",
      path: "/work/.opencode/skills/greet/SKILL.md",
      description: "Greets the user with the secret word MANGO.",
    },
  ],
};

it.effect("reads a fresh OpenCode 2 directory again once its scan has ended", () =>
  Effect.gen(function* () {
    const reads: Array<OpenCode2Workspace> = [{ commands: [], skills: [] }, scanned];
    const scanEnded = yield* Deferred.make<void>();
    const load = yield* loadOpenCode2Workspace(
      Effect.sync(() => reads.shift()!),
      Deferred.await(scanEnded),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    NodeAssert.equal(reads.length, 1);
    yield* Deferred.succeed(scanEnded, undefined);
    NodeAssert.deepEqual(yield* Fiber.join(load), scanned);
  }),
);

it.effect("takes a served OpenCode 2 directory's first listing as is", () =>
  Effect.gen(function* () {
    const workspace = yield* loadOpenCode2Workspace(Effect.succeed(scanned), Effect.never);
    NodeAssert.deepEqual(workspace, scanned);
  }),
);

it("lists an OpenCode 2 directory's skills by id and its commands once each", () => {
  NodeAssert.deepEqual(
    openCode2SkillsToServerProviderSkills(scanned.skills).map((skill) => [
      skill.name,
      skill.displayName,
      skill.path,
    ]),
    [
      ["greet", undefined, "/work/.opencode/skills/greet/SKILL.md"],
      ["opencode", "OpenCode", "/builtin/opencode.md"],
      ["report", "Report", "/builtin/report.md"],
    ],
  );
  NodeAssert.deepEqual(
    openCode2CommandsToServerProviderSlashCommands([
      ...scanned.commands,
      { name: "init", description: "a second workspace command with the same name" },
    ]).map((command) => command.name),
    ["init", "review", "hello"],
  );
});
