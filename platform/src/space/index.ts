// SpaceCell: one Durable Object per space running T3 and embedded OpenCode (../agent) on one SQLite database
// through one shared SQL client. T3 is built for workerd from the fork (apps/server/src/baskule/workerd, bundled
// into ./t3/space-cell.js by ./sync-bundle.sh). Contract: platform/src/shared/contract.ts and platform/README.md.
//
// Lifecycle:
// - T3 boots on the first client request, webhook or due alarm, never for control calls; in a new space OpenCode
//   boots first, because it only creates its schema in an empty database;
// - T3 reaches OpenCode through this cell's own stub (/_baskule/agent/*), so every agent call runs in a live
//   celld event (#258), even when T3 calls from a background fiber;
// - while booted, an interval in the boot event keeps its continuations alive (#258 bypass on
//   stock celld); each WebSocket has its own (in the bundle's transport);
// - one alarm multiplexes: the 60 s socket recheck, a heartbeat while runs are active, the next
//   scheduled task or snooze, and the idle check that disposes T3 so the cell can be evicted;
//   OpenCode keeps its own deadline on the same alarm (./alarms.ts).
import { DurableObject } from "cloudflare:workers";
import { AgentRuntime } from "../agent/index";
import type { AgentEnv } from "../agent/config";
import { SpaceAlarms } from "./alarms";
import { BASE_HEADER, SPACE_CONTROL, type RevokeRequest, type SpaceStatus } from "../shared/contract";
import { RECHECK_INTERVAL_MS, recheckSockets, type ControlNamespace } from "../shared/recheck";
import type { SpaceServer, SpaceDatabase } from "./t3/space-cell.js";
import type { UsageLimitSettings } from "../../../app/packages/contracts/src/baskule-usage";
import { Computerd } from "../agent/computerd";
import { syncSkills } from "../agent/plugin-skills";
import type { SpacePlugins } from "../../../app/packages/contracts/src/baskule-plugins";
import type { ProductSettings } from "../control/settings";

// The T3 bundle (~16 MB) is evaluated on the first boot, not when the Worker isolate starts.
const loadBundle = () => import("./t3/space-cell.js");

export const SPACE_STOP_PATH = "/_baskule/stop";
/** Runs the 60 s socket recheck now (ops and tests; internal like every /_baskule path). */
export const SPACE_RECHECK_PATH = "/_baskule/recheck";
/** Boots T3 ahead of the first view (0.2.1 pre-wake: the Worker calls it when a member's app loads). Never wakes the
 *  computer; the idle check disposes T3 again after IDLE_DISPOSE_MS if nobody connects. */
export const SPACE_WAKE_PATH = "/_baskule/wake";
/** Idle time (no request, no socket, no active run) after which T3 is disposed. */
export const IDLE_DISPOSE_MS = 5 * 60_000;
/** Alarm cadence while runs are active, so the cell is not evicted mid-turn. */
export const RUN_HEARTBEAT_MS = 10_000;
/** How long an alarm that boots T3 for due work keeps the event open (T3's scheduler ticks every 5 s). */
const DUE_WORK_WAIT_MS = 7_000;

interface SpaceEnv extends Omit<AgentEnv, "AI"> {
  CONTROL: ControlNamespace;
  SPACE: { getByName(name: string): { fetch(req: Request): Promise<Response> } };
  PUBLIC_ORIGINS?: string;
  BASKULE_LOG_LEVEL?: string;
  /** OTLP/HTTP traces endpoint (`…/v1/traces`) for T3's spans in this cell; unset or empty: no export. */
  OTLP_TRACES_URL?: string;
}

