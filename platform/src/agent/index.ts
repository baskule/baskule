// AgentRuntime: OpenCode 2.1.3 embedded in the SpaceCell (space/index.ts), which enters it through its internal
// `/_baskule/agent/*` route. The contract is `/oc/<OpenCode API path>`, OpenCode's HTTP API unchanged,
// except that session creation binds the session to the space's computer workspace.
//
// - Shell/file tools run on the space's computer through an OpenCode WorkspaceDriver whose spawner execs over
//   computerd (remote-spawner.js). Bare locations cannot run processes in the workerd profile (fail-closed).
// - Browser: T3's preview tools (its MCP server, space-bridge.ts); quick lookups use webfetch/websearch.
// - LLM: the installation's single provider and model (config.ts); ControlCell supplies the installation's
//   settings and key, kept in memory only.
// - Lifecycle: OpenCode boots on the first /oc request. #258 bypass on stock celld: an interval keeps the boot event
//   alive while booted; waitUntil retains its input-gate lifetime until close. Each turn-starting request also
//   keeps its own event alive until no session is active. SDK calls and body pulls enter through the boot event. The
//   agent's alarm deadline (space/alarms.ts) beats every 5 s while sessions are active (celld evicts idle cells
//   regardless of background work). After IDLE_DISPOSE_MS with no request, stream or active session, OpenCode is
//   closed and the keepalives cleared, so the cell can be evicted; the computer is left to computerd's idle stop.
import "./fs-shim.js";
import type { bootOpenCode } from "./opencode.js";
import { Computerd } from "./computerd";
import { configModels, configPrices, opencodeConfig, type AgentEnv } from "./config";
import { registerLazyMcp, unregisterLazyMcp } from "./lazy-mcp";
import { sampleAppHandler } from "./sample-app";
import { type Models, offeredModel, prepareSessionCreate } from "./session";
import { SPACE_HOST, registerSpaceBridge, unregisterSpaceBridge } from "./space-bridge";
import type { SqlClient } from "effect/sql/SqlClient";
import type { UsageLimitSettings } from "../../../app/packages/contracts/src/baskule-usage";
import { UsageReporter } from "./usage";
import { T3McpProxy } from "./t3-mcp";
import { PluginMcpProxy } from "./plugin-mcp";
import { authorQuery, resolveTurnAuthor } from "./turn-author";
import { syncSkills, skillCatalog } from "./plugin-skills";
import type { PluginCredential } from "../../../app/packages/contracts/src/baskule-plugins";

export const HEARTBEAT_MS = 5_000;
export const IDLE_DISPOSE_MS = 5 * 60_000;
export const DEFAULT_DIRECTORY = "/sandbox/space";
const WORKSPACE_PROVIDER = "computer";
const OC_ORIGIN = "http://opencode.local";

type OpenCode = Awaited<ReturnType<typeof bootOpenCode>>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

export class AgentRuntime {
  // A key rotation must not overwrite the credentials of an older runtime finishing an answer in this isolate.
  private keyEnv = `BASKULE_LLM_KEY_${crypto.randomUUID().replace(/-/g, "")}`;
  private oc: Promise<OpenCode> | null = null;
  private booted: OpenCode | null = null;
  private bootKeepalive: ReturnType<typeof setInterval> | null = null;
  private finishBootEvent: (() => void) | null = null;
  private turnKeepalives = new Set<ReturnType<typeof setInterval>>();
  private openStreams = 0;
  private inflight = 0;
  private lastActivity = Date.now();
  private pendingDirs = new Set<string>();
  private preparedSessions = new Set<string>();
  /** Per chat folder: the config's MCP tools listed there (started when a session is created in it). */
  private configTools = new Map<string, Promise<void>>();
  /** OpenCode's model list (GET /api/model) of this boot: the installation's model, the same in every folder. */
  private modelList: Promise<{ body: string; status: number; contentType: string }> | null = null;
  /** MCP servers of the OpenCode config (in-process): their tools must be listed at a chat's first step. */
  private configServers: string[] = [];
  private models: Models | null = null;
  /** T3's per-chat MCP servers, proxied with a static tool list (t3-mcp.ts), by server name. */
  private t3Mcp = new Map<string, T3McpProxy>();
  private pluginMcp = new Map<string, PluginMcpProxy>();
  private skillsReady: Promise<void> | null = null;
  private t3McpCache: Record<string, unknown> | undefined;
  private dirsReady: true | null = null;
  private mkdirRun: Promise<void> | null = null;
  private logs: string[] = [];
  private stats = { boots: 0, bootMs: 0, execs: 0, mkdirs: 0, disposes: 0 };
  readonly computerd: Computerd;
  readonly usage?: UsageReporter;

