// @effect-diagnostics globalFetch:off globalDate:off -- workerd lifecycle callbacks use native platform I/O and timestamps.
import * as DocumentText from "../../provider/DocumentText.ts";
import { BaskulePushHost, currentPushNotification } from "../push.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { OrchestrationEffectWorkerV2 } from "../../orchestration-v2/EffectWorker.ts";
import type { PushNotification } from "@t3tools/contracts/baskulePush";
type BrowserSocket = WebSocket & { accept(): void };
declare const WebSocketPair: { new (): { 0: BrowserSocket; 1: BrowserSocket } };
import { endpoint as browserEndpoint, stateLayer as browserStateLayer } from "../browser/remote.ts";
// baskule: one T3 runtime per SpaceCell; all configuration and runtime state belong to that space.
// - Shared DO SQL via InjectedSqlClient; DO home/chat records and computerd files via FileSystem.
// - Captured HTTP/WebSocket transport; front identity auth; RPC and route allowlists; no host processes.
// - OpenCode uses the same-cell agentFetch. SpaceCell owns boot, keepalive, multiplexed alarms and disposal.
import "./runtimeGlobals.ts";
import { makeRuntimeScheduler } from "./runtimeScheduler.ts";

import { CommandId, ThreadId } from "@t3tools/contracts";
import { ManagedOpenCodeRuntime } from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import { Etag, FetchHttpClient, HttpPlatform, HttpRouter } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../../auth/SessionStore.ts";
import { revokeFrontSessions } from "../../auth/BaskuleFrontAuth.ts";
import * as CloudLink from "../../cloud/CloudLink.ts";
import * as ConnectReachability from "../../cloud/ConnectReachability.ts";
import * as RelayTracing from "../../cloud/relayTracing.ts";
import * as ServiceLauncherClient from "../../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as AgentScopeLive from "../../process/agentScope.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  layerApplicationObservability,
  layerMakeRoutes,
  layerRuntimeDependencies,
} from "../../server.ts";
import * as ServerActivation from "../../serverActivation.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { BASKULE_IDENTITY_HEADER, parseBaskuleIdentity } from "../identity.ts";
import { registerAttachmentRoot } from "../attachmentFs.ts";
import { HostFileSystem } from "../HostFileSystem.ts";
import { InjectedSqlClient } from "../BaskulePersistence.ts";
import * as McpDeferredRegistrations from "../mcpDeferredRegistrations.ts";
import { BASKULE_POLICY, BaskuleRpcPolicy } from "../rpcPolicy.ts";
import { makeComputerFs } from "./computerFs.ts";
import * as DoSql from "./doSqlClient.ts";
import { makeSpaceFileSystem } from "./fileSystem.ts";
import { makeHostFileSystem } from "./hostFileSystem.ts";
import { managedSettingsJson } from "./managedSettings.ts";
import { classifyRoute } from "./routes.ts";
import { handleUpgrade, keepAlive, makeTransport } from "./transport.ts";

/** Where the cell keeps T3's home, and where the space computer keeps chats. */
/** T3's home of each space, `${SPACES_HOME}/<spaceId>`: unique per space within an isolate. */
export const SPACES_HOME = "/baskule/spaces";
export const SANDBOX_ROOT = "/sandbox";
export const CHATS_ROOT = "/sandbox/space/chats";
export const AGENT_ORIGIN = "http://agent";

// Some T3 code paths (title generation, provider refresh, effects resumed in another runtime) reach OpenCode with
// the isolate's global fetch instead of the Fetch service provided below. Spaces share an isolate, so the agent URL
// carries the space id (`http://agent/<spaceId>/oc/...`) and one isolate-wide router sends it to the right AgentCell.
const agentRoutes = new Map<string, (request: Request) => Promise<Response>>();
let globalFetchRouted = false;
const routeAgentRequest = (request: Request): Promise<Response> | undefined => {
  const url = new URL(request.url);
  if (url.origin !== AGENT_ORIGIN) return undefined;
  const [, encodedSpace, ...rest] = url.pathname.split("/");
  const route = encodedSpace ? agentRoutes.get(decodeURIComponent(encodedSpace)) : undefined;
  if (!route) return Promise.resolve(new Response("unknown agent route", { status: 502 }));
  url.pathname = `/${rest.join("/")}`;
  return route(new Request(url, request));
};
const installGlobalAgentRouter = () => {
  if (globalFetchRouted) return;
  globalFetchRouted = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: Parameters<typeof original>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    return routeAgentRequest(request) ?? original(request);
  }) as typeof globalThis.fetch;
};

