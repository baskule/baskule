// Exec inside a computer: argv only (no shell strings built from caller input), a `setsid` wrapper that records
// the process group so it can be killed (OpenShell has no kill RPC and cancelling a stream leaks the process),
// an environment allowlist, and stdin streamed in < 1 MiB gRPC messages.
import { randomUUID } from "node:crypto";
import type { ExecEvent, Gateway } from "./gateway.ts";

export const EXEC_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SIGNALS = new Set(["TERM", "KILL", "INT", "HUP", "QUIT", "USR1", "USR2"]);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_EXACT = new Set([
  "PATH", "HOME", "LANG", "LANGUAGE", "TERM", "TZ", "COLUMNS", "LINES", "NO_COLOR", "FORCE_COLOR", "CI", "PAGER",
  "EDITOR", "VISUAL", "TMPDIR", "NODE_ENV", "NODE_OPTIONS", "DEBIAN_FRONTEND", "USER", "SHELL", "VIRTUAL_ENV",
]);
const ENV_PREFIXES = ["LC_", "PYTHON", "PIP_", "NPM_CONFIG_", "npm_config_", "BUN_", "GIT_", "OPENCODE", "BASKULE_", "UV_"];
// Never overridable: the supervisor's CA wiring and OpenShell's own markers.
const ENV_DENY_PREFIXES = ["OPENSHELL_", "LD_"];

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

/** Environment every exec gets (OpenShell does not apply the image ENV to exec'd processes). */
export function baseEnv(root: string): Record<string, string> {
  const home = `${root}/space/home`;
  return {
    HOME: home,
    PATH: `${home}/.local/bin:${home}/.local/share/pnpm:${home}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    LANG: "en_US.UTF-8",
    TZ: "Etc/UTC",
    NPM_CONFIG_PREFIX: `${home}/.local`,
    // pnpm refuses global installs without a global bin directory.
    PNPM_HOME: `${home}/.local/share/pnpm`,
    BUN_INSTALL: `${home}/.bun`,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    CHROME_PATH: "/usr/local/bin/chromium-baskule",
  };
}

// The wrapper records the process group: setsid made this sh a session + group leader, so its pid is the pgid.
// Killing: OpenShell's seccomp filter refuses kill() on a process group (negative pid, EPERM, verified), but a
// later exec may signal individual pids, so the kill helper enumerates the group (pgrep -g) and signals each.
// $0 = exec id, $@ = the command.
const WRAP = 'mkdir -p /tmp/.osj 2>/dev/null; echo $$ > "/tmp/.osj/$0"; "$@"; c=$?; rm -f "/tmp/.osj/$0"; exit $c';
// $0 = exec id, $1 = signal, $2 = "final" (remove the record). Exit 3: no such exec; 0: signalled (or empty group).
const KILL = [
  'f="/tmp/.osj/$0"; p=$(cat "$f" 2>/dev/null) || exit 3',
  'case "$p" in ""|*[!0-9]*) exit 3;; esac',
  'pids=$(pgrep -g "$p")',
  '[ -n "$pids" ] && kill -s "$1" $pids 2>/dev/null',
  '[ "$2" = final ] && rm -f "$f"',
  "exit 0",
].join("\n");

export function wrapArgv(id: string, argv: string[]): string[] {
  return ["setsid", "-w", "sh", "-c", WRAP, id, ...argv];
}

export function killArgv(id: string, signal: string, final = false): string[] {
  return ["sh", "-c", KILL, id, signal, final ? "final" : ""];
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
  /** Do not wrap with setsid (internal one-shot helpers that must not be killable / counted). */
  raw?: boolean;
}

export interface RunningExec {
  id: string;
  events: AsyncIterable<ExecEvent>;
  write(chunk: Buffer): Promise<void>;
  endStdin(): void;
  /** Cancel the stream (does NOT kill the process: use kill()). */
  cancel(): void;
}

export function startExec(gw: Gateway, root: string, o: ExecOptions): RunningExec {
  const id = o.id ?? randomUUID();
  const h = gw.exec({
    sandbox: o.sandbox,
    command: o.raw ? o.argv : wrapArgv(id, o.argv),
    workdir: o.cwd,
    environment: { ...baseEnv(root), ...(o.env ?? {}) },
  });
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
  gw: Gateway,
  root: string,
  o: ExecOptions,
  maxBytes = 64 * 1024 * 1024,
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  const x = startExec(gw, root, o);
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
export async function killExec(gw: Gateway, root: string, sandbox: string, id: string, signal: string): Promise<boolean> {
  const r = await runCollect(gw, root, { sandbox, argv: killArgv(id, signal, signal === "KILL"), raw: true });
  return r.code === 0;
}