  /**
   * @param storage the space's storage, whose alarm calls address the agent's own deadline (space/alarms.ts)
   * @param databaseClient the SpaceCell's one SQL client, shared with T3
   * @param space the same SpaceCell, called in-process (T3's MCP endpoints, space-bridge.ts)
   */
  constructor(
    private storage: DurableObjectStorage,
    private env: AgentEnv,
    readonly spaceId: string,
    private databaseClient: unknown,
    private space: { fetch(req: Request): Promise<Response> },
    private waitUntil: (promise: Promise<unknown>) => void,
    usage?: { settings: UsageLimitSettings; control: (path: string, body: unknown) => Promise<Response> },
    private control?: { fetch(req: Request): Promise<Response> },
  ) {
    if (usage) this.usage = new UsageReporter(databaseClient as SqlClient, spaceId, configPrices(opencodeConfig(env, this.keyEnv)), usage.settings, usage.control, () => this.scheduleAlarm());
    this.computerd = new Computerd(env.COMPUTERD_URL ?? "", env.COMPUTERD_TOKEN ?? "", spaceId);
  }

  private log(line: string) {
    this.logs.push(`${new Date().toISOString()} ${line}`);
    if (this.logs.length > 300) this.logs.shift();
    console.log(`[agent ${this.spaceId}] ${line}`);
  }

  // --- the computer -------------------------------------------------------------------------------------------

  /**
   * Session folders (chat folders) are created on the computer lazily: before the first exec of this cell's lifetime,
   * one `mkdir -p` of every session folder not yet created (the list is kept in DO storage). OpenCode stats a
   * session's folder before its first shell, so this cannot wait for an exec whose cwd is that folder.
   */
  private async ensureDirs(): Promise<void> {
    while (this.dirsReady === null || this.pendingDirs.size > 0) {
      if (this.mkdirRun) {
        await this.mkdirRun;
        continue;
      }
      this.mkdirRun = (async () => {
        if (this.dirsReady === null) {
          for (const d of (await this.storage.get<string[]>("baskule:dirs")) ?? []) this.pendingDirs.add(d);
          this.dirsReady = true;
        }
        const dirs = [...this.pendingDirs];
        if (!dirs.length) return;
        const r = await this.computerd.run(["mkdir", "-p", "--", ...dirs]);
        if (r.code !== 0) throw new Error(`cannot create the chat folders: ${r.error ?? r.stderr}`);
        this.stats.mkdirs++;
        for (const d of dirs) this.pendingDirs.delete(d);
      })().finally(() => (this.mkdirRun = null));
      await this.mkdirRun;
    }
  }

  prepareSkills(): Promise<void> {
    return this.skillsReady ??= (async () => {
      const skills = this.env.PLUGINS?.skills ?? [];
      if (!skills.length && !await this.storage.get("baskule:plugin-skills")) return;
      await syncSkills(this.computerd, skills);
      await this.storage.put("baskule:plugin-skills", skills.length > 0);
    })().catch(error => { this.skillsReady = null; throw error; });
  }

  private async rememberDir(dir: string) {
    const dirs = (await this.storage.get<string[]>("baskule:dirs")) ?? [];
    if (!dirs.includes(dir)) await this.storage.put("baskule:dirs", [...dirs, dir]);
    this.pendingDirs.add(dir);
  }

  // --- OpenCode -------------------------------------------------------------------------------------------------

  private async loadKey(): Promise<void> {
    const env = (globalThis.process.env ??= {} as NodeJS.ProcessEnv);
    env[this.keyEnv] = this.env.AI.apiKey || "unused";
  }