export interface SpaceServerConfig {
  readonly push?: {
    deliver: (notification: PushNotification, environmentId: string) => Promise<void>;
    changed: () => Promise<void>;
  };
  readonly spaceId: string;
  readonly storage: DoSql.DoSqlStorage;
  /** Shared with embedded OpenCode: one SQLite connection must have one transaction gate. */
  readonly database?: DoSql.DoSqlClient;
  /** Requests for `http://agent/...` (T3's OpenCode provider) go here: the AgentCell stub. */
  readonly agentFetch: (request: Request) => Promise<Response>;
  readonly computerdUrl?: string | undefined;
  readonly computerdToken?: string | undefined;
  /** OTLP/HTTP traces endpoint for this server's spans; undefined: no export. */
  readonly otlpTracesUrl?: string | undefined;
  /** The installation's one model: OpenCode provider id and model id (ControlCell settings). */
  readonly llmModel: string;
  readonly llmProviderId: string;
  readonly logLevel?: "Debug" | "Info" | "Warn" | "Error" | undefined;
  /** Called with a socket's close function when it opens; returns the release for its close. */
  readonly onSocketOpen?: (() => () => void) | undefined;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** The app's public origin (first of PUBLIC_ORIGINS), for absolute webhook URLs; else relative. */
  readonly publicOrigin?: string | undefined;
  /** The cell's storage moved to another celld node: the host should dispose this server. */
  readonly onStorageLost?: (() => void) | undefined;
}

export interface SpaceSocket {
  readonly userId: string;
  readonly sessionId: string;
  close(code: number, reason: string): void;
}

export interface SpaceServer {
  readonly bootMs: number;
  readonly sqlStats: DoSql.DoSqlStats;
  /** A request with the `/s/<spaceId>` prefix already stripped by the Worker. */
  fetch(request: Request): Promise<Response>;
  sockets(): ReadonlyArray<SpaceSocket>;
  /** Revokes the T3 sessions of a user or Worker session, and closes their sockets (4401). */
  revoke(target: {
    readonly userId?: string;
    readonly sessionId?: string;
  }): Promise<{ readonly revoked: number; readonly closed: number }>;
  /** Runs that are not finished (preparing, queued, starting, running, waiting). */
  activeRuns(): number;
  isPushCurrent(eventId: string, threadId: string): Promise<boolean>;
  drainPushEffects(): Promise<void>;
  /** The next time a scheduled task or a snoozed chat is due, in epoch ms. */
  nextWakeAt(): number | null;
  /** Stops every thread with an active run. Returns the number of threads stopped. */
  stopActiveRuns(reason: string): Promise<number>;
  /**
   * Returns the chats whose snooze is due to the inbox (unsnoozed and marked unread), so every member and device sees
   * them back, including when no client was connected at the due time (the host calls this from its alarm).
   */
  wakeDueSnoozes(): Promise<number>;
  /** Interrupts every fiber and releases the runtime; the storage is kept. */
  dispose(): Promise<void>;
}

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"] as const;
const REVOKED_CLOSE_CODE = 4401;

const notFoundSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        pathOrDescriptor: "command" in command ? String(command.command) : "pipeline",
        description: "A space cell runs no processes; tools run on the space computer.",
      }),
    ),
  ),
);

const noTerminal = Layer.succeed(
  Terminal.Terminal,
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.never,
    readLine: Effect.never,
    display: () => Effect.void,
  }),
);

