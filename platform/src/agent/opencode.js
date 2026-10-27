// The ONLY module that touches OpenCode SDK internals (pinned @opencode/sdk 2.1.3, effect 4.0.1).
// `dist/internal/*` is not in the package "exports": the public `OpenCodeWorkerd.create` hides the raw HTTP handler
// behind a client and takes no workspace providers, and we need both (the celld-opencode spike, REPORT.md). On every
// OpenCode upgrade, re-run the agent feedback loops (platform/src/agent/README.md) before bumping the pins.
import { Bus } from "@opencode/core/bus";
import { Duration, Effect, Layer, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { SqlClient } from "effect/sql";
import { Database } from "@opencode/core/database/database";
import { RipgrepBinary } from "@opencode/core/ripgrep/binary";
import { Tool } from "@opencode/core/tool";
import { ToolOutput } from "@opencode/core/tool-output";
import { Environment } from "@opencode/core/environment/index";
import { Skill } from "@opencode/core/skill";
import { FSUtil } from "@opencode/util/fs-util";
import { Service as LocationServiceMap } from "@opencode/core/location-service-map";
import { Service as McpService } from "@opencode/core/mcp/index";
import { McpTool } from "@opencode/core/tool/mcp";
import { Mcp as McpSchema } from "@opencode/schema/mcp";
import { make as workerdProfile } from "../../node_modules/@opencode/sdk/dist/internal/workerd.js";
import { create as hostCreate } from "../../node_modules/@opencode/sdk/dist/internal/host.js";
import { makeRemoteSpawner } from "./remote-spawner.js";
import { shimFiles } from "./fs-shim.js";

export const OPENCODE_VERSION = "2.1.3";

// glob/grep spawn ripgrep through the workspace spawner, but resolve its path in the host first (`which rg`, else a
// download + local `tar`), which cannot work in a cell. The computer image ships `rg` on PATH: use that.
const ripgrepOnComputer = RipgrepBinary.node.replace(
  Layer.succeed(RipgrepBinary.Service, RipgrepBinary.Service.of({ filepath: Effect.succeed("rg") })),
);

/**
 * Boots an embedded OpenCode host on a DO's storage (workerd profile: DO SQLite, no local process, no local files),
 * with one workspace provider whose processes run on the space's computer (remote-spawner.js).
 * create/connect do no work: computerd starts the computer on the first exec (the first tool that needs it);
 * suspendForIdle/destroy are no-ops: computerd's idle timer stops the computer.
 * @param {{ storage: any, config: object, provider: string, databaseClient: any, computer: Parameters<typeof makeRemoteSpawner>[0], onUsage?: () => any, skills?: any[], enter: <A>(run: () => A | PromiseLike<A>) => Promise<A>, closeEntry: () => void }} o
 */
export async function bootOpenCode({ storage, config, provider, computer, databaseClient, onUsage, skills = [], enter: inBootEvent, closeEntry }) {
  const spawner = makeRemoteSpawner(computer);
  const files = Environment.execDefaults(spawner);
  const outputPath = file => `/sandbox/space/tool-output/${file.slice(file.lastIndexOf("/") + 1)}`;
  // OpenCode 2.1.3 retains tool output for seven days. Its cell-side sweep cannot reach these files.
  const pruneOutput = spawner.exitCode(ChildProcess.make("find", [
    "/sandbox/space/tool-output", "-maxdepth", "1", "-type", "f",
    "(", "-name", "tool_*", "-o", "-name", "sh_*", ")",
    "-mmin", `+${Duration.toMinutes(ToolOutput.RETENTION)}`, "-delete",
  ])).pipe(Effect.ignore);
  const writeOutput = (file, bytes) => files.write(outputPath(file), typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
    .pipe(Effect.tap(() => pruneOutput));
  const workspaceProviders = {
    [provider]: {
      create: () => Effect.succeed({ binding: { kind: provider } }),
      connect: () => Effect.sync(() => ({ spawner })),
      suspendForIdle: () => Effect.void,
      destroy: () => Effect.void,
    },
  };
  // Explicit config supplies the offered models. A built-in catalog would expose additional models of the
  // selected provider as soon as its key is configured.
  const profile = workerdProfile({ storage, config, models: { fetch: false, snapshot: false } });
  const host = await Effect.runPromise(
    hostCreate(
      // T3's OpenCode adapter picks the protocol generation from /api/info's version ("unknown" by default here).
      { ...profile.options, app: { ...profile.options.app, version: OPENCODE_VERSION }, workspaceProviders },
      { overrides: [
        // Pinned SDK workerd profile's first replacement is Database. Share the T3 SqlClient so
        // queries and transactions from both runtimes use one semaphore on this DO's SQLite.
        Database.node.replace(Database.configuredClient(Layer.succeed(SqlClient.SqlClient, databaseClient))),
        ...profile.replacements.slice(1),
        ripgrepOnComputer,
        // Config only exposes limits, not a directory. Give just ToolOutput a computer-backed writer;
        // no cell file is created, and stock truncation/limits stay intact.
        ToolOutput.node.replace(ToolOutput.node.mapLayer(layer => Layer.unwrap(Effect.gen(function* () {
          const fs = yield* FSUtil.Service;
          const storage = Layer.succeed(FSUtil.Service, { ...fs,
            ensureDir: () => Effect.void, // files.write creates parent directories on the computer.
            writeFileString: writeOutput,
            writeWithDirs: writeOutput,
          });
          return Layer.effect(ToolOutput.Service, Effect.gen(function* () {
            const inner = yield* ToolOutput.Service;
            return { ...inner,
              save: (bytes, extension) => inner.save(bytes, extension).pipe(Effect.map(outputPath)),
              truncate: result => Effect.gen(function* () {
                const bounded = yield* inner.truncate(result);
                if (!bounded.metadata?.truncated) return bounded;
                // Shell truncates first and retains its capture in fs-shim for shell_output.
                const shellPath = bounded.content.flatMap(item => item.type === "text"
                  ? [...item.text.matchAll(/full output saved to ([^\]\n]+)\]/g)].map(match => match[1]) : []).find(file => shimFiles.has(file));
                const source = bounded.metadata.outputPath ?? shellPath;
                if (!source || source.startsWith("/sandbox/")) return bounded;
                const target = outputPath(source);
                if (shellPath && !bounded.metadata.outputPath)
                  yield* writeOutput(shellPath, Buffer.concat(shimFiles.get(shellPath).chunks)).pipe(Effect.orDie);
                return { ...bounded,
                  content: bounded.content.map(item => item.type === "text" ? { ...item, text: item.text.replaceAll(source, target) } : item),
                  metadata: { ...bounded.metadata, outputPath: target },
                };
              }),
            };
          })).pipe(Layer.provide(layer.pipe(Layer.provide(storage))));
        })))),
        // Skill.prepare scans the host, while skill assets live on the computer. The validated install manifest
        // supplies that one scan; all other FSUtil operations retain the workerd profile's behavior.
        FSUtil.node.replace(FSUtil.node.mapLayer(layer => Layer.effect(FSUtil.Service, Effect.gen(function* () {
          const inner = yield* FSUtil.Service;
          const directories = new Map(skills.map(skill => [skill.path.slice(0, -"/SKILL.md".length), skill.files]));
          return { ...inner, scan: (pattern, options) => pattern === "**/*" && directories.has(options?.cwd)
            ? Effect.succeed(directories.get(options.cwd)) : inner.scan(pattern, options) };
        })).pipe(Layer.provide(layer)))),
        Skill.node.replace(Skill.node.mapLayer(layer => Layer.effect(Skill.Service, Effect.gen(function* () {
          const inner = yield* Skill.Service;
          yield* inner.transform(editor => { for (const skill of skills) editor.add(skill); });
          return inner;
        })).pipe(Layer.provide(layer)))),
      ] },
    ),
  );
  // SDK locations, MCP clients and event streams outlive the HTTP call that creates them. Enter them through
  // the boot event, which AgentRuntime already keeps alive until close; callbacks must not retain a retired GET.
  // Dispatch starts every operation without waiting for previous operations to finish.
  /** @type {typeof host.runtime.runPromise} */
  const runPromise = (effect, options) => inBootEvent(() => host.runtime.runPromise(effect, options));
  // The durable message projection is the source; the listener only accelerates the existing alarm scan.
  if (onUsage) await runPromise(Effect.flatMap(Bus.Service, bus => bus.listen(event => {
    if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.step.ended", "session.step.failed"].includes(event.type))
      return Effect.sync(() => { void onUsage(); });
    return Effect.void;
  })));
  return {
    /** OpenCode's own HTTP API (the full router). */
    fetch: (req) => inBootEvent(async () => {
      const response = await host.fetch(req);
      if (!response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream({
        pull: controller => inBootEvent(async () => {
          try {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (error) { controller.error(error); }
        }),
        cancel: reason => inBootEvent(() => reader.cancel(reason)),
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }),
    /** The cell's single computer workspace (created once, id persisted by the caller). */
    createWorkspace: (provider) => runPromise(host.workspace.create({ provider })),
    /** Creates a session in-process (the public HTTP schema strips `location.workspaceID`). */
    createSession: (input) => runPromise(host.sessions.create(input)),
    /**
     * WP-F: OpenCode's HTTP MCP routes act on a bare `{directory}` location, but sessions live in
     * `{directory, workspaceID}` locations (the computer workspace), so a server added over HTTP is never seen by a
     * session. These run the same MCP service operations in-process on the workspace location.
     * @param {{ directory: string, workspaceID: string }} ref
     */
    mcpAdd: (ref, server, config) =>
      runPromise(
        Effect.flatMap(McpService, (mcp) => mcp.add(server, Schema.decodeUnknownSync(McpSchema.ServerConfig)(config))).pipe(
          Effect.provide(LocationServiceMap.get(ref)),
        ),
      ),
    mcpRemove: (ref, server) =>
      runPromise(
        Effect.flatMap(McpService, (mcp) => mcp.remove(server)).pipe(Effect.ignore, Effect.provide(LocationServiceMap.get(ref))),
      ),
    /** The tool ids a location's registry offers right now (what the next model step lists, before permissions). */
    toolIds: (ref) =>
      runPromise(
        Effect.flatMap(Tool.Service, (tools) => tools.list()).pipe(
          Effect.map((list) => list.map((t) => t.id)),
          Effect.provide(LocationServiceMap.get(ref)),
        ),
      ),
    /** Connection completion and catalog publication are separate; an empty catalog is valid. */
    mcpReady: (ref, servers, listed = true) => runPromise(Effect.gen(function* () {
      const mcp = yield* McpService;
      const tools = yield* Tool.Service;
      const ids = (yield* tools.list()).map(t => t.id);
      const prefixes = servers.map(server => `${McpTool.namespace(server)}_`);
      const published = ids.filter(id => prefixes.some(prefix => id.startsWith(prefix)));
      if (!listed) return published.length === 0;
      const statuses = yield* mcp.servers();
      for (const server of servers) {
        const status = statuses.find(s => s.name === server)?.status.status;
        if (!status || status === "pending") return false;
        if (status !== "connected") throw new Error(`MCP server ${server}: ${status}`);
      }
      const expected = (yield* mcp.tools()).filter(t => servers.includes(t.server));
      return published.length === expected.length && expected.every(t => published.includes(McpTool.name(t.server, t.name)));
    }).pipe(Effect.provide(LocationServiceMap.get(ref)))),
    /** MCP tools of a location (with their `_meta`), for MCP apps. */
    mcpTools: (ref) => runPromise(Effect.flatMap(McpService, (mcp) => mcp.tools()).pipe(Effect.provide(LocationServiceMap.get(ref)))),
    mcpCall: (ref, input) => runPromise(Effect.flatMap(McpService, m => m.callTool(input)).pipe(Effect.provide(LocationServiceMap.get(ref)))),
    mcpResource: (ref, input) => runPromise(Effect.flatMap(McpService, m => m.readResource(input)).pipe(Effect.provide(LocationServiceMap.get(ref)))),
    close: () => inBootEvent(() => host.close()).finally(closeEntry),
  };
}