  /** Boots OpenCode (once; concurrent callers share the boot). */
  boot(): Promise<OpenCode> {
    if (this.oc) return this.oc;
    // #258: this event creates OpenCode's long-lived continuations; keep its driver alive while booted.
    this.bootKeepalive = setInterval(() => {}, HEARTBEAT_MS);
    const lifetime = new Promise<void>(resolve => { this.finishBootEvent = resolve; });
    this.waitUntil(lifetime);
    // Capture the dispatch continuation beside its keepalive, before any asynchronous bootstrap work.
    let pending: (() => void)[] = [];
    let wake = () => {};
    let nativeClosed = false;
    const arm = () => {
      new Promise<void>(resolve => { wake = resolve; }).then(() => {
        const batch = pending;
        pending = [];
        if (!nativeClosed) arm();
        for (const run of batch) run();
      });
    };
    arm();
    const enter = <A>(run: () => A | PromiseLike<A>): Promise<A> => new Promise((resolve, reject) => {
      if (nativeClosed) { reject(new Error("OpenCode host is closed")); return; }
      pending.push(() => { try { resolve(run()); } catch (error) { reject(error); } });
      wake();
    });
    const closeEntry = () => { nativeClosed = true; wake(); };
    const t0 = Date.now();
    this.oc = enter(async () => {
      this.log("boot phase: key");
      await this.loadKey();
      this.log("boot phase: module");
      // WP-F: T3's task and preview tools (and the bundled MCP apps) are served by this space's SpaceCell (space-bridge.ts).
      registerSpaceBridge(this.spaceId, this.space);
      // OpenCode (~20 MB of JS) is evaluated on the first boot in an isolate, not when the Worker starts.
      const { bootOpenCode } = await import("./opencode.js");
      await this.prepareSkills();
      this.log("boot phase: cache");
      this.t3McpCache = await this.storage.get<Record<string, unknown>>("baskule:t3-mcp-cache");
      const pluginServers: Record<string, unknown> = {};
      for (const [index, server] of (this.env.PLUGINS?.servers ?? []).entries()) {
        // Keep MCP tool prefixes short enough for model providers with bounded function names.
        const name = `plugin-${index}`;
        const key = `${this.spaceId}-${name}`;
        const proxy = new PluginMcpProxy(server, sessionId => resolveTurnAuthor(sessionId, authorQuery(this.databaseClient)), async (userId, call) => {
          if (!this.control) throw new Error("ControlCell unavailable");
          const response = await this.control.fetch(new Request("http://control/_baskule/plugin-credential", {
            method: "POST", headers: { "content-type": "application/json", "x-baskule-internal": "1" },
            body: JSON.stringify({ spaceId: this.spaceId, pluginId: server.pluginId, server: server.name, userId, ...call }),
          }));
          if (!response.ok) throw new Error("Plugin credential unavailable");
          return await response.json() as PluginCredential;
        });
        this.pluginMcp.set(key, proxy);
        pluginServers[name] = { type: "remote", url: registerLazyMcp(key, proxy.handler), oauth: false, codemode: false };
      }
      const config = opencodeConfig(this.env, this.keyEnv, registerLazyMcp(`${this.spaceId}-decision`, sampleAppHandler), pluginServers);
      this.configServers = Object.keys((config.mcp as { servers: Record<string, unknown> }).servers);
      this.models = configModels(config);
      this.log("boot phase: host");
      const oc = await bootOpenCode({
        enter, closeEntry,
        storage: this.storage,
        databaseClient: this.databaseClient,
        config,
        skills: skillCatalog(this.env.PLUGINS?.skills ?? []),
        provider: WORKSPACE_PROVIDER,
        onUsage: () => this.usage?.flush().catch(e => this.log(`usage: ${e}`)),
        computer: {
          exec: async (spec: { cwd?: string }, signal: AbortSignal) => {
            this.stats.execs++;
            this.lastActivity = Date.now();
            await this.ensureDirs();
            await this.prepareSkills();
            return this.computerd.exec(spec as never, signal);
          },
          kill: (id: string, signal: string, graceMs: number) => this.computerd.kill(id, signal, graceMs),
          log: (l: string) => this.log(l),
        },
      });
      this.booted = oc;
      this.stats.boots++;
      this.stats.bootMs = Date.now() - t0;
      this.log(`OpenCode booted in ${this.stats.bootMs} ms`);
      return oc;
    });
    this.oc.catch((e) => {
      this.log(`boot failed: ${e?.message ?? e}`);
      this.oc = null;
      closeEntry();
      this.clearKeepalives();
      delete globalThis.process.env[this.keyEnv];
    });
    return this.oc;
  }

