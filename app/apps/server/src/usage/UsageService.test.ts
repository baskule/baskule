// @effect-diagnostics nodeBuiltinImport:off -- integration fixtures use native Node I/O.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as UsageService from "./UsageService.ts";
// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.

vi.mock("node:fs/promises", { spy: true });

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: NodePath.join(home, "claude") },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: NodePath.join(home, "codex") },
        },
      },
    },
  };
});

const layerService = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: (request: HttpClientRequest.HttpClientRequest) => void;
  readonly ratesDocument?: unknown;
  readonly ratesStatus?: () => number;
  readonly ratesResponse?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}) =>
  Layer.empty.pipe(
    Layer.provideMerge(Layer.empty),
    Layer.provideMerge(ProviderHostLive.layer),
    Layer.provideMerge(Layer.empty),
    Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), NodePath.join(input.home, input.prefix)),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, input.platform ?? "linux")),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.suspend(() => {
            input.onRatesFetch?.(request);
            const response = input.ratesResponse
              ? input.ratesResponse(request)
              : Effect.succeed(
                  Response.json(input.ratesDocument ?? {}, {
                    status: input.ratesStatus?.() ?? 200,
                  }),
                );
            return response.pipe(
              Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
            );
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcess.Environment, {
        HOME: input.home,

        OPENCODE_DATA_DIR: NodePath.join(input.home, "opencode"),

        XDG_CONFIG_HOME: NodePath.join(input.home, "config"),
        APPDATA: NodePath.join(input.home, "config"),
        ...input.environment,
      }),
    ),
  );

/**
 * Each waiting gate holds one libuv pool thread; keep at most three.
 */

