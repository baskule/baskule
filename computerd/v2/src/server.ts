// computerd v2 HTTP API (architecture E4). Bearer COMPUTERD_TOKEN on everything under /v1.
//   GET  /healthz
//   POST /v1/spaces/:id/computer/ensure   {"keep"?: boolean}
//   POST /v1/spaces/:id/computer/stop
//   POST /v1/spaces/:id/computer/delete   {"confirm": "<spaceId>"}  sandbox + volume, idempotent
//   GET  /v1/spaces/:id/computer
//   POST /v1/spaces/:id/exec              NDJSON frames {"t":"o"|"e","d":b64} ... {"t":"x","code":N} | {"t":"err","msg"}
//   POST /v1/spaces/:id/kill              {"id", "signal"?}
//   GET  /v1/spaces/:id/files?path=       stat/list JSON, or bytes (Range); &stat=1 for stat only
//   PUT  /v1/spaces/:id/files?path=       body = bytes (&type=dir to create a directory)
//   GET  /v1/spaces/:id/cdp[?target=]     WebSocket tunnel to the computer's Chromium DevTools
//   GET  /v1/spaces/:id/cdp/json[/list|/version]   DevTools HTTP discovery
import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Config } from "./config.ts";
import type { Gateway, ExecEvent } from "./gateway.ts";
import { Computers, TooManyStreams } from "./computers.ts";
import { EXEC_ID, SIGNALS, filterEnv, killExec, runCollect, startExec, type RunningExec } from "./exec.ts";
import {
  EXIT_STATUS, GET_SCRIPT, PUT_SCRIPT, PathError, normalizePath, parseEntries, parseRange, parseStat,
} from "./files.ts";
import { SPACE_ID } from "./policy.ts";
import { log } from "./log.ts";
import { parseTraceparent, startSpan, traced } from "./trace.ts";

const SPACE_PATH = /^\/v1\/spaces\/([^/]+)\/(.+)$/;
/** `/v1/spaces/<id>/browser/ws` → `browser/ws`: span names must not carry ids. */
const routeName = (path: string) => SPACE_PATH.exec(path)?.[2] ?? path;
const spaceOf = (path: string) => {
  const id = SPACE_PATH.exec(path)?.[1];
  return id === undefined ? undefined : decodeURIComponent(id);
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_JSON = 128 * 1024 * 1024;
const MAX_ARGV_BYTES = 200 * 1024; // OpenShell caps the assembled command at 256 KiB
const KILL_GRACE_MS = 3000;

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length, "cache-control": "no-store", ...extra });
  res.end(data);
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new HttpError(413, "request body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage, limit = MAX_JSON): Promise<any> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function validArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string"))
    throw new HttpError(400, "argv must be a non-empty array of strings");
  if (argv.some((a: string) => a.includes("\0"))) throw new HttpError(400, "argv must not contain NUL bytes");
  if (argv.reduce((n: number, a: string) => n + Buffer.byteLength(a) + 1, 0) > MAX_ARGV_BYTES)
    throw new HttpError(413, "argv too large (pass payloads on stdin)");
  return argv;
}

function validCwd(cwd: unknown): string | undefined {
  if (cwd === undefined || cwd === null || cwd === "") return undefined;
  if (typeof cwd !== "string" || !cwd.startsWith("/") || /[\0\n\r]/.test(cwd)) throw new HttpError(400, "cwd must be an absolute path");
  return cwd;
}

export interface ServerDeps {
  cfg: Config;
  gw: Gateway;
  computers: Computers;
}