  private clearKeepalives() {
    this.finishBootEvent?.();
    this.finishBootEvent = null;
    if (this.bootKeepalive) clearInterval(this.bootKeepalive);
    this.bootKeepalive = null;
    for (const t of this.turnKeepalives) clearInterval(t);
    this.turnKeepalives.clear();
  }

  async dispose(reason: string) {
    const oc = this.booted ?? (this.oc ? await this.oc.catch(() => null) : null);
    this.oc = null;
    this.booted = null;
    unregisterSpaceBridge(this.spaceId);
    unregisterLazyMcp(`${this.spaceId}-decision`);
    for (const server of this.t3Mcp.keys()) unregisterLazyMcp(`${this.spaceId}-${server}`);
    this.t3Mcp.clear();
    for (const [key, proxy] of this.pluginMcp) {
      unregisterLazyMcp(key);
      await proxy.close();
    }
    this.pluginMcp.clear();
    this.skillsReady = null;
    if (oc) await oc.close().catch((e: unknown) => this.log(`close: ${e}`));
    delete globalThis.process.env[this.keyEnv];
    this.clearKeepalives();
    this.dirsReady = null;
    this.pendingDirs.clear();
    this.preparedSessions.clear();
    this.configTools.clear();
    this.modelList = null;
    this.stats.disposes++;
    this.log(`disposed (${reason})`);
  }