describe("UsageService", () => {
  it.live("includes host and merged OpenCode instance histories once across list aliases", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const hostRoot = NodePath.join(home, "opencode");
      const instanceRoot = NodePath.join(home, "opencode-work");
      const alias = NodePath.join(home, "opencode-alias");
      const dataHome = NodePath.join(home, "data");
      const xdgRoot = NodePath.join(dataHome, "opencode");
      const histories = [
        { root: hostRoot, id: "host", output: 5 },
        { root: instanceRoot, id: "work", output: 7 },
        { root: xdgRoot, id: "xdg", output: 11 },
      ];
      yield* Effect.promise(async () => {
        for (const { root, id, output } of histories) {
          await NodeFSP.mkdir(root, { recursive: true });
          const db = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencode.db"));
          try {
            db.exec(
              "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)",
            );
            const created = Date.parse("2026-08-01T10:00:00Z");
            db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
              id,
              "session-1",
              "assistant",
              encodeUnknownJsonString({
                model: { modelID: "example-model" },
                tokens: { input: 10, output },
              }),
              created,
            );
          } finally {
            db.close();
          }
        }
        await NodeFSP.symlink(instanceRoot, alias, "junction");
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-opencode-instances",
            home,
            environment: { XDG_DATA_HOME: dataHome },
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("opencode-work")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  environment: [
                    {
                      name: "OPENCODE_DATA_DIR",
                      value: ` ${instanceRoot}, ${alias} `,
                      sensitive: false,
                    },
                  ],
                },
                [ProviderInstanceId.make("opencode-xdg")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  environment: [{ name: "OPENCODE_DATA_DIR", value: "", sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const sources = summary.sources.filter(
        (source) => source.fingerprint.provider === "opencode",
      );
      const expectedRoots = yield* Effect.promise(() =>
        Promise.all(histories.map(({ root }) => NodeFSP.realpath(root))),
      );
      assert.deepStrictEqual(
        sources.map((source) => source.fingerprint.resolvedHomePath).sort(),
        expectedRoots.sort(),
      );
      assert.deepStrictEqual(
        summary.buckets
          .filter((bucket) => bucket.provider === "opencode")
          .map((bucket) => bucket.totals.outputTokens)
          .sort((a, b) => a - b),
        [5, 7, 11],
      );
    }).pipe(Effect.scoped),
  );

  it.live("tries the GitHub API after the primary pricing request times out", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const primaryStarted = yield* Deferred.make<void>();
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-rates-timeout-test",
            home,
            settings,
            ratesResponse: (request) =>
              request.url.startsWith("https://api.github.com/")
                ? Effect.succeed(
                    Response.json({
                      "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
                    }),
                  )
                : Deferred.succeed(primaryStarted, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      );
      const refresh = yield* service.refreshRates.pipe(Effect.forkChild);
      yield* Deferred.await(primaryStarted);
      yield* TestClock.adjust(Duration.seconds(10));
      const pricing = yield* Fiber.join(refresh);
      assert.strictEqual(pricing.status, "fresh");
      assert.strictEqual(pricing.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("keeps pricing unavailable when neither download has usable rates", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-rates-empty-test", home, settings })),
      );
      const pricing = yield* service.refreshRates;
      assert.strictEqual(pricing.status, "unavailable");
      assert.isNull(pricing.fetchedAt);
    }).pipe(Effect.scoped),
  );

  it.live.each([false, true])(
    "throttles failed pricing loads from completion with cached rates: %s",
    (hasCachedRates) =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        const primaryStarted = yield* Deferred.make<void>();
        const fallbackStarted = yield* Deferred.make<void>();
        let responding = true;
        let requests = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-rates-retry-floor-test",
              home,
              settings,
              onRatesFetch: () => {
                requests += 1;
              },
              ratesResponse: (request) =>
                responding
                  ? Effect.succeed(
                      Response.json({
                        "claude-fable-5": {
                          input_cost_per_token: 1e-5,
                          output_cost_per_token: 5e-5,
                        },
                      }),
                    )
                  : Deferred.succeed(
                      request.url.startsWith("https://api.github.com/")
                        ? fallbackStarted
                        : primaryStarted,
                      undefined,
                    ).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        );
        let fetchedAt: string | null = null;
        if (hasCachedRates) {
          fetchedAt = (yield* service.refreshRates).fetchedAt;
          yield* TestClock.adjust(Duration.hours(24));
        }
        responding = false;
        const refresh = yield* service.refreshRates.pipe(Effect.forkChild);
        yield* Deferred.await(primaryStarted);
        yield* TestClock.adjust(Duration.seconds(10));
        yield* Deferred.await(fallbackStarted);
        yield* TestClock.adjust(Duration.seconds(10));
        const failed = yield* Fiber.join(refresh);
        const expectedStatus = hasCachedRates ? "cached" : "unavailable";
        assert.strictEqual(failed.status, expectedStatus);
        assert.strictEqual(failed.fetchedAt, fetchedAt);
        const requestsAfterFailure = requests;
        assert.strictEqual(requestsAfterFailure, hasCachedRates ? 3 : 2);

        responding = true;
        const [immediate, summary] = yield* Effect.all(
          [service.refreshRates, service.readSummary(WINDOW)],
          { concurrency: 2 },
        );
        assert.strictEqual(immediate.status, expectedStatus);
        assert.strictEqual(summary.pricing.status, expectedStatus);
        assert.strictEqual(requests, requestsAfterFailure);
        yield* TestClock.adjust(Duration.seconds(59));
        const coolingDown = yield* service.refreshRates;
        assert.strictEqual(coolingDown.status, expectedStatus);
        assert.strictEqual(coolingDown.fetchedAt, fetchedAt);
        assert.strictEqual(requests, requestsAfterFailure);

        yield* TestClock.adjust(Duration.seconds(1));
        const recovered = yield* service.refreshRates;
        assert.strictEqual(recovered.status, "fresh");
        assert.strictEqual(recovered.knownModels, 1);
        assert.notStrictEqual(recovered.fetchedAt, fetchedAt);
        assert.strictEqual(requests, requestsAfterFailure + 1);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-interruption-test", home, settings })),
      );

      let orphanedAt: number | undefined;
      // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- Fixed-count scheduler interruption matrix; each iteration exercises a different interruption point.
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});