export function createServer({ cfg, gw, computers }: ServerDeps) {
  const tokenBuf = Buffer.from(`Bearer ${cfg.token}`);
  const authorized = (req: http.IncomingMessage) => {
    const h = Buffer.from(String(req.headers.authorization ?? ""));
    return h.length === tokenBuf.length && timingSafeEqual(h, tokenBuf);
  };
  // exec id -> running exec (this replica only); kill also works by id across replicas via the pid file.
  const running = new Map<string, { spaceId: string; finished: boolean }>();

  async function ensureFor(spaceId: string) {
    try {
      await computers.ensure(spaceId);
    } catch (e: any) {
      throw new HttpError(503, `computer unavailable: ${e?.message ?? e}`);
    }
  }

  const sandboxOf = (spaceId: string) => computers.state(spaceId).sandbox;

  function acquire(spaceId: string) {
    try {
      return computers.acquire(spaceId);
    } catch (e) {
      if (e instanceof TooManyStreams) throw new HttpError(429, e.message);
      throw e;
    }
  }

  /** Kill the process group: TERM now, then KILL after the grace period (harmless if already gone). */
  function terminate(spaceId: string, id: string, graceMs = KILL_GRACE_MS) {
    const sandbox = sandboxOf(spaceId);
    killExec(gw, cfg.sandboxRoot, sandbox, id, "TERM").catch(() => {});
    if (graceMs > 0)
      setTimeout(() => killExec(gw, cfg.sandboxRoot, sandbox, id, "KILL").catch(() => {}), graceMs).unref();
  }

  // ---------------------------------------------------------------------------------------------- exec
  async function handleExec(spaceId: string, req: http.IncomingMessage, res: http.ServerResponse) {
    let meta: any;
    let stdin: Buffer | AsyncIterable<Buffer> | undefined;
    const ct = String(req.headers["content-type"] ?? "");
    if (ct.startsWith("application/octet-stream")) {
      const h = String(req.headers["x-baskule-exec"] ?? "");
      try {
        meta = JSON.parse(h.startsWith("{") ? h : Buffer.from(h, "base64url").toString("utf8"));
      } catch {
        throw new HttpError(400, "x-baskule-exec must be JSON (or base64url JSON)");
      }
      stdin = req;
    } else {
      meta = await readJson(req);
      if (meta.stdin !== undefined && meta.stdin !== null) {
        if (typeof meta.stdin !== "string") throw new HttpError(400, "stdin must be a base64 string");
        stdin = Buffer.from(meta.stdin, "base64");
      }
    }
    const argv = validArgv(meta.argv);
    const cwd = validCwd(meta.cwd);
    const { env } = filterEnv(meta.env);
    const id = meta.id === undefined ? randomUUID() : String(meta.id);
    if (!EXEC_ID.test(id)) throw new HttpError(400, "id must match [A-Za-z0-9_-]{1,64}");
    if (running.has(id)) throw new HttpError(409, "an exec with this id is running");
    const timeoutMs = meta.timeoutMs === undefined ? 0 : Number(meta.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new HttpError(400, "timeoutMs must be a positive number");

    const release = acquire(spaceId);
    let x: RunningExec;
    try {
      await ensureFor(spaceId);
      x = startExec(gw, cfg.sandboxRoot, { sandbox: sandboxOf(spaceId), argv, cwd, env, stdin, id });
    } catch (e) {
      release();
      throw e;
    }
    const entry = { spaceId, finished: false };
    running.set(id, entry);
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-exec-id": id });
    res.flushHeaders();
    const frame = (o: object) => res.write(JSON.stringify(o) + "\n");
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) timer = setTimeout(() => terminate(spaceId, id), timeoutMs);
    res.on("close", () => {
      if (!entry.finished) {
        // Client went away: cancelling the stream would leave the process running, so kill its group.
        terminate(spaceId, id);
        setTimeout(() => x.cancel(), KILL_GRACE_MS + 2000).unref();
      }
    });
    let exited = false;
    try {
      for await (const ev of x.events) {
        computers.touch(spaceId);
        if ("stdout" in ev) frame({ t: "o", d: ev.stdout.toString("base64") });
        else if ("stderr" in ev) frame({ t: "e", d: ev.stderr.toString("base64") });
        else {
          frame({ t: "x", code: ev.exit });
          exited = true;
          break;
        }
      }
      if (!exited) frame({ t: "err", msg: "exec stream ended without an exit status" });
    } catch (e: any) {
      frame({ t: "err", msg: String(e?.message ?? e) });
    } finally {
      entry.finished = true;
      running.delete(id);
      if (timer) clearTimeout(timer);
      release();
      x.cancel();
      res.end();
    }
  }

  async function handleKill(spaceId: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readJson(req, 64 * 1024);
    const id = String(body.id ?? "");
    if (!EXEC_ID.test(id)) throw new HttpError(400, "id is required");
    const signal = String(body.signal ?? "TERM").replace(/^SIG/, "").toUpperCase();
    if (!SIGNALS.has(signal)) throw new HttpError(400, `signal must be one of ${[...SIGNALS].join(", ")}`);
    // TERM escalates to KILL after graceMs (default 3000; 0 = never). Other signals never escalate.
    const graceMs = body.graceMs === undefined ? (signal === "TERM" ? KILL_GRACE_MS : 0) : Number(body.graceMs);
    if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 600_000) throw new HttpError(400, "graceMs must be 0..600000");
    const st = await computers.status(spaceId);
    if (!st.running) return json(res, 200, { id, killed: false, reason: "computer not running" });
    const killed = await killExec(gw, cfg.sandboxRoot, sandboxOf(spaceId), id, signal);
    if (killed && signal === "TERM" && graceMs > 0)
      setTimeout(() => killExec(gw, cfg.sandboxRoot, sandboxOf(spaceId), id, "KILL").catch(() => {}), graceMs).unref();
    json(res, 200, { id, killed });
  }

  // --------------------------------------------------------------------------------------------- files
  async function handleGetFile(spaceId: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const path = normalizePath(cfg.sandboxRoot, url.searchParams.get("path"));
    const statOnly = url.searchParams.get("stat") === "1";
    const range = parseRange(req.headers.range as string | undefined);
    if (range === "invalid") throw new HttpError(416, "invalid range");
    const start = range && range.start !== undefined ? String(range.start) : "";
    const count = range && range.end !== undefined && range.start !== undefined ? String(range.end - range.start + 1) : "";
    const suffix = range && range.suffix !== undefined ? String(range.suffix) : "";
    const release = acquire(spaceId);
    try {
      await ensureFor(spaceId);
      const x = startExec(gw, cfg.sandboxRoot, {
        sandbox: sandboxOf(spaceId),
        argv: ["sh", "-c", GET_SCRIPT, statOnly ? "stat" : "auto", path, start, count, suffix, cfg.sandboxRoot],
        raw: true,
      });
      // Header lines first ("<stat>\n", then "L\n" or "R\t<start>\t<count>\n"), then the payload is streamed.
      let head = Buffer.alloc(0);
      let phase = "h1" as "h1" | "h2" | "list" | "read" | "other";
      let info = null as ReturnType<typeof parseStat> | null;
      const listChunks: Buffer[] = [];
      let listBytes = 0;
      const errChunks: Buffer[] = [];
      let code: number | null = null;
      const it = x.events[Symbol.asyncIterator]();
      const onData = (d: Buffer) => {
        if (phase === "read") return void res.write(d);
        if (phase === "other") return;
        if (phase === "list") {
          listBytes += d.length;
          if (listBytes > 64 * 1024 * 1024) throw new HttpError(507, "directory listing too large");
          return void listChunks.push(d);
        }
        head = Buffer.concat([head, d]);
        for (;;) {
          const i = head.indexOf(10);
          if (i < 0) return;
          const line = head.subarray(0, i).toString("utf8");
          head = head.subarray(i + 1);
          if (phase === "h1") {
            info = parseStat(line);
            phase = statOnly ? "other" : "h2";
            continue;
          }
          if (line === "L") {
            phase = "list";
            if (head.length) listChunks.push(head);
            return;
          }
          const m = /^R\t(\d+)\t(\d+)$/.exec(line);
          if (!m) {
            phase = "other";
            return;
          }
          const st = Number(m[1]);
          const n = Number(m[2]);
          const headers: Record<string, string | number> = {
            "content-type": "application/octet-stream",
            "content-length": n,
            "accept-ranges": "bytes",
            "last-modified": new Date(info!.mtime).toUTCString(),
            "cache-control": "no-store",
            "x-baskule-file-mode": info!.mode,
          };
          if (range) headers["content-range"] = `bytes ${st}-${st + n - 1}/${info!.size}`;
          res.writeHead(range ? 206 : 200, headers);
          phase = "read";
          if (head.length) res.write(head);
          return;
        }
      };
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        const ev = r.value as ExecEvent;
        if ("stdout" in ev) onData(ev.stdout);
        else if ("stderr" in ev) errChunks.push(ev.stderr);
        else code = ev.exit;
      }
      computers.touch(spaceId);
      if (phase === "read") {
        res.end();
        return;
      }
      if (code === null) throw new HttpError(502, "exec stream ended without an exit status");
      if (code !== 0) {
        const [status, msg] = EXIT_STATUS[code] ?? [500, `stat failed (${code}): ${Buffer.concat(errChunks).toString().slice(0, 300)}`];
        throw new HttpError(status, msg);
      }
      if (!info) throw new HttpError(502, "no stat output");
      if (phase === "list") return json(res, 200, { path, ...info, entries: parseEntries(Buffer.concat(listChunks)) });
      return json(res, 200, { path, ...info });
    } finally {
      release();
    }
  }

  async function handlePutFile(spaceId: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const path = normalizePath(cfg.sandboxRoot, url.searchParams.get("path"));
    if (path === cfg.sandboxRoot) throw new PathError(403, "cannot write the sandbox root");
    const isDir = url.searchParams.get("type") === "dir";
    const len = req.headers["content-length"];
    if (len !== undefined && Number(len) > cfg.maxPutBytes) throw new HttpError(413, "file too large");
    const release = acquire(spaceId);
    try {
      await ensureFor(spaceId);
      let seen = 0;
      const body = isDir
        ? Buffer.alloc(0)
        : (async function* () {
            for await (const c of req) {
              seen += c.length;
              if (seen > cfg.maxPutBytes) throw new Error("too large");
              yield c as Buffer;
            }
          })();
      const r = await runCollect(gw, cfg.sandboxRoot, {
        sandbox: sandboxOf(spaceId),
        argv: ["sh", "-c", PUT_SCRIPT, isDir ? "dir" : "file", path, cfg.sandboxRoot, isDir ? "" : (len ?? "")],
        stdin: body,
        raw: true,
      });
      computers.touch(spaceId);
      if (r.code !== 0) {
        const [status, msg] = EXIT_STATUS[r.code] ?? [500, `write failed (${r.code}): ${r.stderr.toString().slice(0, 300)}`];
        throw new HttpError(status, msg);
      }
      json(res, 200, { path, type: isDir ? "dir" : "file", size: Number(r.stdout.toString().trim()) || 0 });
    } finally {
      release();
    }
  }

  const browserPort = cfg.browserPort;
  const browserStarts = new Map<string, Promise<void>>();
  async function ensureBrowserBridge(spaceId: string) {
    let pending = browserStarts.get(spaceId);
    if (!pending) {
      pending = (async () => {
        await ensureFor(spaceId);
        const result = await traced("browser.bridge.ensure", {}, () =>
          runCollect(gw, cfg.sandboxRoot, { sandbox: sandboxOf(spaceId), argv: ["baskule-browser-bridge", "ensure"], env: { BASKULE_BROWSER_PORT: String(browserPort) }, raw: true }));
        if (result.code !== 0) throw new HttpError(502, `browser bridge did not start: ${result.stderr.toString().slice(-400)}`);
      })();
      browserStarts.set(spaceId, pending);
      void pending.finally(() => browserStarts.delete(spaceId)).catch(() => {});
    }
    await pending;
  }
  async function browserHttp(spaceId: string, path: string, req: http.IncomingMessage, res: http.ServerResponse) {
    // Metadata subscriptions must not pin an otherwise idle computer awake.
    const metadata = path.startsWith("/events") || path.startsWith("/list");
    const release = metadata ? () => {} : acquire(spaceId);
    try {
      if (metadata) {
        if (!(await computers.status(spaceId)).running) throw new HttpError(503, "browser computer is asleep");
      } else await ensureBrowserBridge(spaceId);
      const upstream = http.request({ host: "127.0.0.1", port: browserPort, path, method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        createConnection: () => gw.forwardTcp(sandboxOf(spaceId), browserPort) as any,
      }, response => {
        res.writeHead(response.statusCode ?? 502, { "content-type": response.headers["content-type"] ?? "application/json", "cache-control": "no-store", ...(response.headers["content-disposition"] ? { "content-disposition": response.headers["content-disposition"] } : {}) });
        if (metadata) res.flushHeaders();
        if (!metadata) response.on("data", () => computers.touch(spaceId));
        response.pipe(res);
      });
      upstream.on("error", error => { if (!res.headersSent) json(res, 502, { error: error.message }); else res.destroy(); });
      res.on("close", () => { upstream.destroy(); release(); });
      req.pipe(upstream);
    } catch (error) { release(); throw error; }
  }

  // ---------------------------------------------------------------------------------------- routing
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://computerd");
    if (url.pathname === "/healthz") return void handleRequest(req, res, url);
    const span = startSpan(`computerd ${req.method} ${routeName(url.pathname)}`, { "baskule.space": spaceOf(url.pathname) },
      { parent: parseTraceparent(req.headers.traceparent), server: true });
    // Streams (exec, browser events) end with the response, so the span covers the whole stream.
    res.once("close", () => { span.set({ "http.status_code": res.statusCode }); span.end(res.statusCode >= 500 ? `status ${res.statusCode}` : undefined); });
    span.within(() => void handleRequest(req, res, url));
  });
  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    try {
      if (url.pathname === "/healthz") {
        return json(res, 200, { ok: true, service: "baskule-computerd", version: "0.2" });
      }
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not found");
      if (!authorized(req)) throw new HttpError(401, "unauthorized");
      const browserMatch = /^\/v1\/spaces\/([^/]+)\/browser\/(call|events|download|upload|peek)$/.exec(url.pathname);
      if (browserMatch) {
        const id = decodeURIComponent(browserMatch[1]);
        if (!SPACE_ID.test(id)) throw new HttpError(400, "invalid space id");
        if ((browserMatch[2] === "call" || browserMatch[2] === "upload") ? req.method !== "POST" : req.method !== "GET") throw new HttpError(405, "method not allowed");
        if (browserMatch[2] === "peek") {
          if (!(await computers.status(id)).running) return json(res, 200, { result: { sessions: [], serverEpoch: "baskule-idle", revision: 0 } });
          return await browserHttp(id, `/list${url.search}`, req, res);
        }
        return await browserHttp(id, `/${browserMatch[2]}${url.search}`, req, res);
      }
      const m = /^\/v1\/spaces\/([^/]+)\/(computer(?:\/ensure|\/stop|\/delete)?|exec|kill|files|cdp(?:\/json(?:\/list|\/version)?)?)$/.exec(url.pathname);
      if (!m) throw new HttpError(404, "not found");
      const spaceId = decodeURIComponent(m[1]);
      if (!SPACE_ID.test(spaceId)) throw new HttpError(400, "invalid space id");
      const route = `${req.method} ${m[2]}`;
      switch (route) {
        case "GET computer":
          return json(res, 200, await computers.status(spaceId));
        case "POST computer/ensure": {
          const body = await readJson(req, 64 * 1024);
          if (body.keep !== undefined && typeof body.keep !== "boolean") throw new HttpError(400, "keep must be a boolean");
          let r;
          try {
            r = await computers.ensure(spaceId, { keep: body.keep });
          } catch (e: any) {
            throw new HttpError(503, `computer unavailable: ${e?.message ?? e}`);
          }
          return json(res, 200, { ...(await computers.status(spaceId)), created: r.created, started: r.started, ms: r.ms });
        }
        case "POST computer/delete": {
          // Destructive and irreversible: the body must name the space being deleted.
          const body = await readJson(req, 64 * 1024);
          if (body.confirm !== spaceId) throw new HttpError(400, 'confirmation required: body {"confirm": "<spaceId>"}');
          try {
            return json(res, 200, await computers.delete(spaceId));
          } catch (e: any) {
            throw new HttpError(502, `delete failed: ${e?.message ?? e}`);
          }
        }
        case "POST computer/stop":
          await computers.stop(spaceId, "api");
          return json(res, 200, await computers.status(spaceId));
        case "POST exec":
          return await handleExec(spaceId, req, res);
        case "POST kill":
          return await handleKill(spaceId, req, res);
        case "GET files":
          return await handleGetFile(spaceId, url, req, res);
        case "PUT files":
          return await handlePutFile(spaceId, url, req, res);
        case "GET cdp/json":
        case "GET cdp/json/list":
        case "GET cdp/json/version":
          return await handleCdpJson(spaceId, m[2].endsWith("version") ? "/json/version" : "/json/list", res);
        default:
          if (m[2] === "cdp") throw new HttpError(426, "WebSocket upgrade required");
          throw new HttpError(405, "method not allowed");
      }
    } catch (e: any) {
      const status = e instanceof HttpError || e instanceof PathError ? e.status : 500;
      if (status >= 500) log.warn("request failed", { method: req.method, path: url.pathname, status, err: String(e?.message ?? e) });
      if (!res.headersSent) json(res, status, { error: String(e?.message ?? e) });
      else res.destroy();
    }
  }
  server.requestTimeout = 0; // long execs and uploads
  server.headersTimeout = 60_000;

  // ------------------------------------------------------------------------------- cdp (browser)
  async function browserEnsure(spaceId: string): Promise<any> {
    const r = await traced("browser.cdp.ensure", {}, () => runCollect(gw, cfg.sandboxRoot, {
      sandbox: sandboxOf(spaceId),
      argv: ["baskule-browser", "ensure"],
      env: { BASKULE_CDP_PORT: String(cfg.cdpPort) },
      raw: true,
    }));
    if (r.code !== 0) throw new HttpError(502, `browser did not start: ${r.stderr.toString().slice(-400)}`);
    try {
      return JSON.parse(r.stdout.toString());
    } catch {
      throw new HttpError(502, "browser answered an invalid /json/version");
    }
  }

  function cdpHttp(spaceId: string, path: string): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const rq = http.request(
        {
          host: "127.0.0.1",
          port: cfg.cdpPort,
          path,
          method: "GET",
          headers: { connection: "close" },
          createConnection: () => gw.forwardTcp(sandboxOf(spaceId), cfg.cdpPort) as any,
        },
        async (r) => {
          const chunks: Buffer[] = [];
          for await (const c of r) chunks.push(c);
          resolve({ status: r.statusCode ?? 502, body: Buffer.concat(chunks) });
        },
      );
      rq.setTimeout(15_000, () => rq.destroy(new Error("DevTools HTTP timeout")));
      rq.on("error", reject);
      rq.end();
    });
  }

  async function handleCdpJson(spaceId: string, path: string, res: http.ServerResponse) {
    const release = acquire(spaceId);
    try {
      await ensureFor(spaceId);
      await browserEnsure(spaceId);
      const r = await cdpHttp(spaceId, path);
      computers.touch(spaceId);
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(r.body);
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------- websockets
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });

  function rejectUpgrade(socket: Duplex, status: number, msg: string) {
    const body = JSON.stringify({ error: msg });
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://computerd");
    // Covers the WebSocket setup (computer + browser readiness), not the session that follows.
    const span = startSpan(`computerd WS ${routeName(url.pathname)}`, { "baskule.space": spaceOf(url.pathname) },
      { parent: parseTraceparent(req.headers.traceparent), server: true });
    void span.within(() => handleUpgrade(req, socket, head, url)).then(() => span.end(), (e) => span.end(e));
  });
  async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    let release: (() => void) | null = null;
    try {
      if (!authorized(req)) throw new HttpError(401, "unauthorized");
      const m = /^\/v1\/spaces\/([^/]+)\/(cdp|browser\/ws)$/.exec(url.pathname);
      if (!m) throw new HttpError(404, "not found");
      const spaceId = decodeURIComponent(m[1]);
      if (!SPACE_ID.test(spaceId)) throw new HttpError(400, "invalid space id");
      release = acquire(spaceId);
      await ensureFor(spaceId);
      await upgradeCdp(spaceId, url, req, socket, head, release, m[2] === "browser/ws");
    } catch (e: any) {
      release?.();
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.warn("upgrade failed", { path: url.pathname, err: String(e?.message ?? e) });
      rejectUpgrade(socket, status, String(e?.message ?? e));
      throw e;
    }
  }

  async function upgradeCdp(spaceId: string, url: URL, req: http.IncomingMessage, socket: Duplex, head: Buffer, release: () => void, bridge = false) {
    const target = url.searchParams.get("target");
    if (target !== null && !/^[A-Za-z0-9-]{1,64}$/.test(target)) throw new HttpError(400, "invalid target id");
    const version = bridge ? (await ensureBrowserBridge(spaceId), {}) : await browserEnsure(spaceId);
    let path: string;
    const port = bridge ? browserPort : cfg.cdpPort;
    if (bridge) path = `/ws${url.search}`;
    else if (target) path = `/devtools/page/${target}`;
    else {
      const u = String(version.webSocketDebuggerUrl ?? "");
      const pm = /^ws:\/\/[^/]+(\/devtools\/browser\/[A-Za-z0-9-]+)$/.exec(u);
      if (!pm) throw new HttpError(502, "browser did not report a DevTools endpoint");
      path = pm[1];
    }
    const sandbox = sandboxOf(spaceId);
    const upstream = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      createConnection: () => gw.forwardTcp(sandbox, port) as any,
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
      handshakeTimeout: 15_000,
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("open", () => resolve());
      upstream.once("error", (e) => reject(new HttpError(502, `DevTools connection failed: ${e.message}`)));
      upstream.once("unexpected-response", (_r, resp) => reject(new HttpError(resp.statusCode === 404 ? 404 : 502, `DevTools answered ${resp.statusCode}`)));
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      let closed = false;
      const done = (code = 1000, reason = Buffer.alloc(0)) => {
        if (closed) return;
        closed = true;
        release();
        const forwardedCode = [1005, 1006, 1015].includes(code) ? 1000 : code;
        if (ws.readyState === WebSocket.OPEN) ws.close(forwardedCode, reason);
        if (upstream.readyState === WebSocket.OPEN) upstream.close(forwardedCode, reason);
        else upstream.terminate();
      };
      ws.on("message", (d, isBinary) => {
        computers.touch(spaceId);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(d, { binary: isBinary });
      });
      upstream.on("message", (d, isBinary) => {
        computers.touch(spaceId);
        if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: isBinary });
      });
      ws.on("close", done);
      ws.on("error", () => done());
      upstream.on("close", done);
      upstream.on("error", () => done());
    });
  }

  return server;
}
