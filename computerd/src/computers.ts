// Computer lifecycle: one OpenShell sandbox per space (`os-<spaceId>`), a per-space labelled volume at
// /sandbox/space, lazy create/start, Error -> stop -> start recovery, idle stop. All durable state lives in
// OpenShell; this class only keeps soft state (activity, stream counts, keep flags) that is rebuilt on restart.
import type { Config } from "./config.ts";
import { type Gateway, GatewayError, type Phase, type SandboxInfo } from "./gateway.ts";
import { namesFor, computerPolicy } from "./policy.ts";
import { runCollect } from "./exec.ts";
import { log } from "./log.ts";
import { traced } from "./trace.ts";

export const MANAGED_LABEL = "baskule.managed";
const INSTANCE_LABEL = "baskule.instance";

const CLEAR_CACHES_TIMEOUT_MS = 15_000;
/** `sh -c` script, `$1` = HOME: package-manager download caches and the shared browser's HTTP/code/GPU caches. */
export const CLEAR_CACHES = `h=$1
rm -rf "$h/.cache/pip" "$h/.cache/uv" "$h/.npm/_cacache" "$h/.bun/install/cache"
for p in "$h"/.baskule-browser/userdata/server-browser/profiles/*; do
  [ -d "$p" ] || continue
  rm -rf "$p/Default/Cache" "$p/Default/Code Cache" "$p/Default/GPUCache" "$p/Default/DawnGraphiteCache" \\
    "$p/Default/DawnWebGPUCache" "$p/BrowserMetrics-spare.pma"
done
true`;

export type PublicPhase = "absent" | "starting" | "ready" | "stopping" | "stopped" | "error";

export function publicPhase(p: Phase | null): PublicPhase {
  switch (p) {
    case null:
      return "absent";
    case "SANDBOX_PHASE_READY":
      return "ready";
    case "SANDBOX_PHASE_PROVISIONING":
    case "SANDBOX_PHASE_STARTING":
    case "SANDBOX_PHASE_UNSPECIFIED":
    case "SANDBOX_PHASE_UNKNOWN":
      return "starting";
    case "SANDBOX_PHASE_STOPPING":
    case "SANDBOX_PHASE_DELETING":
      return "stopping";
    case "SANDBOX_PHASE_STOPPED":
    case "SANDBOX_PHASE_COMPLETED":
      return "stopped";
    default:
      return "error";
  }
}

interface State {
  spaceId: string;
  sandbox: string;
  volume: string;
  lastActivity: number;
  streams: number; // running exec/cdp/files streams (each holds an OpenShell relay)
  keep: boolean;
  ensuring: Promise<EnsureResult> | null;
  stopping: Promise<void> | null;
  readyAt: number | null; // when computerd last saw it Ready (null = not known ready)
  prepared: boolean; // first-exec mkdir done since the last (re)start
}

export interface EnsureResult {
  spaceId: string;
  sandbox: string;
  created: boolean;
  started: boolean;
  ms: number;
}

export class TooManyStreams extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Computers {
  private states = new Map<string, State>();
  private timer: NodeJS.Timeout | null = null;
  private gw: Gateway;
  private cfg: Config;

  constructor(gw: Gateway, cfg: Config) {
    this.gw = gw;
    this.cfg = cfg;
  }

  private labels(): Record<string, string> {
    return { [MANAGED_LABEL]: "true", ...(this.cfg.instance ? { [INSTANCE_LABEL]: this.cfg.instance } : {}) };
  }

  private async getSandbox(name: string): Promise<SandboxInfo | null> {
    const info = await this.gw.get(name);
    if (info && this.cfg.instance &&
        (info.labels[MANAGED_LABEL] !== "true" || info.labels[INSTANCE_LABEL] !== this.cfg.instance)) {
      throw new Error(`sandbox ${name} does not belong to computerd instance ${this.cfg.instance}`);
    }
    return info;
  }

  state(spaceId: string): State {
    let s = this.states.get(spaceId);
    if (!s) {
      const n = namesFor(spaceId, this.cfg.instance);
      this.states.delete(`sandbox:${n.sandbox}`); // replaces an adopted (unknown-space) entry
      s = {
        spaceId,
        sandbox: n.sandbox,
        volume: n.volume,
        lastActivity: Date.now(),
        streams: 0,
        keep: false,
        ensuring: null,
        stopping: null,
        readyAt: null,
        prepared: false,
      };
      this.states.set(spaceId, s);
    }
    return s;
  }

  touch(spaceId: string) {
    this.state(spaceId).lastActivity = Date.now();
  }