const serverConfigFor = (
  baseDir: string,
  logLevel: ServerConfig.ServerConfig["Service"]["logLevel"],
  traces: { readonly otlpTracesUrl: string | undefined; readonly spaceId: string },
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
        baseDirIsExplicit: true,
      });
      yield* ServerConfig.ensureServerDirectories(paths);
      return ServerConfig.ServerConfig.of({
        ...paths,
        // With export on, every Info span also passes through the local trace file: keep it in the
        // cell's memory (/tmp) instead of its replicated SQLite.
        ...(traces.otlpTracesUrl ? { serverTracePath: "/tmp/server.trace.ndjson" } : {}),
        logLevel,
        // Exported spans need Info; without export, only warnings reach the small local trace file.
        traceMinLevel: traces.otlpTracesUrl ? "Info" : "Warn",
        // Without timing, Effect stamps every span 0..1 ns: exported spans would have no time.
        traceTimingEnabled: traces.otlpTracesUrl !== undefined,
        traceBatchWindowMs: 1000,
        // Logs live in DO SQLite with the rest of T3's home: keep them small.
        traceMaxBytes: 256 * 1024,
        traceMaxFiles: 2,
        otlpTracesUrl: traces.otlpTracesUrl,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        // Every space reports as its own host in the trace backend.
        otelEnvironment: {
          ...OtelEnvironment.none,
          resourceAttributes: { "host.name": `space-${traces.spaceId}` },
        },
        mode: "web",
        port: 443,
        host: undefined,
        cwd: baseDir,
        baseDir,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

export const createSpaceSqlClient = async (
  storageInput: DoSql.DoSqlStorage,
  onStorageLost?: () => void,
): Promise<DoSql.DoSqlClient> => {
  // celld can hand an idle cell to another node while this runtime's fibers still run here
  // ("no db for <cell>"): this copy then stops for good and the new owner boots its own.
  let storageLost = false;
  const storage: DoSql.DoSqlStorage = {
    transaction: (closure) => storageInput.transaction(closure),
    sql: {
      get databaseSize() {
        return storageInput.sql.databaseSize;
      },
      exec: (query, ...bindings) => {
        try {
          return storageInput.sql.exec(query, ...bindings);
        } catch (error) {
          if (!storageLost && /no db for/i.test(String(error))) {
            storageLost = true;
            queueMicrotask(() => onStorageLost?.());
          }
          throw error;
        }
      },
    },
  };
  return Effect.runPromise(DoSql.make(storage));
};

export const createSpaceServer = async (config: SpaceServerConfig): Promise<SpaceServer> => {
  const startedAt = performance.now();
  const { client: sqlClient, stats: sqlStats } =
    config.database ?? (await createSpaceSqlClient(config.storage, config.onStorageLost));
  const sqlLayer = Layer.succeed(SqlClient.SqlClient, sqlClient);

  const computer =
    config.computerdUrl && config.computerdToken
      ? makeComputerFs({
          baseUrl: config.computerdUrl,
          token: config.computerdToken,
          spaceId: config.spaceId,
        })
      : undefined;
  const baseDir = `${SPACES_HOME}/${config.spaceId}`;
  const attachmentsDir = `${baseDir}/userdata/attachments`;
  const files = makeSpaceFileSystem({
    storage: config.storage,
    baseDir,
    sandboxRoot: SANDBOX_ROOT,
    chatsRoot: CHATS_ROOT,
    computer,
  });

  // Installation-managed settings: rewritten at every boot, read-only to members (RPC policy).
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* files.fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* files.fileSystem.writeFileString(
        `${baseDir}/userdata/settings.json`,
        managedSettingsJson({
          agentUrl: `${AGENT_ORIGIN}/${encodeURIComponent(config.spaceId)}/oc`,
          model: config.llmModel,
          providerId: config.llmProviderId,
        }),
      );
      yield* files.fileSystem.writeFileString(`${baseDir}/userdata/keybindings.json`, "[]");
    }),
  );

  installGlobalAgentRouter();
  agentRoutes.set(config.spaceId, config.agentFetch);
  const agentFetch: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(new Request(input, init));

  const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, files.fileSystem);
  const hostFileSystem = makeHostFileSystem(files, baseDir, computer);
  const unregisterAttachments = registerAttachmentRoot(attachmentsDir, {
    existsSync: (path) => files.homeSync.stat(path) !== undefined,
    readdirSync: (path) => [...files.homeSync.list(path)],
    statSync: (path) => {
      const info = files.homeSync.stat(path);
      if (!info) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return { mtimeMs: info.mtimeMs };
    },
    unlinkSync: (path) => files.homeSync.remove(path),
  });
  const transport = makeTransport();
  const configProvider = ConfigProvider.fromEnvRecord({
    BASKULE: "1",
    BASKULE_AUTH_MODE: "front",
    BASKULE_SCRATCH_ROOT: CHATS_ROOT,
    // Public webhook URLs: `<origin>/hooks/<spaceId>/<taskId>/<token>` (the Worker forwards them
    // to `/api/hooks/…`). Relative to the app origin, which the cell does not know.
    BASKULE_WEBHOOK_BASE: `${config.publicOrigin ?? ""}/hooks/${config.spaceId}`,
    // T3's MCP server (its task tools) as the space's agent reaches it: the AgentCell routes this
    // reserved host to this space's cell (platform/src/agent/space-bridge.ts).
    BASKULE_MCP_ENDPOINT: `http://baskule-space.internal/${encodeURIComponent(config.spaceId)}/mcp`,
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_HOME: baseDir,
  });
  const logLevel = config.logLevel ?? "Warn";

  const push = config.push;
  const platform = Layer.mergeAll(
    Layer.succeed(
      BaskulePushHost,
      push
        ? {
            changed: push.changed,
            deliver: async (notification) => {
              const environmentId = new TextDecoder()
                .decode(await files.primitives.readAll(`${baseDir}/userdata/environment-id`))
                .trim();
              if (!environmentId) throw new Error("Space environment identity unavailable");
              await push.deliver(notification, environmentId);
            },
          }
        : undefined,
    ),
    config.computerdUrl && config.computerdToken
      ? browserStateLayer({
          url: config.computerdUrl,
          token: config.computerdToken,
          spaceId: config.spaceId,
        })
      : Layer.empty,
    Layer.succeed(InjectedSqlClient, sqlLayer),
    Layer.succeed(BaskuleRpcPolicy, BASKULE_POLICY),
    // T3's MCP tools are described on the agent's first /mcp request, not at boot.
    McpDeferredRegistrations.layer,
    Layer.succeed(FetchHttpClient.Fetch, agentFetch),
    // AgentCell embeds this runtime; a transient discovery error must never select legacy v1.
    Layer.succeed(ManagedOpenCodeRuntime, { version: "2.1.3" }),
    Layer.succeed(HostFileSystem, hostFileSystem),
    sqlLayer,
    fileSystemLayer,
    Path.layer,
    NodeCrypto.layer,
    notFoundSpawner,
    transport.layer,
    HttpPlatform.layer.pipe(Layer.provide(fileSystemLayer), Layer.provide(Etag.layer)),
    Etag.layer,
    Stdio.layerTest({}),
    noTerminal,
    FetchHttpClient.layer,
    ConfigProvider.layer(configProvider),
    Layer.succeed(References.MinimumLogLevel, logLevel),
  );
  const serverConfig = serverConfigFor(baseDir, logLevel, {
    otlpTracesUrl: config.otlpTracesUrl,
    spaceId: config.spaceId,
  }).pipe(Layer.provide(platform));

  const activation = Effect.runSync(Deferred.make<void>());
  const routesReady = Effect.runSync(Deferred.make<void>());
  const deps = layerRuntimeDependencies.pipe(
    Layer.provideMerge(DocumentText.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(AgentScopeLive.layer),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(
      McpSessionRegistry.layer.pipe(
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
      ),
    ),
    Layer.provideMerge(RelayTracing.layerServerRelayBroker),
  );
  const routes = HttpRouter.serve(
    layerMakeRoutes.pipe(Layer.provide(ServiceLauncherClient.layer)),
    {
      disableLogger: true,
      routerConfig: { maxParamLength: 512 },
    },
  ).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined)));
  const listening = Layer.effectDiscard(
    Effect.flatMap(
      ServerRuntimeStartup.ServerRuntimeStartup,
      (startup) => startup.markHttpListening,
    ),
  );
  const app = Layer.mergeAll(routes, listening).pipe(
    Layer.provide(CloudLink.layer.pipe(Layer.provideMerge(ConnectReachability.layer))),
    Layer.provideMerge(
      ServerRuntimeStartup.layerWithOptions({
        activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
        abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
        awaitAuxiliaryParked: Deferred.await(routesReady),
      }).pipe(Layer.provide(ServiceLauncherClient.layer)),
    ),
    Layer.provideMerge(deps),
    Layer.provide(Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation))),
    Layer.provide(layerApplicationObservability),
    Layer.provideMerge(serverConfig),
    Layer.provideMerge(platform),
    // Retain the scheduler in the captured HTTP context as well as all shared services.
    Layer.provideMerge(makeRuntimeScheduler()),
  );

  const scope = Effect.runSync(Scope.make());
  const built = await Effect.runPromiseExit(
    Layer.buildWithScope(app, scope).pipe(Effect.provide(Logger.layer([Logger.consolePretty()]))),
  );
  if (Exit.isFailure(built)) {
    unregisterAttachments();
    if (agentRoutes.get(config.spaceId) === config.agentFetch) agentRoutes.delete(config.spaceId);
    await Effect.runPromise(Scope.close(scope, built));
    throw new Error(`The space server failed to start: ${String(built.cause).slice(0, 2000)}`);
  }
  const context = built.value as Context.Context<never>;
  const captured = await transport.ready;
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromiseWith(context as Context.Context<R>)(effect);

  const sockets = new Set<SpaceSocket>();
  const sql = (query: string, ...params: ReadonlyArray<unknown>) => {
    const rows: Array<ReadonlyArray<unknown>> = [];
    for (const row of config.storage.sql.exec(query, ...params).raw()) rows.push(row);
    return rows;
  };
  const activeStatuses = ACTIVE_RUN_STATUSES.map((s) => `'${s}'`).join(", ");

  const server: SpaceServer = {
    bootMs: Math.round(performance.now() - startedAt),
    sqlStats,
    fetch: async (request) => {
      const url = new URL(request.url);
      const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      // The Worker already checked session, membership and Origin. Retain identity on the
      // viewer socket so revocation closes the browser just like the main RPC connection.
      if (/^\/api\/preview-stream\/(ws|download|upload)$/.test(url.pathname)) {
        const identity = parseBaskuleIdentity(request.headers.get(BASKULE_IDENTITY_HEADER));
        if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!config.computerdUrl || !config.computerdToken)
          return Response.json({ error: "computer unavailable" }, { status: 503 });
        const route = url.pathname.split("/").at(-1)!;
        if (
          route === "ws"
            ? !upgrade || request.method !== "GET"
            : request.method !== (route === "upload" ? "POST" : "GET")
        )
          return new Response(null, { status: 405 });
        const upstream = await fetch(
          browserEndpoint(
            { url: config.computerdUrl, token: config.computerdToken, spaceId: config.spaceId },
            route,
          ) + url.search,
          {
            method: request.method,
            headers: {
              authorization: `Bearer ${config.computerdToken}`,
              ...(upgrade ? { upgrade: "websocket" } : {}),
              ...(request.headers.has("content-type")
                ? { "content-type": request.headers.get("content-type")! }
                : {}),
            },
            ...(request.method === "POST" ? { body: request.body } : {}),
          },
        );
        if (!upgrade || upstream.status !== 101) return upstream;
        const remote = (upstream as Response & { webSocket: BrowserSocket }).webSocket;
        const pair = new WebSocketPair();
        const local = pair[1];
        remote.accept();
        local.accept();
        const releaseKeepAlive = keepAlive();
        const releaseHost = config.onSocketOpen?.() ?? (() => {});
        const entry: SpaceSocket = {
          userId: identity.userId,
          sessionId: identity.sessionId,
          close: (code, reason) => {
            local.close(code, reason);
            remote.close(code, reason);
          },
        };
        sockets.add(entry);
        let closed = false;
        const done = (event?: { readonly code: number; readonly reason: string }) => {
          if (closed) return;
          closed = true;
          sockets.delete(entry);
          releaseKeepAlive();
          releaseHost();
          try {
            const code = event && ![1005, 1006, 1015].includes(event.code) ? event.code : 1000;
            local.close(code, event?.reason);
            remote.close(code, event?.reason);
          } catch {}
        };
        for (const [from, to] of [
          [local, remote],
          [remote, local],
        ] as const) {
          from.addEventListener("message", (event) => {
            try {
              to.send(event.data);
            } catch {
              done();
            }
          });
          from.addEventListener("close", done);
          from.addEventListener("error", () => done());
        }
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
      }
      const decision = classifyRoute(request.method, url.pathname, upgrade);
      if (!decision.allow) {
        return Response.json(
          { error: "unsupported_in_baskule", message: decision.reason },
          { status: decision.status },
        );
      }
      if (!upgrade) return captured.handler(request);
      const identity = parseBaskuleIdentity(request.headers.get(BASKULE_IDENTITY_HEADER));
      return handleUpgrade(captured, request, {
        waitUntil: config.waitUntil,
        onOpen: (closeSocket) => {
          const releaseKeepAlive = keepAlive();
          const releaseHost = config.onSocketOpen?.() ?? (() => {});
          const entry: SpaceSocket = {
            userId: identity?.userId ?? "",
            sessionId: identity?.sessionId ?? "",
            close: (code, reason) => {
              closeSocket(code, reason);
            },
          };
          sockets.add(entry);
          return () => {
            sockets.delete(entry);
            releaseKeepAlive();
            releaseHost();
          };
        },
      });
    },
    sockets: () => Array.from(sockets),
    revoke: async (target) => {
      const revoked = await run(
        Effect.flatMap(Effect.service(SessionStore.SessionStore), (sessions) =>
          revokeFrontSessions(sessions, target),
        ),
      );
      let closed = 0;
      for (const socket of sockets) {
        if (
          (target.userId && socket.userId === target.userId) ||
          (target.sessionId && socket.sessionId === target.sessionId)
        ) {
          socket.close(REVOKED_CLOSE_CODE, "revoked");
          closed++;
        }
      }
      return { revoked, closed };
    },
    isPushCurrent: async (eventId, threadId) => {
      const candidate = await run(
        Effect.flatMap(ProjectionStoreV2, (store) =>
          currentPushNotification(ThreadId.make(threadId), store),
        ),
      );
      return candidate?.eventId === eventId;
    },
    drainPushEffects: async () => {
      await run(Effect.flatMap(OrchestrationEffectWorkerV2, (worker) => worker.drain(64)));
    },
    activeRuns: () =>
      Number(
        sql(
          `SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN (${activeStatuses})`,
        )[0]?.[0] ?? 0,
      ),
    nextWakeAt: () => {
      const [task] = sql(
        "SELECT min(next_run_at) FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL",
      );
      const [snooze] = sql(
        "SELECT min(json_extract(payload_json, '$.snoozedUntil')) FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json, '$.snoozedUntil') > ?",
        new Date().toISOString(),
      );
      const [push] = sql(
        "SELECT min(CASE WHEN status='running' THEN lease_expires_at ELSE available_at END) FROM orchestration_v2_effect_outbox WHERE effect_type='baskule.push' AND status IN ('pending','running')",
      );
      const times = [task?.[0], snooze?.[0], push?.[0]]
        .filter((v): v is string => typeof v === "string")
        .map((v) => Date.parse(v))
        .filter((v) => Number.isFinite(v));
      return times.length === 0 ? null : Math.min(...times);
    },
    stopActiveRuns: async (reason) => {
      const threads = sql(
        `SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs WHERE status IN (${activeStatuses})`,
      ).map((r) => String(r[0]));
      for (const threadId of threads) {
        await run(
          ThreadMessageIntake.dispatchCommand({
            type: "thread.stop",
            commandId: CommandId.make(`baskule-stop:${threadId}:${Date.now()}`),
            threadId: ThreadId.make(threadId),
            reason,
          }).pipe(Effect.ignore),
        );
      }
      return threads.length;
    },
    wakeDueSnoozes: async () => {
      const due = sql(
        "SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json, '$.snoozedUntil') IS NOT NULL AND json_extract(payload_json, '$.snoozedUntil') <= ?",
        new Date().toISOString(),
      ).map((r) => String(r[0]));
      for (const threadId of due) {
        const at = Date.now();
        for (const command of [
          // Mark unread first: a crash between commands leaves the snooze due, so the next alarm retries it.
          { type: "thread.mark-unread" as const },
          { type: "thread.unsnooze" as const, reason: "user" as const },
        ]) {
          await run(
            ThreadMessageIntake.dispatchCommand({
              ...command,
              commandId: CommandId.make(`baskule-snooze-wake:${command.type}:${threadId}:${at}`),
              threadId: ThreadId.make(threadId),
            }).pipe(Effect.ignore),
          );
        }
      }
      return due.length;
    },
    dispose: async () => {
      // celld's WebSocket.close accepts 1000 or application codes, not the reserved 1001.
      for (const socket of sockets) socket.close(4000, "space restarting");
      await Effect.runPromise(Scope.close(scope, Exit.void));
      unregisterAttachments();
      if (agentRoutes.get(config.spaceId) === config.agentFetch) agentRoutes.delete(config.spaceId);
    },
  };
  return server;
};