interface CachedStatus {
  activeRuns: number;
  nextWakeAt: number | null;
  updatedAt: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SpaceCell extends DurableObject<SpaceEnv> {
  private booting: Promise<SpaceServer> | null = null;
  private agent: AgentRuntime | null = null;
  private database: Promise<SpaceDatabase> | null = null;
  private agentStarting: Promise<AgentRuntime> | null = null;
  private closing: Promise<void> | null = null;
  private settings: Promise<ProductSettings & { apiKey: string; usageLimits?: UsageLimitSettings; plugins: SpacePlugins }> | null = null;
  private alarms = new SpaceAlarms(this.ctx.storage);

  /** The one SQL client of this cell's lifetime: T3 and OpenCode share its transactions and semaphore. */
  private sharedDatabase(): Promise<SpaceDatabase> {
    if (this.database) return this.database;
    this.database = loadBundle().then(({ createSpaceSqlClient }) =>
      createSpaceSqlClient(this.ctx.storage as never, () => { void this.dispose(); }),
    ).catch(error => { this.database = null; throw error; });
    return this.database;
  }

  private localAgent(): Promise<AgentRuntime> {
    if (this.agent) return Promise.resolve(this.agent);
    if (this.agentStarting) return this.agentStarting;
    this.agentStarting = this.createLocalAgent().finally(() => { this.agentStarting = null; });
    return this.agentStarting;
  }

  private async createLocalAgent(): Promise<AgentRuntime> {
    const id = await this.spaceId();
    console.log(JSON.stringify({ event: "space.agent_start", phase: "identity", spaceId: id, contextNamed: Boolean(this.ctx.id.name) }));
    const database = await this.sharedDatabase();
    console.log(JSON.stringify({ event: "space.agent_start", phase: "database", spaceId: id }));
    const settings = await this.loadSettings(id);
    return this.agent ??= new AgentRuntime(this.alarms.forAgent(), { ...this.env,
      AI: { ...settings.ai, apiKey: settings.apiKey }, PLUGINS: settings.plugins,
    }, id, database.client, { fetch: (req) => this.fetch(req) }, promise => this.ctx.waitUntil(promise), {
      settings: settings.usageLimits ?? { enabled: false, rules: [] },
      control: (path, body) => this.env.CONTROL.getByName("control").fetch(new Request(`http://control${path}`, {
        method: "POST", headers: { "content-type": "application/json", "x-baskule-internal": "1" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2_000),
      })),
    }, this.env.CONTROL.getByName("control"));
  }

  private loadSettings(spaceId: string) {
    return this.settings ??= this.env.CONTROL.getByName("control").fetch(new Request("http://control/_baskule/settings", {
      method: "POST", headers: { "content-type": "application/json", "x-baskule-internal": "1" }, body: JSON.stringify({ spaceId }),
    })).then(async r => {
      if (!r.ok) throw new Error(`Installation settings unavailable (${r.status})`);
      return await r.json() as ProductSettings & { apiKey: string; usageLimits?: UsageLimitSettings; plugins: SpacePlugins };
    }).catch(error => { this.settings = null; throw error; });
  }

  private async refreshComputerSkills() {
    if (!this.env.COMPUTERD_URL || !this.env.COMPUTERD_TOKEN) return;
    const id = this.spaceIdCache ?? await this.ctx.storage.get<string>("baskule:spaceId");
    if (!id) return; // Never-opened spaces cannot have started a computer through this cell.
    const computer = new Computerd(this.env.COMPUTERD_URL, this.env.COMPUTERD_TOKEN, id);
    const status = await computer.status() as { running?: boolean };
    if (!status.running) return;
    const skills = (await this.loadSettings(id)).plugins.skills;
    if (!skills.length && !await this.ctx.storage.get("baskule:plugin-skills")) return;
    await syncSkills(computer, skills);
    await this.ctx.storage.put("baskule:plugin-skills", skills.length > 0);
  }

  /** OpenCode refuses to create its schema in a database that already has other tables (T3's). */
  private hasOpenCodeSchema(): boolean {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'session_v2')")
      .toArray().length > 0;
  }

  private server: SpaceServer | null = null;
  private releaseBootKeepAlive: (() => void) | null = null;
  private lastActivity = Date.now();
  private spaceIdCache: string | null = null;