  /** Reserve a stream slot (exec, cdp, files). Throws TooManyStreams over the per-computer cap. */
  acquire(spaceId: string): () => void {
    const s = this.state(spaceId);
    if (s.streams >= this.cfg.maxConcurrent) throw new TooManyStreams(`at most ${this.cfg.maxConcurrent} concurrent streams per computer`);
    s.streams++;
    s.lastActivity = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.streams--;
      s.lastActivity = Date.now();
    };
  }

  setKeep(spaceId: string, keep: boolean) {
    const s = this.state(spaceId);
    s.keep = keep;
    s.lastActivity = Date.now();
  }

  async status(spaceId: string) {
    const s = this.state(spaceId);
    const info = await this.getSandbox(s.sandbox);
    const phase = publicPhase(info?.phase ?? null);
    if (phase !== "ready") s.readyAt = null;
    return {
      spaceId,
      sandbox: s.sandbox,
      phase,
      running: phase === "ready",
      image: info?.image || null,
      activeStreams: s.streams,
      keep: s.keep,
      lastActivity: new Date(s.lastActivity).toISOString(),
      idleStopAt:
        phase === "ready" && !s.keep && s.streams === 0 ? new Date(s.lastActivity + this.cfg.idleMs).toISOString() : null,
      error: phase === "error" ? info?.conditions.find((c) => c.status !== "True")?.message || null : null,
    };
  }

  /** Make the computer Ready (create / start / recover), then prepare it once (mkdir home, chats). */
  ensure(spaceId: string, opts: { keep?: boolean } = {}): Promise<EnsureResult> {
    const s = this.state(spaceId);
    s.lastActivity = Date.now();
    if (opts.keep !== undefined) s.keep = opts.keep;
    if (s.ensuring) return s.ensuring;
    // Always one GetSandbox (local SQLite on the gateway, ~ms): a computer stopped behind our back is restarted.
    s.ensuring = traced("computer.ensure", { "baskule.space": spaceId }, async (span) => {
      const r = await this.doEnsure(s);
      span.set({ created: r.created, started: r.started });
      return r;
    }).finally(() => {
      s.ensuring = null;
    });
    return s.ensuring;
  }

  private async doEnsure(s: State): Promise<EnsureResult> {
    const t0 = Date.now();
    if (s.stopping) await s.stopping.catch(() => {});
    let created = false;
    let started = false;
    let info = await this.getSandbox(s.sandbox);
    if (!info) {
      await traced("computer.volume", {}, () => this.ensureVolume(s.volume));
      try {
        info = await traced("computer.create", {}, () => this.gw.create({
          name: s.sandbox,
          labels: this.labels(),
          annotations: { "baskule.space": s.spaceId },
          spec: this.spec(s),
        }));
        created = true;
        log.info("computer created", { spaceId: s.spaceId, sandbox: s.sandbox });
      } catch (e) {
        // Lost a creation race with another replica/request: fall through to the wait loop.
        if (!(e instanceof GatewayError && e.code === 6 /* ALREADY_EXISTS */)) throw e;
        info = await this.getSandbox(s.sandbox);
      }
    }
    const deadline = Date.now() + this.cfg.readyTimeoutMs;
    let recoveries = 0;
    let lastPhase: Phase | null = null;
    await traced("computer.ready", {}, async () => { for (;;) {
      const phase = info?.phase ?? null;
      if (phase !== lastPhase) log.debug("computer phase", { spaceId: s.spaceId, phase });
      lastPhase = phase;
      if (phase === "SANDBOX_PHASE_READY") break;
      if (Date.now() > deadline) throw new Error(`computer not ready after ${this.cfg.readyTimeoutMs} ms (phase ${phase})`);
      if (phase === null) throw new Error("computer disappeared while starting");
      if (phase === "SANDBOX_PHASE_STOPPED" || phase === "SANDBOX_PHASE_COMPLETED") {
        info = await this.gw.start(s.sandbox);
        started = true;
        continue;
      }
      if (phase === "SANDBOX_PHASE_ERROR") {
        // Known OpenShell race: stop then start recovers it.
        if (++recoveries > 3) {
          const why = info?.conditions.map((c) => `${c.type}=${c.status} ${c.reason}: ${c.message}`).join("; ");
          throw new Error(`computer in Error after ${recoveries - 1} recoveries: ${why}`);
        }
        log.warn("computer in Error, stop + start", { spaceId: s.spaceId, attempt: recoveries });
        await this.gw.stop(s.sandbox).catch((e) => log.warn("stop during recovery failed", { err: String(e?.message ?? e) }));
        info = await this.waitPhase(s.sandbox, ["SANDBOX_PHASE_STOPPED", "SANDBOX_PHASE_ERROR", "SANDBOX_PHASE_COMPLETED"], 90_000);
        if (info?.phase !== "SANDBOX_PHASE_ERROR") {
          info = await this.gw.start(s.sandbox);
          started = true;
        } else await sleep(1000);
        continue;
      }
      await sleep(300);
      info = await this.getSandbox(s.sandbox);
    } });
    s.readyAt = Date.now();
    s.lastActivity = Date.now();
    if (created || started || !s.prepared) {
      // The per-space volume is copied from the image on first mount (it has home/); chats/ is ours.
      const r = await traced("computer.prepare", {}, () => runCollect(this.gw, this.cfg.sandboxRoot, {
        sandbox: s.sandbox,
        argv: ["mkdir", "-p", "--", `${this.cfg.sandboxRoot}/space/home`, `${this.cfg.sandboxRoot}/space/chats`],
        raw: true,
      }));
      if (r.code !== 0) throw new Error(`preparing the computer failed: ${r.stderr.toString().slice(0, 500)}`);
      s.prepared = true;
    }
    const res = { spaceId: s.spaceId, sandbox: s.sandbox, created, started, ms: Date.now() - t0 };
    if (created || started) log.info("computer ready", res);
    return res;
  }

  private spec(s: State) {
    return {
      command: ["sleep", "infinity"],
      template: {
        image: this.cfg.image,
        resources: struct({ limits: { cpu: this.cfg.cpuLimit, memory: this.cfg.memoryLimit } }),
        driver_config: struct({
          docker: { mounts: [{ type: "volume", source: s.volume, target: `${this.cfg.sandboxRoot}/space`, read_only: false }] },
        }),
        labels: this.labels(),
      },
      policy: computerPolicy(),
    };
  }

  private async ensureVolume(name: string) {
    const res = await fetch(`${this.cfg.volumesUrl}/volumes/${name}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.cfg.volumesToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`volume helper answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  private async waitPhase(name: string, phases: Phase[], timeoutMs: number): Promise<SandboxInfo | null> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.getSandbox(name);
      if (!info || phases.includes(info.phase) || Date.now() > end) return info;
      await sleep(500);
    }
  }

  /** Stop and wait until stopped (or absent). */
  stop(spaceId: string, reason: string): Promise<void> {
    const s = this.state(spaceId);
    if (s.stopping) return s.stopping;
    s.keep = false;
    s.readyAt = null;
    s.prepared = false;
    s.stopping = (async () => {
      if (s.ensuring) await s.ensuring.catch(() => {});
      const info = await this.getSandbox(s.sandbox);
      if (!info || ["SANDBOX_PHASE_STOPPED", "SANDBOX_PHASE_COMPLETED"].includes(info.phase)) return;
      await traced("computer.stop", { "baskule.space": spaceId, reason }, async () => {
        if (reason === "idle") await traced("computer.clear_caches", {}, () => this.clearCaches(s.sandbox, spaceId));
        log.info("computer stop", { spaceId, reason });
        await this.gw.stop(s.sandbox);
        await this.waitPhase(s.sandbox, ["SANDBOX_PHASE_STOPPED", "SANDBOX_PHASE_ERROR", "SANDBOX_PHASE_COMPLETED"], 120_000);
      });
    })().finally(() => {
      s.stopping = null;
      s.readyAt = null;
      s.prepared = false;
    });
    return s.stopping;
  }

  /**
   * Drops regenerable caches from the per-space volume before an idle stop: a space lives for years, and these grow
   * with every install and every page browsed (41 of the 45 MB browser profile in the 2026-10-24 study). Best effort,
   * bounded: a failure or a slow volume never blocks the stop. The pnpm store is kept: projects hard-link from it.
   */
  private async clearCaches(sandbox: string, spaceId: string) {
    const started = Date.now();
    const home = `${this.cfg.sandboxRoot}/space/home`;
    const cleared = runCollect(this.gw, this.cfg.sandboxRoot, { sandbox, argv: ["sh", "-c", CLEAR_CACHES, "sh", home], raw: true })
      .then((r) => (r.code === 0 ? "ok" : `exit ${r.code}: ${r.stderr.toString().slice(0, 200)}`))
      .catch((e: any) => String(e?.message ?? e));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timeout"), CLEAR_CACHES_TIMEOUT_MS); });
    const outcome = await Promise.race([cleared, timedOut]).finally(() => clearTimeout(timer));
    log.info("computer caches cleared", { spaceId, outcome, ms: Date.now() - started });
  }

  /**
   * Delete the computer for good: the sandbox (OpenShell) and the per-space volume (/sandbox/space). Idempotent.
   * Waits for running ensure/stop operations, then for the sandbox to disappear (the volume stays in use until its
   * container is removed), then deletes the volume through the volume helper.
   */
  async delete(spaceId: string): Promise<{ spaceId: string; sandbox: string; sandboxDeleted: boolean; volumeDeleted: boolean }> {
    const s = this.state(spaceId);
    if (s.ensuring) await s.ensuring.catch(() => {});
    if (s.stopping) await s.stopping.catch(() => {});
    s.keep = false;
    s.readyAt = null;
    s.prepared = false;
    const existed = (await this.getSandbox(s.sandbox)) !== null;
    if (existed) {
      log.info("computer delete", { spaceId, sandbox: s.sandbox });
      await this.gw.remove(s.sandbox);
      const end = Date.now() + 120_000;
      while ((await this.getSandbox(s.sandbox)) !== null) {
        if (Date.now() > end) throw new Error("sandbox still present 120 s after DeleteSandbox");
        await sleep(500);
      }
    }
    let volumeDeleted = false;
    const end = Date.now() + 60_000;
    for (;;) {
      const res = await fetch(`${this.cfg.volumesUrl}/volumes/${s.volume}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.cfg.volumesToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok) {
        volumeDeleted = Boolean(body.deleted);
        break;
      }
      // 409 = still in use by a container being removed: retry.
      if (res.status !== 409 || Date.now() > end) throw new Error(`volume helper answered ${res.status}: ${body.error ?? ""}`);
      await sleep(1000);
    }
    this.states.delete(spaceId);
    return { spaceId, sandbox: s.sandbox, sandboxDeleted: existed, volumeDeleted };
  }

  /** Adopt computers that are running but unknown (computerd restarted): their idle clock starts now. */
  async adopt() {
    const list = await this.gw.list(Object.entries(this.labels()).map(([key, value]) => `${key}=${value}`).join(","));
    const bySandbox = new Map([...this.states.values()].map((s) => [s.sandbox, s]));
    for (const info of list) {
      if (info.phase !== "SANDBOX_PHASE_READY" || bySandbox.has(info.name)) continue;
      // We only know the sandbox name; track it under a synthetic key so the idle loop can stop it.
      const key = `sandbox:${info.name}`;
      if (this.states.has(key)) continue;
      this.states.set(key, {
        spaceId: key,
        sandbox: info.name,
        volume: "",
        lastActivity: Date.now(),
        streams: 0,
        keep: false,
        ensuring: null,
        stopping: null,
        readyAt: Date.now(),
        prepared: false,
      });
      log.info("adopted running computer", { sandbox: info.name });
    }
  }

  /** One pass of the idle policy (exported for tests). */
  async idleTick(now = Date.now()) {
    if (this.cfg.productSettingsUrl) {
      try {
        const r = await fetch(this.cfg.productSettingsUrl, { headers: { authorization: `Bearer ${this.cfg.token}` }, signal: AbortSignal.timeout(5_000) });
        if (!r.ok) return; // An unavailable control plane must not stop computers under the wrong policy.
        const { idleMinutes } = await r.json() as { idleMinutes: number };
        if (!Number.isFinite(idleMinutes) || idleMinutes < 0.1 || idleMinutes > 1440) return;
        this.cfg.idleMs = idleMinutes * 60_000;
      } catch { return; }
    }
    for (const s of [...this.states.values()]) {
      if (s.readyAt === null || s.keep || s.streams > 0 || s.ensuring || s.stopping) continue;
      if (now - s.lastActivity < this.cfg.idleMs) continue;
      try {
        if (s.spaceId.startsWith("sandbox:")) {
          if (this.cfg.instance) await this.getSandbox(s.sandbox);
          await this.gw.stop(s.sandbox);
          this.states.delete(s.spaceId);
          log.info("computer stop", { sandbox: s.sandbox, reason: "idle (adopted)" });
        } else await this.stop(s.spaceId, "idle");
      } catch (e: any) {
        log.warn("idle stop failed", { spaceId: s.spaceId, err: String(e?.message ?? e) });
      }
    }
  }

  startIdleLoop() {
    let busy = false;
    let adoptedAt = 0;
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (Date.now() - adoptedAt > 60_000) {
          adoptedAt = Date.now();
          await this.adopt().catch((e) => log.warn("adopt failed", { err: String(e?.message ?? e) }));
        }
        await this.idleTick();
      } finally {
        busy = false;
      }
    }, this.cfg.idleCheckMs);
    this.timer.unref();
  }

  stopIdleLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** JSON -> google.protobuf.Struct (proto-loader object form). */
export function struct(obj: Record<string, unknown>): any {
  return { fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, value(v)])) };
}

// protobufjs's bundled google/protobuf/struct.proto uses camelCase field names (even with keepCase).
function value(v: unknown): any {
  if (v === null || v === undefined) return { nullValue: "NULL_VALUE" };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { numberValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (Array.isArray(v)) return { listValue: { values: v.map(value) } };
  return { structValue: struct(v as Record<string, unknown>) };
}
