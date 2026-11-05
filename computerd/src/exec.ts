// Exec and Files commands share one multiplexed agent session per computer.
import { sessionFor } from "./session.ts";
import { randomUUID } from "node:crypto";
import type { ExecEvent, Backend } from "./backend.ts";

export const EXEC_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SIGNALS = new Set(["TERM", "KILL", "INT", "HUP", "QUIT", "USR1", "USR2"]);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_EXACT = new Set([
  "PATH", "HOME", "LANG", "LANGUAGE", "TERM", "TZ", "COLUMNS", "LINES", "NO_COLOR", "FORCE_COLOR", "CI", "PAGER",
  "EDITOR", "VISUAL", "TMPDIR", "NODE_ENV", "NODE_OPTIONS", "DEBIAN_FRONTEND", "USER", "SHELL", "VIRTUAL_ENV",
]);
const ENV_PREFIXES = ["LC_", "PYTHON", "PIP_", "NPM_CONFIG_", "npm_config_", "BUN_", "GIT_", "OPENCODE", "BASKULE_", "UV_"];
// Never allow dynamic loader overrides.
const ENV_DENY_PREFIXES = ["LD_"];

/** Keep allowlisted keys only (silently drops the rest); returns the dropped keys for the caller's information. */
export function filterEnv(env: Record<string, unknown> | undefined): { env: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    const ok =
      ENV_KEY.test(k) &&
      typeof v === "string" &&
      !v.includes("\0") &&
      v.length <= 32 * 1024 &&
      !ENV_DENY_PREFIXES.some((p) => k.startsWith(p)) &&
      (ENV_EXACT.has(k) || ENV_PREFIXES.some((p) => k.startsWith(p)));
    if (ok) out[k] = v as string;
    else dropped.push(k);
  }
  return { env: out, dropped };
}

// $0 = exec id, $1 = signal, $2 = "final" (remove the record). Exit 3: no such exec; 0: signalled (or empty group).
const KILL = [
  'f="/tmp/.osj/$0"; p=$(cat "$f" 2>/dev/null) || exit 3',
  'case "$p" in ""|*[!0-9]*) exit 3;; esac',
  'kill -s "$1" -- "-$p" 2>/dev/null',
  '[ "$2" = final ] && rm -f "$f"',
  "exit 0",
].join("\n");

export function killArgv(id: string, signal: string, final = false): string[] {
  return ["bash", "-c", KILL, id, signal, final ? "final" : ""];
}

export interface ExecOptions {
  sandbox: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Bytes for stdin; or an async source (request body); omitted = empty stdin. Ignored when `interactive`. */
  stdin?: Buffer | AsyncIterable<Buffer | Uint8Array>;
  /** Keep stdin open; feed it with write(). */
  interactive?: boolean;
  id?: string;
}

export interface RunningExec {
  id: string;
  events: AsyncIterable<ExecEvent>;
  write(chunk: Buffer): Promise<void>;
  endStdin(): void;
  /** Cancel the stream (does NOT kill the process: use kill()). */
  cancel(): void;
}

export function startExec(backend: Backend, o: ExecOptions): RunningExec {
  const id = o.id ?? randomUUID();
  const h = sessionFor(backend, o.sandbox).start({
    machine: o.sandbox,
    command: o.argv,
    workdir: o.cwd,
    environment: o.env,
  }, id);
  if (!o.interactive) {
    (async () => {
      try {
        if (Buffer.isBuffer(o.stdin)) await h.writeStdin(o.stdin);
        else if (o.stdin) for await (const c of o.stdin) await h.writeStdin(Buffer.from(c));
      } catch {
        // the body stream failed: close stdin anyway, the process sees EOF
      }
      h.endStdin();
    })();
  }
  return { id, events: h.events, write: (c) => h.writeStdin(c), endStdin: () => h.endStdin(), cancel: () => h.cancel() };
}

/** Run to completion and collect output (internal helpers: mkdir, kill, stat...). */
export async function runCollect(
  backend: Backend,
  o: ExecOptions,
  maxBytes = 64 * 1024 * 1024,
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  const x = startExec(backend, o);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let n = 0;
  let code: number | null = null;
  for await (const ev of x.events) {
    if ("stdout" in ev) {
      n += ev.stdout.length;
      if (n > maxBytes) {
        x.cancel();
        throw new Error("output too large");
      }
      out.push(ev.stdout);
    } else if ("stderr" in ev) err.push(ev.stderr);
    else code = ev.exit;
  }
  if (code === null) throw new Error("exec stream ended without an exit status");
  return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

/** Signal every process of the exec's process group. false = no such (running) exec. */
export async function killExec(backend: Backend, sandbox: string, id: string, signal: string): Promise<boolean> {
  if (sessionFor(backend, sandbox).kill(id, signal)) return true;
  const r = await runCollect(backend, { sandbox, argv: killArgv(id, signal, signal === "KILL") });
  return r.code === 0;
}
