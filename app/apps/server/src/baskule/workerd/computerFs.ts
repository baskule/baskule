// baskule: the space computer's files, through computerd (architecture v3, E4).  computerd v2 API used here (computerd/v2/README.md; under `${COMPUTERD_URL}/v1`, bearer `COMPUTERD_TOKEN`): - `GET  /spaces/:id/files?path=&stat=1` → `{path, type:
// file|dir|symlink|other, size, mtime}`; - `GET  /spaces/:id/files?path=` → a file's bytes (honours `Range`), or for a directory   `{type: "dir", entries: [{name, type, …}]}`; 404 when missing; - `PUT  /spaces/:id/files?path=` → writes the body, creating
// parents; `&type=dir` makes a dir; - `POST /spaces/:id/exec` with JSON `{"argv": [...], "cwd"?, "stdin"?: base64}` → frames   `{"t":"o"|"e","d":base64}`, then `{"t":"x","code":N}` or `{"t":"err","msg":…}`. Exclusive mkdir, rm and mv run as small POSIX `sh`
// scripts through exec.

export interface ComputerFsConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly spaceId: string;
  readonly fetch?: typeof globalThis.fetch;
}

export type ComputerEntryType = "File" | "Directory" | "SymbolicLink" | "Unknown";

export interface ComputerStat {
  readonly type: ComputerEntryType;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ComputerDirent {
  readonly name: string;
  readonly type: ComputerEntryType;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type ComputerFsErrorKind =
  | "NotFound"
  | "AlreadyExists"
  | "NotADirectory"
  | "Unavailable"
  | "Failed";

export class ComputerFsError extends Error {
  readonly kind: ComputerFsErrorKind;
  constructor(kind: ComputerFsErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const decoder = new TextDecoder();
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const TYPE_BY_NAME: Record<string, ComputerEntryType> = {
  file: "File",
  dir: "Directory",
  symlink: "SymbolicLink",
};

// Exit codes the scripts use to report a classified failure.
const EXIT_NOT_FOUND = 44;
const EXIT_EXISTS = 45;
const EXIT_NOT_DIR = 46;

const SCRIPTS = {
  mkdir: `[ -e "$1" ] && exit ${EXIT_EXISTS}; mkdir -- "$1" 2>/dev/null || { [ -d "$(dirname -- "$1")" ] || exit ${EXIT_NOT_FOUND}; exit 1; }`,
  rm: `[ -e "$1" ] || [ -L "$1" ] || exit ${EXIT_NOT_FOUND}; rm -f -- "$1" 2>/dev/null || rmdir -- "$1"`,
  rmrf: `[ -e "$1" ] || [ -L "$1" ] || exit ${EXIT_NOT_FOUND}; rm -rf -- "$1"`,
  mv: `[ -e "$1" ] || exit ${EXIT_NOT_FOUND}; mkdir -p -- "$(dirname -- "$2")" && mv -f -- "$1" "$2"`,
} as const;

export interface ComputerFs {
  readonly stat: (path: string) => Promise<ComputerStat>;
  readonly list: (path: string) => Promise<ReadonlyArray<ComputerDirent>>;
  /** The raw response, so callers can stream it; `range` is an HTTP `Range` value. */
  readonly read: (path: string, range?: string) => Promise<Response>;
  readonly readAll: (path: string) => Promise<Uint8Array>;
  readonly write: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<void>;
  readonly remove: (path: string, options?: { readonly recursive?: boolean }) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  /** baskule(wp-h): the computer's phase (`GET /computer`, never starts it); "absent" on errors. */
  readonly phase: () => Promise<string>;
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: { readonly cwd?: string; readonly stdin?: Uint8Array },
  ) => Promise<ExecResult>;
}

export const makeComputerFs = (config: ComputerFsConfig): ComputerFs => {
  const doFetch = config.fetch ?? globalThis.fetch;
  const base = `${config.baseUrl.replace(/\/+$/, "")}/v1/spaces/${encodeURIComponent(config.spaceId)}`;
  const headers = (extra?: Record<string, string>) => ({
    authorization: `Bearer ${config.token}`,
    ...extra,
  });
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await doFetch(url, init);
    } catch (cause) {
      throw new ComputerFsError("Unavailable", `computerd unreachable: ${String(cause)}`);
    }
  };
  const fileUrl = (path: string) => `${base}/files?path=${encodeURIComponent(path)}`;
  const failFor = async (response: Response, path: string) => {
    if (response.ok) return;
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    if (response.status === 404)
      throw new ComputerFsError("NotFound", `no such file or directory: ${path}`);
    if (response.status === 503) throw new ComputerFsError("Unavailable", `computerd: ${detail}`);
    throw new ComputerFsError("Failed", `computerd files answered ${response.status}: ${detail}`);
  };
  const getJson = async (url: string, path: string): Promise<unknown> => {
    const response = await request(url, { headers: headers() });
    await failFor(response, path);
    return response.json();
  };

  const exec: ComputerFs["exec"] = async (argv, options) => {
    const response = await request(`${base}/exec`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        argv,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.stdin ? { stdin: toBase64(options.stdin) } : {}),
      }),
    });
    if (!response.ok) {
      throw new ComputerFsError(
        response.status === 503 ? "Unavailable" : "Failed",
        `computerd exec answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }
    const stdout: Array<Uint8Array> = [];
    const stderr: Array<Uint8Array> = [];
    let code: number | undefined;
    for (const line of (await response.text()).split("\n")) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as { t: string; d?: string; code?: number; msg?: string };
      if (frame.t === "o" && frame.d) stdout.push(fromBase64(frame.d));
      else if (frame.t === "e" && frame.d) stderr.push(fromBase64(frame.d));
      else if (frame.t === "x") code = frame.code ?? 0;
      else if (frame.t === "err") throw new ComputerFsError("Failed", `exec failed: ${frame.msg}`);
    }
    if (code === undefined)
      throw new ComputerFsError("Failed", "exec stream ended without an exit");
    return { code, stdout: concat(stdout), stderr: concat(stderr) };
  };

  const script = async (name: keyof typeof SCRIPTS, ...args: ReadonlyArray<string>) => {
    const result = await exec(["sh", "-c", SCRIPTS[name], "sh", ...args]);
    const detail = `${name} ${args.join(" ")}: ${decoder.decode(result.stderr).trim().slice(0, 200)}`;
    switch (result.code) {
      case 0:
        return decoder.decode(result.stdout);
      case EXIT_NOT_FOUND:
        throw new ComputerFsError("NotFound", `no such file or directory: ${args[0]}`);
      case EXIT_EXISTS:
        throw new ComputerFsError("AlreadyExists", `already exists: ${args[0]}`);
      case EXIT_NOT_DIR:
        throw new ComputerFsError("NotADirectory", `not a directory: ${args[0]}`);
      default:
        throw new ComputerFsError("Failed", detail);
    }
  };

  return {
    exec,
    phase: async () => {
      try {
        const response = await request(`${base}/computer`, { headers: headers() });
        if (!response.ok) return "absent";
        const status = (await response.json()) as { readonly phase?: string };
        return status.phase ?? "absent";
      } catch {
        return "absent";
      }
    },
    stat: async (path) => {
      const info = (await getJson(`${fileUrl(path)}&stat=1`, path)) as {
        readonly type: string;
        readonly size?: number;
        readonly mtime?: string;
      };
      return {
        type: TYPE_BY_NAME[info.type] ?? "Unknown",
        size: Number(info.size ?? 0),
        mtimeMs: info.mtime ? Date.parse(info.mtime) : 0,
      };
    },
    list: async (path) => {
      const response = await request(fileUrl(path), { headers: headers() });
      await failFor(response, path);
      const dir = response.headers.has("x-baskule-file-mode")
        ? undefined
        : ((await response.json()) as {
            readonly type?: string;
            readonly entries?: ReadonlyArray<{ readonly name: string; readonly type: string }>;
          });
      if (dir?.type !== "dir")
        throw new ComputerFsError("NotADirectory", `not a directory: ${path}`);
      return (dir.entries ?? []).map((e) => ({
        name: e.name,
        type: TYPE_BY_NAME[e.type] ?? "Unknown",
      }));
    },
    read: async (path, range) => {
      const response = await request(fileUrl(path), {
        headers: headers(range ? { range } : undefined),
      });
      if (response.status === 404) throw new ComputerFsError("NotFound", `no such file: ${path}`);
      // A range starting at or past the end (readers probe for EOF): no bytes.
      if (response.status === 416) return new Response(new Uint8Array(), { status: 206 });
      if (!response.ok && response.status !== 206) {
        throw new ComputerFsError(
          response.status === 503 ? "Unavailable" : "Failed",
          `computerd files answered ${response.status}`,
        );
      }
      return response;
    },
    readAll: async (path) => {
      const response = await request(fileUrl(path), { headers: headers() });
      if (response.status === 404) throw new ComputerFsError("NotFound", `no such file: ${path}`);
      if (!response.ok)
        throw new ComputerFsError("Failed", `computerd files answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    write: async (path, bytes) => {
      const response = await request(fileUrl(path), {
        method: "PUT",
        headers: headers({ "content-type": "application/octet-stream" }),
        body: bytes,
      });
      if (!response.ok) {
        throw new ComputerFsError(
          response.status === 503 ? "Unavailable" : "Failed",
          `computerd files PUT answered ${response.status}`,
        );
      }
    },
    mkdir: async (path, options) => {
      if (!options?.recursive) {
        await script("mkdir", path);
        return;
      }
      await failFor(
        await request(`${fileUrl(path)}&type=dir`, { method: "PUT", headers: headers() }),
        path,
      );
    },
    remove: async (path, options) => {
      await script(options?.recursive ? "rmrf" : "rm", path);
    },
    rename: async (from, to) => {
      await script("mv", from, to);
    },
  };
};
