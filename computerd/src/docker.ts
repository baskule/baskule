import http from "node:http";
import { Duplex } from "node:stream";
import type { Backend, Machine, MachineSpec, ExecStart, ExecHandle, ExecEvent } from "./backend.ts";

class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
interface Inspection {
  Name: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: { Running: boolean; Status: string; Error: string };
}
const key = encodeURIComponent;

/** Docker Engine transport; only the configured Unix socket is used. */
export class DockerBackend implements Backend {
  private readonly socketPath: string;
  private readonly network: string;
  constructor(host = "unix:///var/run/docker.sock", network = "baskule-computers") {
    this.network = network;
    this.socketPath = host.replace(/^unix:\/\//, "");
    if (!this.socketPath.startsWith("/")) throw new Error("DOCKER_HOST must be an absolute Unix socket path");
  }
  private request<T>(method: string, path: string, body?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ socketPath: this.socketPath, path, method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      }, async res => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of res) chunks.push(Buffer.from(chunk));
          const text = Buffer.concat(chunks).toString();
          if ((res.statusCode ?? 500) >= 400) throw new DockerError(res.statusCode!, text);
          resolve(text ? JSON.parse(text) : undefined);
        } catch (error) { reject(error); }
      });
      req.setTimeout(180_000, () => req.destroy(new Error("Docker request timed out")));
      req.on("error", reject);
      req.end(data);
    });
  }
  async get(name: string): Promise<Machine | null> {
    try {
      const c = await this.request<Inspection>("GET", `/containers/${key(name)}/json`);
      return { name: c.Name.replace(/^\//, ""), image: c.Config.Image, labels: c.Config.Labels ?? {},
        phase: c.State.Running ? "ready" : c.State.Error ? "error" : "stopped", error: c.State.Error || null };
    } catch (e) { if (e instanceof DockerError && e.status === 404) return null; throw e; }
  }
  async list(labels: Record<string, string>): Promise<Machine[]> {
    const filters = key(JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) }));
    const rows = await this.request<{ Id: string }[]>("GET", `/containers/json?all=true&filters=${filters}`);
    const machines = await Promise.all(rows.map(row => this.get(row.Id)));
    return machines.filter((m): m is Machine => m !== null);
  }
  async create(spec: MachineSpec): Promise<Machine> {
    if (await this.get(spec.name)) return this.start(spec.name);
    try { await this.request("GET", `/networks/${key(this.network)}`); }
    catch (e) {
      if (!(e instanceof DockerError && e.status === 404)) throw e;
      try { await this.request("POST", "/networks/create", { Name: this.network, Driver: "bridge", CheckDuplicate: true }); }
      catch (e) { if (!(e instanceof DockerError && e.status === 409)) throw e; }
    }
    const memory = /^(\d+(?:\.\d+)?)([KMGT]i?)?$/.exec(spec.memory);
    if (!memory) throw new Error(`Unsupported memory quantity: ${spec.memory}`);
    const unit = memory[2] ?? "";
    const bytes = Number(memory[1]) * (unit ? (unit.endsWith("i") ? 1024 : 1000) ** ("KMGT".indexOf(unit[0]) + 1) : 1);
    await this.request("POST", "/volumes/create", { Name: spec.disk, Labels: spec.labels });
    try {
      await this.request("POST", `/containers/create?name=${key(spec.name)}`, {
        Image: spec.image, Cmd: ["sleep", "infinity"], User: "1000:1000", Labels: { ...spec.annotations, ...spec.labels },
        HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], PidsLimit: 1024,
          NanoCpus: Math.round(Number(spec.cpus) * 1e9), Memory: Math.round(bytes), NetworkMode: this.network,
          Mounts: [{ Type: "volume", Source: spec.disk, Target: "/sandbox/space" }] },
      });
    } catch (e) { if (!(e instanceof DockerError && e.status === 409)) throw e; }
    return this.start(spec.name);
  }
  async start(name: string): Promise<Machine> {
    await this.request("POST", `/containers/${key(name)}/start`);
    const machine = await this.get(name);
    if (machine?.phase !== "ready") throw new Error(`Container ${name} did not start`);
    return machine;
  }
  async stop(name: string): Promise<void> {
    try { await this.request("POST", `/containers/${key(name)}/stop?t=1`); }
    catch (e) { if (!(e instanceof DockerError && e.status === 404)) throw e; }
  }
  async remove(name: string, disk: string) {
    let machineDeleted = false, diskDeleted = false;
    try { await this.request("DELETE", `/containers/${key(name)}?force=true`); machineDeleted = true; }
    catch (e) { if (!(e instanceof DockerError && e.status === 404)) throw e; }
    try { await this.request("DELETE", `/volumes/${key(disk)}`); diskDeleted = true; }
    catch (e) { if (!(e instanceof DockerError && e.status === 404)) throw e; }
    return { machineDeleted, diskDeleted };
  }
  exec(start: ExecStart): ExecHandle {
    let cancelled = false;
    const connection = this.request<{ Id: string }>("POST", `/containers/${key(start.machine)}/exec`, {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
      Cmd: start.command, WorkingDir: start.workdir,
      Env: Object.entries(start.environment ?? {}).map(([k, v]) => `${k}=${v}`),
    }).then(async ({ Id }) => {
      const socket = await new Promise<Duplex>((resolve, reject) => {
        const body = JSON.stringify({ Detach: false, Tty: false });
        const req = http.request({ socketPath: this.socketPath, path: `/exec/${key(Id)}/start`, method: "POST",
          headers: { Connection: "Upgrade", Upgrade: "tcp", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } });
        req.on("upgrade", (_res, socket, head) => { if (head.length) socket.unshift(head); resolve(socket); });
        req.on("response", res => { res.resume(); reject(new Error(`Docker exec upgrade failed: ${res.statusCode}`)); });
        req.on("error", reject);
        req.end(body);
      });
      if (cancelled) socket.destroy();
      return { socket, Id };
    });
    // Consumers may supply stdin before they begin reading output.
    connection.catch(() => {});
    const self = this;
    async function* events(): AsyncGenerator<ExecEvent> {
      const { socket, Id } = await connection;
      let pending = Buffer.alloc(0);
      for await (const chunk of socket) {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 8) {
          const size = pending.readUInt32BE(4);
          if (size > 64 * 1024 * 1024) throw new Error("Invalid Docker stream frame");
          if (pending.length < size + 8) break;
          const data = pending.subarray(8, 8 + size);
          yield pending[0] === 2 ? { stderr: data } : { stdout: data };
          pending = pending.subarray(8 + size);
        }
      }
      if (pending.length) throw new Error("Truncated Docker stream frame");
      const result = await self.request<{ ExitCode: number; Running: boolean }>("GET", `/exec/${key(Id)}/json`);
      if (result.Running) throw new Error("Docker exec stream ended before process exit");
      yield { exit: result.ExitCode };
    }
    return { events: events(),
      async writeStdin(chunk) { const { socket } = await connection; await new Promise<void>((resolve, reject) => socket.write(chunk, e => e ? reject(e) : resolve())); },
      endStdin() { void connection.then(({ socket }) => socket.end()).catch(() => {}); },
      cancel() { cancelled = true; void connection.then(({ socket }) => socket.destroy()).catch(() => {}); },
    };
  }
  connect(name: string, port: number): Duplex {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TCP port");
    // Python is already installed in the computer image. Separate directions preserve TCP half-close.
    const relay = `import socket,sys,threading,os\ns=socket.create_connection(('127.0.0.1',${port}))\ndef send():\n while True:\n  b=os.read(0,65536)\n  if not b: break\n  s.sendall(b)\n s.shutdown(socket.SHUT_WR)\nthreading.Thread(target=send,daemon=True).start()\nwhile True:\n b=s.recv(65536)\n if not b: break\n sys.stdout.buffer.write(b); sys.stdout.buffer.flush()`;
    const handle = this.exec({ machine: name, command: ["python3", "-u", "-c", relay] });
    const stream = new Duplex({ read() {}, write(chunk, _encoding, cb) { handle.writeStdin(chunk).then(() => cb(), cb); },
      final(cb) { handle.endStdin(); cb(); }, destroy(error, cb) { handle.cancel(); cb(error); } });
    void (async () => { for await (const event of handle.events) {
      if ("stdout" in event) stream.push(event.stdout);
      else if ("exit" in event && event.exit !== 0) throw new Error(`TCP relay exited ${event.exit}`);
    } stream.push(null); })().catch(e => stream.destroy(e));
    Object.assign(stream, { setNoDelay() {}, setKeepAlive() {}, setTimeout() {}, ref() {}, unref() {} });
    return stream;
  }
  close() {}
}
