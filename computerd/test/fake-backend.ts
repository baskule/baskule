import { closeSessions, liveSession } from "../src/session.ts";
import { spawn } from "node:child_process";
import net from "node:net";
import type { Backend, Machine, MachineSpec, ExecStart, ExecHandle, ExecEvent } from "../src/backend.ts";

/** Commands execute locally with the test's temporary sandbox paths. */
export class FakeBackend implements Backend {
  environment: NodeJS.ProcessEnv = process.env;
  sandboxes = new Map<string, Machine>();
  disks = new Set<string>();
  calls: { method: string; req: MachineSpec | { name: string } }[] = [];
  execs: { command: string[]; environment: Record<string, string>; workdir: string; stdinChunks: number[] }[] = [];
  async imageId(_image: string): Promise<string | null> { return null; }
  async get(name: string) { return this.sandboxes.get(name) ?? null; }
  async list(labels: Record<string, string>) {
    return [...this.sandboxes.values()].filter(s => Object.entries(labels).every(([k,v]) => s.labels[k] === v));
  }
  async create(spec: MachineSpec) {
    this.calls.push({ method: "create", req: spec });
    this.disks.add(spec.disk);
    if (!this.sandboxes.has(spec.name)) this.sandboxes.set(spec.name, { name: spec.name, phase: "ready", image: spec.image, labels: spec.labels, error: null });
    return this.start(spec.name);
  }
  async recreate(spec: MachineSpec): Promise<Machine> {
    this.calls.push({ method: "recreate", req: spec });
    this.sandboxes.delete(spec.name);
    return this.create(spec);
  }
  async start(name: string) {
    const s = this.sandboxes.get(name);
    if (!s) throw new Error("machine not found");
    s.phase = "ready";
    return s;
  }
  async stop(name: string) {
    this.calls.push({ method: "stop", req: { name } });
    const s = this.sandboxes.get(name);
    if (s) s.phase = "stopped";
    await this.endStreams(name);
  }
  /** The machine fails behind computerd's back: like a real backend, its exec streams end. */
  async fail(name: string, error = "machine failed") {
    const s = this.sandboxes.get(name)!;
    s.phase = "error"; s.error = error;
    await this.endStreams(name);
  }
  private children = new Map<string, Set<ReturnType<typeof spawn>>>();
  private async endStreams(name: string) {
    const children = [...(this.children.get(name) ?? [])];
    const closed = Promise.all(children.map(child => new Promise<void>(resolve => child.once("close", () => resolve()))));
    for (const child of children) child.kill("SIGKILL");
    await closed;
    const deadline = Date.now() + 5000;
    while (liveSession(this, name)) {
      if (Date.now() > deadline) throw Error("session did not observe EOF");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  async remove(name: string, disk: string) {
    await this.endStreams(name);
    return { machineDeleted: this.sandboxes.delete(name), diskDeleted: this.disks.delete(disk) };
  }
  exec(st: ExecStart): ExecHandle {
    if (this.sandboxes.get(st.machine)?.phase !== "ready") throw new Error("machine is not ready");
    const rec = { command: st.command, environment: st.environment ?? {}, workdir: st.workdir ?? "", stdinChunks: [] as number[] };
    this.execs.push(rec);
    const child = spawn(st.command[0], st.command.slice(1), { cwd: st.workdir, env: { ...this.environment, ...rec.environment }, stdio: ["pipe", "pipe", "pipe"] });
    let running = this.children.get(st.machine);
    if (!running) this.children.set(st.machine, running = new Set());
    running.add(child);
    child.on("close", () => running.delete(child));
    const queue: ExecEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const emit = (e: ExecEvent) => { queue.push(e); wake?.(); };
    child.stdout.on("data", d => emit({ stdout: d }));
    child.stderr.on("data", d => emit({ stderr: d }));
    child.stdin.on("error", () => {});
    child.on("error", e => emit({ stderr: Buffer.from(e.message) }));
    child.on("close", (code, sig) => { emit({ exit: code ?? (sig ? 137 : 127) }); done = true; wake?.(); });
    return {
      async writeStdin(chunk) { rec.stdinChunks.push(chunk.length); await new Promise<void>(resolve => child.stdin.write(chunk, () => resolve())); },
      endStdin() { child.stdin.end(); },
      cancel() { child.stdin.end(); },
      events: (async function* () {
        while (!done || queue.length) {
          if (queue.length) yield queue.shift()!;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      })(),
    };
  }
  connect(_name: string, port: number) { return net.connect(port, "127.0.0.1"); }
  close() { closeSessions(this); }
}
