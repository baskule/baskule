// Computer lifecycle: one machine per space (`os-<spaceId>`), a per-space labelled volume at
// /sandbox/space, lazy create/start, idle stop. All durable state lives in
// the backend; this class only keeps soft state (activity, stream counts, keep flags) that is rebuilt on restart.
import { closeSessions, liveSession } from "./session.ts";
import type { Config } from "./config.ts";
import type { Backend, Machine } from "./backend.ts";
import { namesFor } from "./policy.ts";
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

interface State {
  spaceId: string;
  sandbox: string;
  volume: string;
  lastActivity: number;
  streams: number; // running exec/cdp/files streams
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
  private backend: Backend;
  private cfg: Config;

  constructor(backend: Backend, cfg: Config) {
    this.backend = backend;
    this.cfg = cfg;
  }

  private labels(): Record<string, string> {
    return { [MANAGED_LABEL]: "true", ...(this.cfg.instance ? { [INSTANCE_LABEL]: this.cfg.instance } : {}) };
  }

  private async getSandbox(name: string): Promise<Machine | null> {
    const info = await this.backend.get(name);
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
    const phase = info?.phase ?? "absent";
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
      error: phase === "error" ? info?.error || null : null,
    };
  }

  /** Make the computer Ready (create / start), then prepare it once (mkdir home, chats). */
  ensure(spaceId: string, opts: { keep?: boolean } = {}): Promise<EnsureResult> {
    const s = this.state(spaceId);
    s.lastActivity = Date.now();
    if (opts.keep !== undefined) s.keep = opts.keep;
    if (s.ensuring) return s.ensuring;
    // An open agent session proves the machine is running: its stream ends when the machine stops.
    if (s.prepared && s.readyAt !== null && Date.now() - s.readyAt < 5000 && !s.stopping && liveSession(this.backend, s.sandbox)) {
      return Promise.resolve({ spaceId: s.spaceId, sandbox: s.sandbox, created: false, started: false, ms: 0 });
    }
    // Otherwise query the backend: a computer stopped behind our back is restarted.
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
    const spec = {
      name: s.sandbox, disk: s.volume, legacyDisk: namesFor(s.spaceId, "").volume, image: this.cfg.image,
      cpus: this.cfg.cpuLimit, memory: this.cfg.memoryLimit,
      labels: this.labels(), annotations: { "baskule.space": s.spaceId },
    };
    if (!info) {
      info = await this.backend.create(spec);
      created = true;
    }
    const needsUpdate = async (machine: Machine) => {
      const imageId = await this.backend.imageId(spec.image);
      const quantity = (value: string) => {
        const match = /^(\d+(?:\.\d+)?)([KMGT]i?|m)?$/.exec(value);
        if (!match) return NaN;
        const unit = match[2] ?? "";
        return Number(match[1]) * (unit === "m" ? 0.001 : unit ? (unit.endsWith("i") ? 1024 : 1000) ** ("KMGT".indexOf(unit[0]) + 1) : 1);
      };
      return (imageId && machine.imageId ? imageId !== machine.imageId : machine.image !== spec.image) ||
        (machine.cpus !== undefined && quantity(machine.cpus) !== quantity(spec.cpus)) ||
        (machine.memory !== undefined && quantity(machine.memory) !== quantity(spec.memory));
    };
    const deadline = Date.now() + this.cfg.readyTimeoutMs;
    let recovered = false;
    while (info.phase !== "ready") {
      if (info.phase === "error") {
        if (recovered) throw new Error(info.error ?? "computer is in error");
        recovered = true;
        closeSessions(this.backend, s.sandbox);
        await this.backend.stop(s.sandbox);
        if (await needsUpdate(info)) {
          log.info("computer image update", { sandbox: s.sandbox, oldImage: info.image, newImage: this.cfg.image });
          closeSessions(this.backend, s.sandbox);
          info = await this.backend.recreate(spec);
        } else info = await this.backend.start(s.sandbox);
        started = true;
        continue;
      }
      if (Date.now() > deadline) throw new Error("computer not ready before timeout");
      if (info.phase === "stopped") {
        closeSessions(this.backend, s.sandbox);
        if (await needsUpdate(info)) {
          log.info("computer image update", { sandbox: s.sandbox, oldImage: info.image, newImage: this.cfg.image });
          closeSessions(this.backend, s.sandbox);
          info = await this.backend.recreate(spec);
        } else info = await this.backend.start(s.sandbox);
        started = true;
      } else {
        await sleep(300);
        const next = await this.getSandbox(s.sandbox);
        if (!next) throw new Error("computer disappeared while starting");
        info = next;
      }
    }
    s.readyAt = Date.now();
    s.lastActivity = Date.now();
    if (created || started || !s.prepared) {
      // The per-space volume is copied from the image on first mount (it has home/); chats/ is ours.
      const r = await traced("computer.prepare", {}, () => runCollect(this.backend, this.cfg.sandboxRoot, {
        sandbox: s.sandbox,
        argv: ["mkdir", "-p", "--", `${this.cfg.sandboxRoot}/space/home`, `${this.cfg.sandboxRoot}/space/chats`],
      }));
      if (r.code !== 0) throw new Error(`preparing the computer failed: ${r.stderr.toString().slice(0, 500)}`);
      s.prepared = true;
    }
    const res = { spaceId: s.spaceId, sandbox: s.sandbox, created, started, ms: Date.now() - t0 };
    if (created || started) log.info("computer ready", res);
    return res;
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
      if (!info || info.phase === "stopped") { closeSessions(this.backend, s.sandbox); return; }
      await traced("computer.stop", { "baskule.space": spaceId, reason }, async () => {
        if (reason === "idle") await traced("computer.clear_caches", {}, () => this.clearCaches(s.sandbox, spaceId));
        log.info("computer stop", { spaceId, reason });
        closeSessions(this.backend, s.sandbox);
        await this.backend.stop(s.sandbox);
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
    const cleared = runCollect(this.backend, this.cfg.sandboxRoot, { sandbox, argv: ["sh", "-c", CLEAR_CACHES, "sh", home] })
      .then((r) => (r.code === 0 ? "ok" : `exit ${r.code}: ${r.stderr.toString().slice(0, 200)}`))
      .catch((e: any) => String(e?.message ?? e));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timeout"), CLEAR_CACHES_TIMEOUT_MS); });
    const outcome = await Promise.race([cleared, timedOut]).finally(() => clearTimeout(timer));
    log.info("computer caches cleared", { spaceId, outcome, ms: Date.now() - started });
  }

  /** Delete the machine and persistent disk after pending lifecycle operations finish. */
  async delete(spaceId: string): Promise<{ spaceId: string; sandbox: string; sandboxDeleted: boolean; volumeDeleted: boolean }> {
    const s = this.state(spaceId);
    if (s.ensuring) await s.ensuring.catch(() => {});
    if (s.stopping) await s.stopping.catch(() => {});
    s.keep = false;
    s.readyAt = null;
    s.prepared = false;
    await this.getSandbox(s.sandbox); // Verify instance ownership before removal.
    closeSessions(this.backend, s.sandbox);
    const result = await this.backend.remove(s.sandbox, s.volume, namesFor(spaceId, "").volume);
    this.states.delete(spaceId);
    return { spaceId, sandbox: s.sandbox, sandboxDeleted: result.machineDeleted, volumeDeleted: result.diskDeleted };
  }

  /** Adopt computers that are running but unknown (computerd restarted): their idle clock starts now. */
  async adopt() {
    const list = await this.backend.list(this.labels());
    const bySandbox = new Map([...this.states.values()].map((s) => [s.sandbox, s]));
    for (const info of list) {
      if (info.phase !== "ready" || bySandbox.has(info.name)) continue;
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
          closeSessions(this.backend, s.sandbox);
          await this.backend.stop(s.sandbox);
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