  private async spaceId(req?: Request): Promise<string> {
    if (this.spaceIdCache) return this.spaceIdCache;
    const base = req?.headers.get(BASE_HEADER) ?? "";
    const fromHeader = /^\/s\/([A-Za-z0-9_-]{1,128})$/.exec(base)?.[1];
    const stored = await this.ctx.storage.get<string>("baskule:spaceId");
    const id = stored ?? fromHeader ?? null;
    if (!id) throw new Error("space id unknown: the first request must carry x-baskule-base");
    if (!stored) await this.ctx.storage.put("baskule:spaceId", id);
    this.spaceIdCache = id;
    return id;
  }

  private boot(spaceId: string): Promise<SpaceServer> {
    if (this.closing) return this.closing.then(() => this.boot(spaceId));
    if (this.booting) return this.booting;
    // #258: this event creates T3's long-lived continuations; keep its driver alive while booted.
    const timer = setInterval(() => {}, 5_000);
    this.ctx.waitUntil(new Promise<void>(resolve => {
      this.releaseBootKeepAlive = () => { clearInterval(timer); resolve(); };
    }));
    this.booting = this.startServer(spaceId).then(
      (server) => {
        this.server = server;
        console.log(JSON.stringify({ event: "space.booted", spaceId, bootMs: server.bootMs }));
        return server;
      },
      (error) => {
        this.booting = null;
        this.releaseBootKeepAlive?.();
        this.releaseBootKeepAlive = null;
        throw error;
      },
    );
    return this.booting;
  }

  private async startServer(spaceId: string): Promise<SpaceServer> {
    const settings = await this.loadSettings(spaceId);
    await this.ctx.storage.delete("baskule:settingsChanged");
    const database = await this.sharedDatabase();
    // Prepare the managed tree before T3 can start the computer through files or browser routes.
    if (settings.plugins.skills.length || await this.ctx.storage.get("baskule:plugin-skills")) await (await this.localAgent()).prepareSkills();
    // A new space: OpenCode creates its schema in the still-empty database before T3 adds its tables.
    if (!this.hasOpenCodeSchema()) await (await this.localAgent()).boot();
    return (await loadBundle()).createSpaceServer({
      database,
      push: {
        deliver: async (notification, environmentId) => {
          const response = await this.env.CONTROL.getByName("control").fetch(new Request("http://control/_baskule/push/deliver", {
            method: "POST", headers: { "x-baskule-internal": "1", "content-type": "application/json" },
            body: JSON.stringify({ spaceId, environmentId, notification }),
          }));
          if (!response.ok) throw new Error(`Push delivery failed (${response.status})`);
        },
        changed: async () => {
          const response = await this.env.SPACE.getByName(spaceId).fetch(new Request("http://space/_baskule/push/schedule", { method: "POST" }));
          if (!response.ok) throw new Error(`Push scheduling failed (${response.status})`);
        },
      },
      spaceId,
      storage: this.ctx.storage as never,
      // T3 invokes this from background fibers whose original celld event may have retired (#258).
      // Enter this SAME cell through its stub so OpenCode boot and native I/O have a live driver.
      agentFetch: (request) => {
        const url = new URL(request.url);
        url.pathname = "/_baskule/agent" + url.pathname;
        return this.env.SPACE.getByName(spaceId).fetch(new Request(url, request));
      },
      computerdUrl: this.env.COMPUTERD_URL,
      computerdToken: this.env.COMPUTERD_TOKEN,
      otlpTracesUrl: this.env.OTLP_TRACES_URL || undefined,
      llmModel: settings.ai.model.id,
      llmProviderId: settings.ai.providerId,
      publicOrigin: this.env.PUBLIC_ORIGINS?.split(",").map((o) => o.trim()).find(Boolean),
      logLevel: (this.env.BASKULE_LOG_LEVEL as "Info" | undefined) ?? "Warn",
      onStorageLost: () => {
        console.warn(JSON.stringify({ event: "space.storage_lost", spaceId }));
        void this.dispose();
      },
      onSocketOpen: () => {
        this.touch();
        void this.scheduleAlarm();
        return () => {
          this.touch();
          void this.scheduleAlarm();
        };
      },
      waitUntil: promise => this.ctx.waitUntil(promise),
    });
  }

