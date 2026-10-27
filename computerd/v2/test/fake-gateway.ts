// A fake OpenShell gateway (gRPC, same vendored protos) for unit tests. Sandboxes are records with scripted phase
// transitions; execs run the requested argv LOCALLY (the test points SANDBOX_ROOT at a temp dir), so computerd's
// real wrapper, kill and file scripts are exercised. ForwardTcp dials 127.0.0.1:<port> locally.
import { spawn } from "node:child_process";
import net from "node:net";
import * as grpc from "@grpc/grpc-js";
import { loadOpenShellPackage } from "../src/gateway.ts";

interface Sbx {
  name: string;
  phase: string;
  labels: Record<string, string>;
  spec: any;
  pending: string[]; // phases to go through on the next GetSandbox calls
}

export class FakeGateway {
  server = new grpc.Server();
  port = 0;
  sandboxes = new Map<string, Sbx>();
  calls: { method: string; req: any }[] = [];
  execs: { command: string[]; environment: Record<string, string>; workdir: string; stdinChunks: number[] }[] = [];
  /** Phases a start goes through; set to include SANDBOX_PHASE_ERROR to test recovery (consumed once). */
  nextStartPhases: string[] | null = null;

  async start(): Promise<number> {
    const pkg = loadOpenShellPackage();
    const svc = pkg.openshell.v1.OpenShell.service;
    const notFound = (cb: any) => cb({ code: grpc.status.NOT_FOUND, details: "sandbox not found" });
    const view = (s: Sbx) => ({
      metadata: { name: s.name, labels: s.labels },
      spec: s.spec,
      status: { phase: s.phase, conditions: [] },
    });
    const advance = (s: Sbx) => {
      const p = s.pending.shift();
      if (p) s.phase = p;
    };
    this.server.addService(svc, {
      GetSandbox: (call: any, cb: any) => {
        this.calls.push({ method: "GetSandbox", req: call.request });
        const s = this.sandboxes.get(call.request.name);
        if (!s) return notFound(cb);
        advance(s);
        cb(null, { sandbox: view(s) });
      },
      ListSandboxes: (call: any, cb: any) => {
        this.calls.push({ method: "ListSandboxes", req: call.request });
        cb(null, { sandboxes: [...this.sandboxes.values()].filter((s) =>
          String(call.request.label_selector ?? "").split(",").filter(Boolean).every((term) => {
            const [key, value] = term.split("=");
            return s.labels[key.trim()] === value.trim();
          }),
        ).map(view), next_page_token: "" });
      },
      CreateSandbox: (call: any, cb: any) => {
        this.calls.push({ method: "CreateSandbox", req: call.request });
        const r = call.request;
        if (this.sandboxes.has(r.name)) return cb({ code: grpc.status.ALREADY_EXISTS, details: "exists" });
        const s: Sbx = { name: r.name, phase: "SANDBOX_PHASE_PROVISIONING", labels: r.labels, spec: r.spec, pending: ["SANDBOX_PHASE_PROVISIONING", "SANDBOX_PHASE_READY"] };
        this.sandboxes.set(r.name, s);
        cb(null, { sandbox: view(s) });
      },
      StartSandbox: (call: any, cb: any) => {
        this.calls.push({ method: "StartSandbox", req: call.request });
        const s = this.sandboxes.get(call.request.name);
        if (!s) return notFound(cb);
        s.phase = "SANDBOX_PHASE_STARTING";
        s.pending = this.nextStartPhases ?? ["SANDBOX_PHASE_READY"];
        this.nextStartPhases = null;
        cb(null, { sandbox: view(s) });
      },
      StopSandbox: (call: any, cb: any) => {
        this.calls.push({ method: "StopSandbox", req: call.request });
        const s = this.sandboxes.get(call.request.name);
        if (!s) return notFound(cb);
        s.phase = "SANDBOX_PHASE_STOPPING";
        s.pending = ["SANDBOX_PHASE_STOPPED"];
        cb(null, { sandbox: view(s) });
      },
      DeleteSandbox: (call: any, cb: any) => {
        this.sandboxes.delete(call.request.name);
        cb(null, {});
      },
      ExecSandboxInteractive: (call: any) => {
        let child: ReturnType<typeof spawn> | null = null;
        const rec = { command: [] as string[], environment: {} as Record<string, string>, workdir: "", stdinChunks: [] as number[] };
        call.on("data", (msg: any) => {
          if (msg.start) {
            const st = msg.start;
            const s = this.sandboxes.get(st.sandbox);
            if (!s || s.phase !== "SANDBOX_PHASE_READY") {
              call.emit("error", { code: grpc.status.FAILED_PRECONDITION, details: "sandbox is not ready" });
              return;
            }
            rec.command = st.command;
            rec.environment = st.environment;
            rec.workdir = st.workdir;
            this.execs.push(rec);
            child = spawn(st.command[0], st.command.slice(1), {
              cwd: st.workdir || undefined,
              env: { ...st.environment },
              stdio: ["pipe", "pipe", "pipe"],
            });
            child.stdout!.on("data", (d) => call.write({ stdout: { data: d } }));
            child.stderr!.on("data", (d) => call.write({ stderr: { data: d } }));
            child.stdin!.on("error", () => {});
            child.on("error", (e) => {
              call.write({ stderr: { data: Buffer.from(String(e.message)) } });
              call.write({ exit: { exit_code: 127 } });
              call.end();
            });
            child.on("close", (code, sig) => {
              call.write({ exit: { exit_code: code ?? 128 + (sig ? 9 : 0) } });
              call.end();
            });
          } else if (msg.stdin && child) {
            rec.stdinChunks.push(msg.stdin.length);
            child.stdin!.write(msg.stdin);
          }
        });
        call.on("end", () => child?.stdin?.end());
        call.on("cancelled", () => child?.stdin?.end());
      },
      ForwardTcp: (call: any) => {
        let sock: net.Socket | null = null;
        call.on("data", (fr: any) => {
          if (fr.init) {
            sock = net.connect(fr.init.tcp.port, "127.0.0.1");
            sock.on("data", (d) => call.write({ data: d }));
            sock.on("end", () => call.end());
            sock.on("error", () => call.end());
          } else if (fr.data && sock) sock.write(fr.data);
        });
        call.on("end", () => sock?.end());
        call.on("cancelled", () => sock?.destroy());
      },
    });
    this.port = await new Promise<number>((res, rej) =>
      this.server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))),
    );
    return this.port;
  }

  stop() {
    this.server.forceShutdown();
  }
}
