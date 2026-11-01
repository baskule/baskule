// baskule: an in-process stand-in for computerd's files and exec endpoints (E4), backed by a
// host directory that plays the role of the computer's `/sandbox`.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface FakeComputerd {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: Array<string>;
  /** Phase answered by `GET /v1/spaces/:id/computer` (default "absent"). */
  phase: string;
  /** Maps a computer path (`/sandbox/...`) to the host directory. */
  readonly hostPath: (path: string) => string;
}

export const makeFakeComputerd = (hostRoot: string, sandboxRoot = "/sandbox"): FakeComputerd => {
  const calls: Array<string> = [];
  const hostPath = (path: string) => {
    if (path !== sandboxRoot && !path.startsWith(`${sandboxRoot}/`))
      throw new Error(`outside sandbox: ${path}`);
    return NodePath.join(hostRoot, path.slice(sandboxRoot.length));
  };
  const toComputer = (text: string) => text.split(hostRoot).join(sandboxRoot);
  const frame = (o: unknown) => `${JSON.stringify(o)}\n`;

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const files = /\/v1\/spaces\/[^/]+\/files$/.test(url.pathname);
    const exec = /\/v1\/spaces\/[^/]+\/exec$/.test(url.pathname);
    calls.push(`${request.method} ${exec ? "exec" : files ? "files" : url.pathname}`);
    if (!request.headers.get("authorization")?.startsWith("Bearer "))
      return new Response("no token", { status: 401 });
    if (request.method === "GET" && /\/v1\/spaces\/[^/]+\/computer$/.test(url.pathname))
      return Response.json({ phase: fake.phase, running: fake.phase === "ready" });
    if (files) {
      const computerPath = url.searchParams.get("path") ?? "";
      const path = hostPath(computerPath);
      const info = (q: string, st: NodeFS.Stats) => ({
        path: q,
        type: st.isDirectory()
          ? "dir"
          : st.isFile()
            ? "file"
            : st.isSymbolicLink()
              ? "symlink"
              : "other",
        size: st.size,
        mtime: st.mtime.toISOString(),
        mode: st.mode & 0o7777,
      });
      if (request.method === "PUT") {
        if (url.searchParams.get("type") === "dir") NodeFS.mkdirSync(path, { recursive: true });
        else {
          NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
          NodeFS.writeFileSync(path, new Uint8Array(await request.arrayBuffer()));
        }
        return Response.json(info(computerPath, NodeFS.statSync(path)));
      }
      if (!NodeFS.existsSync(path)) return Response.json({ error: "not found" }, { status: 404 });
      const st = NodeFS.statSync(path);
      if (url.searchParams.get("stat") === "1") return Response.json(info(computerPath, st));
      if (st.isDirectory()) {
        const entries = NodeFS.readdirSync(path).map((name) => ({
          ...info(name, NodeFS.lstatSync(NodePath.join(path, name))),
          name,
        }));
        return Response.json({ ...info(computerPath, st), entries });
      }
      const data = NodeFS.readFileSync(path);
      const headers = { "x-baskule-file-mode": String(st.mode & 0o7777) };
      const range = /^bytes=(\d+)-(\d+)?$/.exec(request.headers.get("range") ?? "");
      if (range) {
        const start = Number(range[1]);
        const end =
          range[2] === undefined ? data.length - 1 : Math.min(Number(range[2]), data.length - 1);
        return new Response(data.subarray(start, end + 1), { status: 206, headers });
      }
      return new Response(data, { headers });
    }
    if (exec && request.method === "POST") {
      const spec = (await request.json()) as { argv: Array<string>; cwd?: string; stdin?: string };
      // Scripts see host paths; translate computer paths in argv and back in the output.
      const argv = spec.argv.map((a) => (a.startsWith(sandboxRoot) ? hostPath(a) : a));
      const result = NodeChildProcess.spawnSync(argv[0]!, argv.slice(1), {
        cwd: spec.cwd ? hostPath(spec.cwd) : hostRoot,
        input: spec.stdin ? Buffer.from(spec.stdin, "base64") : undefined,
      });
      if (result.error) return new Response(frame({ t: "err", msg: String(result.error) }));
      const body =
        frame({ t: "o", d: Buffer.from(toComputer(result.stdout.toString())).toString("base64") }) +
        frame({ t: "e", d: Buffer.from(toComputer(result.stderr.toString())).toString("base64") }) +
        frame({ t: "x", code: result.status ?? 1 });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    }
    return new Response("not found", { status: 404 });
  };
  const fake: FakeComputerd = {
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handle(new Request(input, init))) as typeof globalThis.fetch,
    calls,
    phase: "absent",
    hostPath,
  };
  return fake;
};
