// What computerd needs from the machine layer that runs computers. Two implementations: `docker.ts` drives one
// Docker Engine (single-machine Compose and development), `kubernetes.ts` drives agent-sandbox `Sandbox` objects.
// Lifecycle calls converge: running one twice, or after a crash halfway, reaches the same end state.
import type { Duplex } from "node:stream";

export type MachinePhase = "starting" | "ready" | "stopping" | "stopped" | "error";

export interface Machine {
  name: string;
  phase: MachinePhase;
  image: string;
  labels: Record<string, string>;
  /** Why the machine is in `error`, otherwise null. */
  error: string | null;
}

export interface MachineSpec {
  name: string;
  /** Persistent disk mounted at `${sandboxRoot}/space`; survives stop, start and machine replacement. */
  disk: string;
  image: string;
  /** Decimal CPUs, e.g. "2". */
  cpus: string;
  /** Kubernetes quantity, e.g. "3Gi". */
  memory: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface ExecStart {
  machine: string;
  command: string[];
  workdir?: string;
  environment?: Record<string, string>;
}

export type ExecEvent = { stdout: Buffer } | { stderr: Buffer } | { exit: number };

/** A running exec: events out, stdin in. */
export interface ExecHandle {
  writeStdin(chunk: Buffer): Promise<void>;
  endStdin(): void;
  cancel(): void;
  events: AsyncIterable<ExecEvent>;
}

export interface Backend {
  /** null when the machine does not exist. */
  get(name: string): Promise<Machine | null>;
  /** Machines carrying every given label. */
  list(labels: Record<string, string>): Promise<Machine[]>;
  /** Creates the disk if missing, then the machine, and resolves once it is ready. An existing machine is started. */
  create(spec: MachineSpec): Promise<Machine>;
  /** Resolves once the machine is ready. */
  start(name: string): Promise<Machine>;
  /** Resolves once the machine is stopped or absent. The disk is kept. */
  stop(name: string): Promise<void>;
  /** Removes the machine and its disk; resolves once both are gone. */
  remove(name: string, disk: string): Promise<{ machineDeleted: boolean; diskDeleted: boolean }>;
  exec(start: ExecStart): ExecHandle;
  /** A TCP stream to 127.0.0.1:<port> inside the machine. */
  connect(name: string, port: number): Duplex;
  close(): void;
}
