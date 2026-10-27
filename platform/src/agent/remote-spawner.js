// An Effect ChildProcessSpawner whose processes run on the space's computer, through computerd's exec route
// (architecture E4, computerd/v2/README.md "Exec"). It is the `spawner` of OpenCode's WorkspaceDriver, so the built-in
// shell/read/write/edit/patch/glob/grep tools (file ops = OpenCode's exec defaults: sh + GNU coreutils) all run there.
//
//   POST /v1/spaces/:id/exec  {argv, cwd, env, stdin(base64), id}  →  NDJSON {"t":"o"|"e","d":b64} … {"t":"x","code":N}
//   POST /v1/spaces/:id/kill  {id, signal, graceMs}
//
// stdin: celld buffers JS-built request bodies (no streaming), so a stdin Stream is collected first and sent with the
// request (exec-defaults' `write` is the only OpenCode caller that pipes stdin). A "pipe" stdin nobody wrote to is
// sent as empty (EOF). Abort/interrupt: the scope finalizer kills the process group (and aborts the stream, which
// computerd also treats as a kill).
import { Deferred, Effect, Exit, Queue, Sink, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { ExitCode, ProcessId, make, makeHandle } from "effect/process/ChildProcessSpawner";

const perr = (method, description, cause) =>
  systemError({ _tag: "Unknown", module: "RemoteSpawner", method, description, cause });

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const toBytes = (c) => (typeof c === "string" ? new TextEncoder().encode(c) : new Uint8Array(c));
const signalName = (s) => String(s ?? "SIGTERM").replace(/^SIG/, "");
const durationMs = (d, dflt) => {
  if (d === undefined || d === null) return dflt;
  if (typeof d === "number") return d;
  try { return Number(d.toMillis?.() ?? d.millis ?? dflt); } catch { return dflt; }
};

/** Parses an NDJSON body into frames. */
export async function* ndjson(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

/**
 * @param {{
 *   exec: (spec: {argv: string[], cwd?: string, env?: Record<string,string>, stdin?: string, id: string}, signal: AbortSignal) => Promise<Response>,
 *   kill: (id: string, signal: string, graceMs: number) => Promise<unknown>,
 *   log?: (line: string) => void,
 * }} computer
 */
export const makeRemoteSpawner = ({ exec, kill, log = () => {} }) =>
  make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.fail(perr("spawn", "piped commands are not supported on the computer"));
      const o = command.options ?? {};
      let argv = [command.command, ...command.args];
      if (o.shell) argv = [typeof o.shell === "string" ? o.shell : "/bin/sh", "-c", argv.join(" ")];
      const env = Object.fromEntries(Object.entries(o.env ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));

      // stdin: collect a provided Stream (celld cannot stream a request body built in JS).
      const si = o.stdin;
      const siStream = Stream.isStream(si) ? si : si && typeof si === "object" && Stream.isStream(si.stream) ? si.stream : undefined;
      let stdin;
      if (siStream) {
        const chunks = [];
        yield* Stream.runForEach(siStream, (c) => Effect.sync(() => chunks.push(toBytes(c))));
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        stdin = b64(all);
      }

      const id = crypto.randomUUID();
      const stdout = yield* Queue.unbounded();
      const stderr = yield* Queue.unbounded();
      const exit = yield* Deferred.make();
      const abort = new AbortController();
      const t0 = Date.now();
      const finish = (code, error) => {
        Queue.endUnsafe(stdout);
        Queue.endUnsafe(stderr);
        Deferred.doneUnsafe(exit, Exit.succeed([code, error]));
      };

      const res = yield* Effect.tryPromise({
        try: () => exec({ argv, ...(o.cwd ? { cwd: String(o.cwd) } : {}), env, ...(stdin !== undefined ? { stdin } : {}), id }, abort.signal),
        catch: (e) => perr("spawn", `cannot reach the computer: ${e?.message ?? e}`, e),
      });
      if (!res.ok) {
        const text = yield* Effect.promise(() => res.text().catch(() => ""));
        return yield* Effect.fail(perr("spawn", `computerd exec answered ${res.status}: ${text.slice(0, 300)}`));
      }
      log(`exec ${JSON.stringify(argv).slice(0, 120)} cwd=${o.cwd ?? "-"} (${Date.now() - t0} ms to start)`);
      (async () => {
        try {
          for await (const f of ndjson(res.body)) {
            if (f.t === "o") Queue.offerUnsafe(stdout, unb64(f.d));
            else if (f.t === "e") Queue.offerUnsafe(stderr, unb64(f.d));
            else if (f.t === "x") return finish(f.code, null);
            else if (f.t === "err") return finish(null, f.msg ?? "computer error");
          }
          finish(null, "the computer stream ended without an exit code");
        } catch (e) {
          finish(null, abort.signal.aborted ? "killed" : `computer stream error: ${e?.message ?? e}`);
        }
      })();

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(exit)) return;
          log(`exec ${id}: scope closed while running, killing`);
          yield* Effect.promise(() => kill(id, "KILL", 0).catch(() => {}));
          abort.abort();
        }),
      );
      const out = Stream.fromQueue(stdout);
      const err = Stream.fromQueue(stderr);
      return makeHandle({
        pid: ProcessId(1),
        exitCode: Effect.flatMap(Deferred.await(exit), ([code, error]) =>
          code !== null && code !== undefined ? Effect.succeed(ExitCode(code)) : Effect.fail(perr("exitCode", error ?? "process killed")),
        ),
        isRunning: Effect.map(Deferred.isDone(exit), (d) => !d),
        kill: (opts) =>
          Effect.gen(function* () {
            if (yield* Deferred.isDone(exit)) return;
            const signal = signalName(opts?.killSignal);
            yield* Effect.promise(() => kill(id, signal, durationMs(opts?.forceKillAfter, 3000)).catch(() => {}));
            yield* Deferred.await(exit).pipe(Effect.timeout("10 seconds"), Effect.ignore);
          }),
        stdin: Sink.drain,
        stdout: out,
        stderr: err,
        all: Stream.merge(out, err),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