  /**
   * OpenCode connects a location's MCP servers asynchronously when the location loads (the first touch of a chat
   * folder in this cell's lifetime) and reloads its tool registry after a server's tools change. Wait for connection
   * completion and publication of its actual catalog, including plugins with no tools until an account connects.
   */
  private async waitForTools(oc: OpenCode, ref: { directory: string; workspaceID: string }, servers: string[], listed = true): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      if (await oc.mcpReady(ref, servers, listed)) return Date.now() - t0;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`MCP catalog did not settle: ${servers.join(", ")}`);
  }

  /** A session's first turn in this boot: its model must still be offered (an admin may have replaced it), and its
   *  location must list the config's MCP tools before the first step. */
  private async prepareSession(oc: OpenCode, sessionID: string) {
    if (this.preparedSessions.has(sessionID)) return;
    const res = await oc.fetch(new Request(`${OC_ORIGIN}/api/session/${encodeURIComponent(sessionID)}`));
    if (!res.ok) return;
    const session = ((await res.json()) as { data?: { model?: unknown; location?: { directory?: string } } }).data;
    const model = offeredModel(session?.model, this.models!);
    if (model !== session?.model) await this.switchModel(oc, sessionID, model);
    // The public session schema strips location.workspaceID: the cell's sessions all live on its one workspace.
    const directory = session?.location?.directory;
    if (directory) await this.configToolsAt(oc, directory);
    this.preparedSessions.add(sessionID);
  }

  /** The config's MCP tools listed at a chat folder. Connecting them takes ~0.5–0.9 s per new folder, so it starts
   *  when a session is created there and the folder's first prompt and T3's MCP registration share the wait. */
  private configToolsAt(oc: OpenCode, directory: string): Promise<void> {
    let ready = this.configTools.get(directory);
    if (!ready) {
      ready = (async () => {
        if (this.configServers.length === 0) return;
        const ms = await this.waitForTools(oc, { directory, workspaceID: await this.workspaceID(oc) }, this.configServers);
        if (ms > 50) this.log(`location ${directory}: tools ready after ${ms} ms`);
      })();
      ready.catch(() => this.configTools.delete(directory));
      this.configTools.set(directory, ready);
    }
    return ready;
  }

  private async modelListResponse(oc: OpenCode, pathAndQuery: string): Promise<Response> {
    this.modelList ??= oc.fetch(new Request(new URL(pathAndQuery, OC_ORIGIN))).then(async (res) => {
      const list = { body: await res.text(), status: res.status, contentType: res.headers.get("content-type") ?? "application/json" };
      if (!res.ok) this.modelList = null;
      return list;
    });
    const { body, status, contentType } = await this.modelList;
    return new Response(body, { status, headers: { "content-type": contentType } });
  }

  private switchModel(oc: OpenCode, sessionID: string, model: unknown) {
    return oc.fetch(new Request(`${OC_ORIGIN}/api/session/${encodeURIComponent(sessionID)}/model`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }),
    }));
  }

  private async workspaceID(oc: OpenCode): Promise<string> {
    let id = await this.storage.get<string>("baskule:workspaceID");
    if (!id) {
      id = (await oc.createWorkspace(WORKSPACE_PROVIDER)) as string;
      await this.storage.put("baskule:workspaceID", id);
    }
    return id;
  }

  private async activeSessions(oc: OpenCode): Promise<string[]> {
    const res = await oc.fetch(new Request(`${OC_ORIGIN}/api/session/active`));
    if (!res.ok) throw new Error(`Active session lookup failed (${res.status})`);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    if (!body.data || typeof body.data !== "object") throw new Error("Invalid active session response");
    return Object.keys(body.data);
  }

  // --- lifecycle ------------------------------------------------------------------------------------------------

  private async scheduleAlarm(ms = HEARTBEAT_MS) {
    const at = Date.now() + ms;
    const cur = await this.storage.getAlarm();
    if (cur === null || cur > at) await this.storage.setAlarm(at);
  }

  async alarm() {
    const pendingUsage = await this.usage?.flush();
    if (pendingUsage) await this.scheduleAlarm();
    // After a restart, an alarm of a cell that had a turn running boots OpenCode, which resumes orphaned turns. An
    // alarm left over from an idle cell (a restart, a failover, a deploy) does not boot it: nothing to resume.
    if (!this.booted && !(await this.storage.get<boolean>("baskule:busy"))) return;
    const oc = this.booted ?? (await this.boot());
    let active: string[] = [];
    try {
      active = await this.activeSessions(oc);
    } catch (e) {
      this.log(`heartbeat: ${e}`);
    }
    if (active.length === 0) {
      for (const t of this.turnKeepalives) clearInterval(t);
      this.turnKeepalives.clear();
      await this.storage.delete("baskule:busy");
    }
    if (active.length > 0) return this.scheduleAlarm(HEARTBEAT_MS);
    const idleFor = Date.now() - this.lastActivity;
    const idleMs = Number(this.env.BASKULE_AGENT_IDLE_S) * 1000 || IDLE_DISPOSE_MS;
    if (this.inflight === 0 && this.openStreams === 0 && idleFor >= idleMs) return this.dispose("idle");
    await this.scheduleAlarm(Math.max(HEARTBEAT_MS, idleMs - idleFor));
  }

  /** Counts an open streaming response (e.g. T3's event subscription) until it ends or is cancelled. */
  private track(res: Response): Response {
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
    this.openStreams++;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      this.openStreams--;
      this.lastActivity = Date.now();
    };
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(ctl) {
        try {
          const { value, done: d } = await reader.read();
          if (d) {
            end();
            ctl.close();
          } else ctl.enqueue(value);
        } catch (e) {
          end();
          ctl.error(e);
        }
      },
      cancel(reason) {
        end();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  // --- HTTP -----------------------------------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/_baskule/debug/") && this.env.BASKULE_AGENT_DEBUG === "1") return this.debug(path, request);
    if (path !== "/oc" && !path.startsWith("/oc/")) return json({ error: "not_found" }, 404);
    this.lastActivity = Date.now();
    this.inflight++;
    try {
      let oc: OpenCode;
      try {
        oc = await this.boot();
      } catch (e) {
        return json({ error: "agent_unavailable", message: String((e as Error)?.message ?? e) }, 503);
      }
      const ocPath = path.slice(3) || "/";
      // Internal-only adapter bridge (T3's MCP apps). The Worker never forwards /_baskule/* to a cell.
      if (ocPath === "/api/baskule/mcp-app" && request.method === "POST") {
        const input = await request.json() as { sessionID: string; operation: string; server: string; name?: string; args?: Record<string, unknown>; uri?: string };
        const session = await oc.fetch(new Request(`${OC_ORIGIN}/api/session/${encodeURIComponent(input.sessionID)}`));
        if (!session.ok) return json({ error: "session_not_found" }, 404);
        const data = await session.json() as { data?: { location?: { directory?: string } } };
        const directory = data.data?.location?.directory;
        if (!directory) return json({ error: "session_location_missing" }, 409);
        const ref = { directory, workspaceID: await this.workspaceID(oc) };
        if (input.operation === "tools") return json((await oc.mcpTools(ref)).filter((t: { server: string }) => !input.server || t.server === input.server));
        if (input.operation === "resource" && input.uri) return json(await oc.mcpResource(ref, { server: input.server, uri: input.uri }) ?? { contents: [] });
        if (input.operation === "call" && input.name) return json(await oc.mcpCall(ref, { server: input.server, name: input.name, args: input.args, sessionID: input.sessionID }));
        return json({ error: "invalid_operation" }, 400);
      }
      if (ocPath === "/api/session" && request.method === "POST") return await this.createSession(oc, request);
      // T3 lists the models once per chat folder, i.e. on every new chat; the list is the same in every folder.
      if (ocPath === "/api/model" && request.method === "GET") return await this.modelListResponse(oc, ocPath + url.search);
      const mcpRoute = /^\/api\/experimental\/mcp\/(t3-code-[A-Za-z0-9_-]{1,64})$/.exec(ocPath);
      if (mcpRoute && (request.method === "PUT" || request.method === "DELETE")) return await this.mcpRoute(oc, request, url, mcpRoute[1]!);
      if (request.method === "POST" && ocPath.startsWith("/api/session/")) {
        // May start a turn that runs after this response: keep this event alive (#258) and beat while active.
        this.turnKeepalives.add(setInterval(() => {}, HEARTBEAT_MS));
        await this.storage.put("baskule:busy", true);
        await this.scheduleAlarm(HEARTBEAT_MS);
        const turn = /^\/api\/session\/([^/]+)\/(prompt|command|shell|synthetic|skill)$/.exec(ocPath);
        if (turn) {
          const body = await request.clone().json().catch(() => ({})) as { id?: string };
          const refused = await this.usage?.beforeTurn(decodeURIComponent(turn[1]!), body.id);
          if (refused) return refused;
          await this.prepareSession(oc, turn[1]!);
        }
        const switching = /^\/api\/session\/([^/]+)\/model$/.exec(ocPath);
        if (switching) {
          const body = (await request.json().catch(() => ({}))) as { model?: unknown };
          return this.track(await this.switchModel(oc, decodeURIComponent(switching[1]!), offeredModel(body.model, this.models!)));
        }
      }
      const res = await oc.fetch(new Request(new URL(ocPath + url.search, OC_ORIGIN), request));
      return this.track(res);
    } finally {
      this.inflight--;
      this.lastActivity = Date.now();
      await this.scheduleAlarm(HEARTBEAT_MS);
    }
  }

  /**
   * POST /api/session: the one change to OpenCode's API. The public schema strips `location.workspaceID`, so the
   * session is created in-process at the requested directory on this space's computer workspace, and the answer is
   * OpenCode's own GET of the new session.
   */
  private async createSession(oc: OpenCode, request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const prepared = prepareSessionCreate(body, await this.workspaceID(oc), DEFAULT_DIRECTORY, this.models!);
    if ("error" in prepared) return json({ error: prepared.error }, 400);
    let created: { id: string };
    try {
      created = (await oc.createSession(prepared.input)) as { id: string };
    } catch (e) {
      this.log(`session create failed: ${e}`);
      return json({ error: "session_create_failed", message: String((e as Error)?.message ?? e) }, 400);
    }
    if (prepared.directory !== null) {
      await this.rememberDir(prepared.directory);
      // Not awaited: the folder's first prompt (prepareSession) and T3's MCP registration wait for it.
      void this.configToolsAt(oc, prepared.directory);
    }
    this.log(`session ${created.id} at ${prepared.directory ?? "(parent's)"}`);
    return oc.fetch(new Request(`${OC_ORIGIN}/api/session/${created.id}`));
  }

  /**
   * WP-F: T3 adds its MCP server (its agent tools, over space-bridge.ts) to a session's location with
   * `PUT /api/experimental/mcp/<t3-code-…>?location[directory]=<chat folder>`. Over HTTP that targets a bare
   * `{directory}` location, while sessions run in `{directory, workspaceID}` locations: apply it there in-process.
   */
  private async mcpRoute(oc: OpenCode, request: Request, url: URL, server: string): Promise<Response> {
    const directory = url.searchParams.get("location[directory]") ?? DEFAULT_DIRECTORY;
    const ref = { directory, workspaceID: await this.workspaceID(oc) };
    try {
      if (request.method === "DELETE") {
        await oc.mcpRemove(ref, server);
        this.t3Mcp.delete(server);
        unregisterLazyMcp(`${this.spaceId}-${server}`);
        // T3 removes and re-adds its server when a turn's credential changes: let the removal settle in the registry,
        // so the re-add below waits for the new connection, not the old tools.
        await this.waitForTools(oc, ref, [server], false);
      }
      else {
        const body = (await request.json()) as { config?: { type?: string; url?: string; headers?: Record<string, string> } };
        let config: object = { ...body.config };
        if (body.config?.type === "remote" && body.config.url && new URL(body.config.url).hostname === SPACE_HOST) {
          // T3's own server: in-process, static tool list, upstream session opened on the first tool call.
          const upstream = { url: body.config.url, headers: body.config.headers };
          let proxy = this.t3Mcp.get(server);
          if (proxy) proxy.update(upstream);
          else {
            proxy = new T3McpProxy(upstream, {
              get: () => this.t3McpCache,
              set: (v) => {
                this.t3McpCache = v;
                void this.storage.put("baskule:t3-mcp-cache", v);
              },
            }, (l) => this.log(l));
            this.t3Mcp.set(server, proxy);
          }
          // The same downstream config on every re-add, so OpenCode keeps its connection.
          config = { type: "remote", url: registerLazyMcp(`${this.spaceId}-${server}`, proxy.handler), oauth: false };
        }
        const configTools = this.configToolsAt(oc, directory);
        // Keep MCP tools directly callable by the model instead of routing them through Code Mode.
        await oc.mcpAdd(ref, server, { ...config, codemode: false });
        // The connection settles asynchronously: the turn T3 starts next must offer the server's tools (and the
        // configured ones) at its first step.
        const ms = await this.waitForTools(oc, ref, [server]);
        await configTools;
        this.log(`mcp added ${server} at ${directory} (tools listed after ${ms} ms)`);
      }
      return new Response(null, { status: 204 });
    } catch (e) {
      this.log(`mcp ${request.method} ${server} at ${directory}: ${e}`);
      return json({ error: "mcp_failed", message: String((e as Error)?.message ?? e) }, 400);
    }
  }

  /** An administrator's stop of the space: interrupts the active sessions. Never boots OpenCode. */
  async stop(): Promise<number> {
    if (!this.booted) return 0;
    let interrupted = 0;
    for (const id of await this.activeSessions(this.booted).catch(() => [] as string[])) {
      await this.booted.fetch(new Request(`${OC_ORIGIN}/api/session/${id}/interrupt`, { method: "POST" })).catch(() => null);
      interrupted++;
    }
    return interrupted;
  }

  /** Test-only routes (BASKULE_AGENT_DEBUG=1). */
  private async debug(path: string, request: Request): Promise<Response> {
    if (path === "/_baskule/debug/state") {
      return json({ spaceId: this.spaceId, booted: this.booted !== null, stats: this.stats, openStreams: this.openStreams, inflight: this.inflight,
        turnKeepalives: this.turnKeepalives.size,
        workspaceID: (await this.storage.get("baskule:workspaceID")) ?? null, alarm: await this.storage.getAlarm(), logs: this.logs.slice(-80) });
    }
    if (path === "/_baskule/debug/bare-session" && request.method === "POST") {
      // A session WITHOUT the computer workspace, to prove nothing can run locally in the cell.
      const oc = await this.boot();
      const body = (await request.json()) as { directory?: string };
      const created = (await oc.createSession({ location: { directory: body.directory ?? "/tmp" } })) as { id: string };
      return oc.fetch(new Request(`${OC_ORIGIN}/api/session/${created.id}`));
    }
    if (path === "/_baskule/debug/dispose" && request.method === "POST") {
      await this.dispose("debug");
      return json({ disposed: true });
    }
    return json({ error: "not_found" }, 404);
  }
}