  private dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.disposeCurrent().finally(() => { this.closing = null; });
    return this.closing;
  }

  private async disposeCurrent(): Promise<void> {
    const server = this.server ?? (this.booting ? await this.booting.catch(() => null) : null);
    // Detach this generation's timer before yielding. A request may boot a replacement while
    // the old server closes; that replacement must keep its own #258 event driver alive.
    const release = this.releaseBootKeepAlive;
    this.releaseBootKeepAlive = null;
    this.server = null;
    this.booting = null;
    try {
      if (server) {
        await this.cacheStatus(server).catch((e) => console.warn(`space cache on dispose: ${e}`));
        await server.dispose().catch((e) => console.warn(`space dispose: ${e}`));
      }
    } finally {
      release?.();
      await this.agentStarting?.catch(() => null);
      const reporter = this.agent?.usage;
      if (this.agent) { await this.agent.dispose("space disposed"); this.agent = null; }
      // Drain receipt writes before a replacement can allocate its shared SQL client.
      await reporter?.flush();
      await reporter?.capture();
      const pendingUsage = await reporter?.hasPending();
      if (pendingUsage) await this.alarms.set("agent", Date.now() + 5_000);
      else await this.alarms.clear("agent");
      this.database = null;
      this.settings = null;
    }
  }

  private touch() {
    this.lastActivity = Date.now();
  }

  private async cacheStatus(server: SpaceServer): Promise<CachedStatus> {
    const status = { activeRuns: server.activeRuns(), nextWakeAt: server.nextWakeAt(), updatedAt: Date.now() };
    await this.ctx.storage.put("baskule:status", status);
    return status;
  }

  /** One alarm for every purpose: the earliest of recheck, heartbeat, due work and idle check. */
  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];
    const server = this.server;
    if (server) {
      const status = await this.cacheStatus(server);
      if (server.sockets().length > 0) candidates.push(now + RECHECK_INTERVAL_MS);
      if (status.activeRuns > 0) candidates.push(now + RUN_HEARTBEAT_MS);
      if (status.nextWakeAt !== null) candidates.push(Math.max(status.nextWakeAt, now + 1_000));
      candidates.push(this.lastActivity + IDLE_DISPOSE_MS);
    } else {
      const cached = await this.ctx.storage.get<CachedStatus>("baskule:status");
      if (cached?.nextWakeAt != null) candidates.push(Math.max(cached.nextWakeAt, now + 1_000));
      if (cached && cached.activeRuns > 0) candidates.push(now + RUN_HEARTBEAT_MS);
    }
    if (candidates.length === 0) {
      await this.alarms.clear("space");
      return;
    }
    const next = Math.min(...candidates);
    const current = await this.alarms.get("space");
    if (current === null || current > next || current < now) await this.alarms.set("space", next);
  }

  async alarm(): Promise<void> {
    const due = await this.alarms.due();
    try {
      // The space's own checks run on every alarm; they reschedule themselves (scheduleAlarm).
      if (due.includes("agent")) await (await this.localAgent()).alarm();
      await this.spaceAlarm();
      await this.alarms.complete(due);
    } catch (error) {
      for (const owner of new Set(["space", ...due])) await this.alarms.set(owner, Date.now() + RUN_HEARTBEAT_MS);
      throw error;
    } finally { await this.alarms.sync(); }
  }

  private async spaceAlarm(): Promise<void> {
    const now = Date.now();
    const cached = await this.ctx.storage.get<CachedStatus>("baskule:status");
    const due = (cached?.nextWakeAt ?? Infinity) <= now + 2_000 || (cached?.activeRuns ?? 0) > 0;
    if (!this.server && due) {
      // Due scheduled work (or a run to recover) with the cell asleep: boot and let T3's
      // scheduler pick it up within this event.
      await this.boot(await this.spaceId());
      await sleep(DUE_WORK_WAIT_MS);
    }
    const server = this.server;
    if (server) {
      await server.drainPushEffects();
      // WP-F: a snoozed chat returns to everyone's inbox when due, even with no client connected.
      await server.wakeDueSnoozes().catch((e) => console.warn(`snooze wake: ${e}`));
      await this.recheck();
      const idle =
        server.sockets().length === 0 && server.activeRuns() === 0 && Date.now() - this.lastActivity >= IDLE_DISPOSE_MS;
      const changed = server.activeRuns() === 0 && await this.ctx.storage.get("baskule:settingsChanged");
      if (idle || changed) await this.dispose();
      if (changed) await this.refreshComputerSkills();
    }
    await this.scheduleAlarm();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/_baskule/agent/")) {
      // T3 reaches its agent only after a boot stored the space id; a direct internal caller (the agent test
      // harness) names the space with x-baskule-base like the Worker does. A stored id always wins.
      await this.spaceId(req);
      url.pathname = url.pathname.slice("/_baskule/agent".length);
      return (await this.localAgent()).fetch(new Request(url, req));
    }
    switch (url.pathname) {
      case "/_baskule/usage-limits-changed":
        if (req.method !== "POST") break;
        this.agent?.usage?.invalidate(await req.json() as UsageLimitSettings);
        this.settings = null;
        return json({ ok: true });
      case "/_baskule/reconfigure":
        if (req.method !== "POST") break;
        if (this.booting) await this.booting.catch(() => null);
        await this.ctx.storage.put("baskule:settingsChanged", true);
        if (!this.server?.activeRuns()) { await this.dispose(); await this.refreshComputerSkills(); }
        else await this.scheduleAlarm();
        return json({ ok: true });
      case "/_baskule/push/schedule":
        await this.scheduleAlarm();
        return json({ ok: true });
      case "/_baskule/push/check": {
        const body = await req.json() as { eventId: string; threadId: string };
        const server = this.server ?? await this.boot(await this.spaceId());
        return json({ current: await server.isPushCurrent(body.eventId, body.threadId) });
      }
      case SPACE_CONTROL.status:
        return json(await this.status());
      case SPACE_CONTROL.revoke:
        if (req.method !== "POST") break;
        return json(await this.revoke((await req.json()) as RevokeRequest));
      case SPACE_CONTROL.delete:
        if (req.method !== "POST") break;
        return this.wipe();
      case SPACE_STOP_PATH:
        if (req.method !== "POST") break;
        return json(await this.stop());
      case SPACE_RECHECK_PATH:
        if (req.method !== "POST") break;
        return json(await this.recheck());
      case SPACE_WAKE_PATH: {
        if (req.method !== "POST") break;
        const wasAwake = this.server !== null;
        this.touch();
        const server = await this.boot(await this.spaceId(req));
        await this.scheduleAlarm();
        return json({ awake: true, booted: !wasAwake, bootMs: wasAwake ? 0 : server.bootMs });
      }
    }
    if (url.pathname.startsWith("/_baskule/")) return json({ error: "not_found" }, 404);
    // WP-F: T3's MCP credentials live in its memory, so none is valid while T3 is not running: answer the agent's
    // late calls (session teardown, a stale connection) without booting T3, so they cannot keep the space awake.
    if (url.pathname === "/mcp" && !this.server && !this.booting) {
      return json({ error: "invalid_mcp_credential", message: "The space is asleep; MCP credentials expired." }, 401);
    }
    this.touch();
    const server = await this.boot(await this.spaceId(req));
    try {
      return await server.fetch(req);
    } finally {
      this.touch();
      await this.scheduleAlarm();
    }
  }

  /** 60 s backstop for revocation (platform/src/shared/recheck.ts); fails open if ControlCell is down. */
  private async recheck(): Promise<{ checked: number; closed: number }> {
    const server = this.server;
    if (!server || server.sockets().length === 0) return { checked: 0, closed: 0 };
    try {
      return await recheckSockets(this.env.CONTROL, await this.spaceId(), [...server.sockets()]);
    } catch (e) {
      console.warn(`recheck: ${e}`);
      return { checked: 0, closed: 0 };
    }
  }

  private async status(): Promise<SpaceStatus> {
    const server = this.server;
    const cached = server ? await this.cacheStatus(server) : await this.ctx.storage.get<CachedStatus>("baskule:status");
    return {
      awake: server !== null,
      sockets: server?.sockets().length ?? 0,
      activeRuns: cached?.activeRuns ?? 0,
      computer: await this.computerStatus(),
    };
  }

  private async computerStatus(): Promise<unknown> {
    if (!this.env.COMPUTERD_URL || !this.env.COMPUTERD_TOKEN) return null;
    // A status-only activation has no in-memory ID yet. Read the durable identity without booting T3.
    const spaceId = this.spaceIdCache ?? await this.ctx.storage.get<string>("baskule:spaceId");
    if (!spaceId) return null;
    try {
      const res = await fetch(`${this.env.COMPUTERD_URL}/v1/spaces/${spaceId}/computer`, {
        headers: { authorization: `Bearer ${this.env.COMPUTERD_TOKEN}` },
        signal: AbortSignal.timeout(1_500),
      });
      return res.ok ? await res.json() : { error: `computerd ${res.status}` };
    } catch (e) {
      return { error: String(e) };
    }
  }

  private async revoke(target: RevokeRequest) {
    // Never boots T3: a cell without T3 running has no socket to close, and every new request
    // is checked again by the Worker.
    if (!this.server || (!target.userId && !target.sessionId)) return { closed: 0, revoked: 0 };
    return this.server.revoke({
      ...(target.userId ? { userId: target.userId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    });
  }

  private async stop() {
    const server = this.server;
    const stoppedThreads = server ? await server.stopActiveRuns("Stopped by an administrator.") : 0;
    if (this.agent) await this.agent.stop();
    let computer: unknown = null;
    if (this.env.COMPUTERD_URL && this.env.COMPUTERD_TOKEN) {
      try {
        const spaceId = await this.spaceId();
        const res = await fetch(`${this.env.COMPUTERD_URL}/v1/spaces/${spaceId}/computer/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.COMPUTERD_TOKEN}` },
          signal: AbortSignal.timeout(10_000),
        });
        computer = { stopped: res.ok, status: res.status };
      } catch (e) {
        computer = { stopped: false, error: String(e) };
      }
    }
    // Let the cell idle: dispose T3 once its stop commands are persisted.
    if (server) {
      await sleep(500);
      await this.dispose();
    }
    await this.scheduleAlarm();
    return { stoppedThreads, computer };
  }

  /** Wipes the computer (sandbox + volume), then this cell (T3 and OpenCode); 2xx only when both are done. */
  private async wipe(): Promise<Response> {
    if (this.server) await this.server.stopActiveRuns("Space deleted.");
    if (this.agent) await this.agent.stop();
    await this.dispose();
    const spaceId = await this.spaceId().catch(() => null);
    let computer: unknown = null;
    if (spaceId && this.env.COMPUTERD_URL && this.env.COMPUTERD_TOKEN) {
      try {
        const res = await fetch(`${this.env.COMPUTERD_URL}/v1/spaces/${spaceId}/computer/delete`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.COMPUTERD_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ confirm: spaceId }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) return json({ error: "computer_wipe_failed", status: res.status, message: await res.text() }, 502);
        computer = await res.json();
      } catch (e) {
        return json({ error: "computer_wipe_failed", message: String(e) }, 502);
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.spaceIdCache = null;
    return json({ deleted: true, computer });
  }
}
