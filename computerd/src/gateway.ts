// Thin @grpc/grpc-js client for the OpenShell gateway (vendored protos in ../proto, from our fork).
// Only the RPCs computerd needs: sandbox lifecycle, interactive exec, TCP forward.
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export const PROTO_DIR = fileURLToPath(new URL("../proto", import.meta.url));
const WORKSPACE = { workspace: "default" };
/** OpenShell caps a gRPC message at 1 MiB; stdin is sent in chunks well below that. */
export const STDIN_CHUNK = 256 * 1024;

export function loadOpenShellPackage(): any {
  const def = protoLoader.loadSync(["openshell.proto"], {
    includeDirs: [PROTO_DIR],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(def) as any;
}

export type Phase =
  | "SANDBOX_PHASE_UNSPECIFIED"
  | "SANDBOX_PHASE_PROVISIONING"
  | "SANDBOX_PHASE_READY"
  | "SANDBOX_PHASE_ERROR"
  | "SANDBOX_PHASE_DELETING"
  | "SANDBOX_PHASE_UNKNOWN"
  | "SANDBOX_PHASE_STOPPING"
  | "SANDBOX_PHASE_STOPPED"
  | "SANDBOX_PHASE_STARTING"
  | "SANDBOX_PHASE_COMPLETED";

export interface SandboxInfo {
  name: string;
  phase: Phase;
  image: string;
  labels: Record<string, string>;
  conditions: { type: string; status: string; reason: string; message: string }[];
}

export interface ExecStart {
  sandbox: string;
  command: string[];
  workdir?: string;
  environment?: Record<string, string>;
}

export type ExecEvent = { stdout: Buffer } | { stderr: Buffer } | { exit: number };

/** A running interactive exec: events out, stdin in. */
export interface ExecHandle {
  writeStdin(chunk: Buffer): Promise<void>;
  endStdin(): void;
  cancel(): void;
  events: AsyncIterable<ExecEvent>;
}

export class GatewayError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function wrap(err: any): GatewayError {
  return new GatewayError(err?.code ?? grpc.status.UNKNOWN, err?.details || err?.message || String(err));
}

export class Gateway {
  client: any;

  constructor(address: string) {
    const pkg = loadOpenShellPackage();
    this.client = new pkg.openshell.v1.OpenShell(address, grpc.credentials.createInsecure(), {
      "grpc.max_receive_message_length": 8 * 1024 * 1024,
      "grpc.keepalive_time_ms": 30_000,
    });
  }

  close() {
    this.client.close();
  }

  private unary<T>(method: string, req: object, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      this.client[method](req, { deadline: Date.now() + timeoutMs }, (err: any, res: T) =>
        err ? reject(wrap(err)) : resolve(res),
      );
    });
  }

  static info(sandbox: any): SandboxInfo {
    return {
      name: sandbox?.metadata?.name ?? "",
      phase: (sandbox?.status?.phase ?? "SANDBOX_PHASE_UNSPECIFIED") as Phase,
      image: sandbox?.spec?.template?.image ?? "",
      labels: sandbox?.metadata?.labels ?? {},
      conditions: (sandbox?.status?.conditions ?? []).map((c: any) => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        message: c.message,
      })),
    };
  }

  /** null when the sandbox does not exist. */
  async get(name: string): Promise<SandboxInfo | null> {
    try {
      const res: any = await this.unary("GetSandbox", { name, workspace_scope: WORKSPACE });
      return Gateway.info(res.sandbox);
    } catch (e) {
      if (e instanceof GatewayError && e.code === grpc.status.NOT_FOUND) return null;
      throw e;
    }
  }

  async list(labelSelector: string): Promise<SandboxInfo[]> {
    const out: SandboxInfo[] = [];
    let page_token = "";
    do {
      const res: any = await this.unary("ListSandboxes", {
        workspace_scope: WORKSPACE,
        page_size: 1000,
        page_token,
        label_selector: labelSelector,
      });
      for (const s of res.sandboxes ?? []) out.push(Gateway.info(s));
      page_token = res.next_page_token ?? "";
    } while (page_token);
    return out;
  }

  async create(req: {
    name: string;
    spec: object;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  }): Promise<SandboxInfo> {
    const res: any = await this.unary("CreateSandbox", { ...req, workspace_scope: WORKSPACE }, 120_000);
    return Gateway.info(res.sandbox);
  }

  async start(name: string): Promise<SandboxInfo> {
    const res: any = await this.unary("StartSandbox", { name, workspace_scope: WORKSPACE }, 60_000);
    return Gateway.info(res.sandbox);
  }

  async stop(name: string): Promise<SandboxInfo> {
    const res: any = await this.unary("StopSandbox", { name, workspace_scope: WORKSPACE }, 60_000);
    return Gateway.info(res.sandbox);
  }

  async remove(name: string): Promise<void> {
    await this.unary("DeleteSandbox", { name, workspace_scope: WORKSPACE, allow_missing: true }, 60_000);
  }

  /** Interactive exec (bidi): the only exec form that accepts stdin larger than one gRPC message. */
  exec(start: ExecStart): ExecHandle {
    const call = this.client.ExecSandboxInteractive();
    const queue: (ExecEvent | { error: GatewayError } | { end: true })[] = [];
    let wake: (() => void) | null = null;
    const push = (x: (typeof queue)[number]) => {
      queue.push(x);
      wake?.();
      wake = null;
    };
    let done = false;
    call.on("data", (ev: any) => {
      if (ev.stdout) push({ stdout: Buffer.from(ev.stdout.data) });
      else if (ev.stderr) push({ stderr: Buffer.from(ev.stderr.data) });
      else if (ev.exit) push({ exit: ev.exit.exit_code });
    });
    call.on("error", (err: any) => push({ error: wrap(err) }));
    call.on("end", () => push({ end: true }));
    call.write({
      start: {
        sandbox: start.sandbox,
        workspace_scope: WORKSPACE,
        command: start.command,
        workdir: start.workdir ?? "",
        environment: start.environment ?? {},
        no_login_shell: true,
        tty: false,
      },
    });
    let stdinEnded = false;
    const events: AsyncIterable<ExecEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ExecEvent>> => {
          for (;;) {
            if (done) return { done: true, value: undefined };
            const x = queue.shift();
            if (x) {
              if ("error" in x) {
                done = true;
                throw x.error;
              }
              if ("end" in x) {
                done = true;
                return { done: true, value: undefined };
              }
              return { done: false, value: x };
            }
            await new Promise<void>((r) => (wake = r));
          }
        },
        return: async () => {
          done = true;
          return { done: true, value: undefined };
        },
      }),
    };
    return {
      events,
      writeStdin: (chunk: Buffer) =>
        new Promise<void>((resolve) => {
          if (stdinEnded || done) return resolve();
          for (let i = 0; i < chunk.length; i += STDIN_CHUNK) {
            const ok = call.write({ stdin: chunk.subarray(i, i + STDIN_CHUNK) });
            if (!ok && i + STDIN_CHUNK >= chunk.length) return call.once("drain", resolve);
          }
          resolve();
        }),
      endStdin: () => {
        if (stdinEnded) return;
        stdinEnded = true;
        try {
          call.end();
        } catch {}
      },
      cancel: () => {
        try {
          call.cancel();
        } catch {}
      },
    };
  }

  /** A raw TCP stream to 127.0.0.1:<port> inside the sandbox (ForwardTcp). */
  forwardTcp(sandbox: string, port: number): Duplex {
    const call = this.client.ForwardTcp();
    const duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        call.write({ data: chunk }, cb);
      },
      final(cb) {
        try {
          call.end();
        } catch {}
        cb();
      },
      destroy(err, cb) {
        try {
          call.cancel();
        } catch {}
        cb(err);
      },
    });
    call.on("data", (fr: any) => {
      if (fr.data && fr.data.length) duplex.push(Buffer.from(fr.data));
    });
    call.on("end", () => duplex.push(null));
    call.on("error", (err: any) => {
      if (err?.code === grpc.status.CANCELLED) duplex.push(null);
      else duplex.destroy(wrap(err));
    });
    call.write({ init: { sandbox, workspace: "default", tcp: { host: "127.0.0.1", port } } });
    // `ws` and `http` treat the connection as a net.Socket.
    Object.assign(duplex, {
      setNoDelay() {},
      setKeepAlive() {},
      setTimeout() {},
      ref() {},
      unref() {},
    });
    return duplex;
  }
}
