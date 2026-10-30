// @effect-diagnostics globalDate:off globalDateInEffect:off globalRandom:off -- native workerd adapter implementing the platform boundary.
// baskule: the Effect `FileSystem` of a space cell (architecture v3, E8).
//
// Mounts, by path prefix:
// - `${baseDir}/**` (T3's home: settings, secrets, environment id, attachments, logs) lives in
//   DO SQLite, so it survives a cell restart or a failover to another celld node;
// - `${chatsRoot}` and the chat folders directly under it are records in DO SQLite. T3 stats a
//   chat's cwd on every turn, so answering from DO SQLite keeps chatting from waking the
//   computer. A folder is created on the computer lazily: the first write under it (or the
//   agent's spawner, WP-D) materializes it;
// - everything else under `${sandboxRoot}` is the space computer, through computerd;
// - `/tmp/**` is per-cell memory;
// - any other path fails with PermissionDenied.
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import { ComputerFsError, type ComputerFs } from "./computerFs.ts";
import type { DoSqlStorage } from "./doSqlClient.ts";

export interface SpaceFileSystemConfig {
  readonly storage: Pick<DoSqlStorage, "sql">;
  readonly baseDir: string;
  readonly sandboxRoot: string;
  readonly chatsRoot: string;
  readonly computer: ComputerFs | undefined;
}

type NodeType = "File" | "Directory";

export interface NodeInfo {
  readonly type: NodeType;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface Dirent {
  readonly name: string;
  readonly type: NodeType | "SymbolicLink" | "Unknown";
}

const CODES: Partial<Record<PlatformError.SystemErrorTag, string>> = {
  NotFound: "ENOENT",
  AlreadyExists: "EEXIST",
  PermissionDenied: "EACCES",
  Unknown: "EIO",
};

/** Carries both Effect's error tag and Node's errno code (for the HostFileSystem view). */
export class FsError extends Error {
  readonly tag: PlatformError.SystemErrorTag;
  readonly path: string;
  readonly code: string;
  constructor(tag: PlatformError.SystemErrorTag, path: string, message: string, code?: string) {
    super(message);
    this.tag = tag;
    this.path = path;
    this.code = code ?? CODES[tag] ?? "EIO";
  }
}

const notFound = (path: string) =>
  new FsError("NotFound", path, `ENOENT: no such file or directory: ${path}`);
const exists = (path: string) =>
  new FsError("AlreadyExists", path, `EEXIST: already exists: ${path}`);
const notDir = (path: string) =>
  new FsError("BadResource", path, `ENOTDIR: not a directory: ${path}`, "ENOTDIR");
const isDir = (path: string) =>
  new FsError("BadResource", path, `EISDIR: is a directory: ${path}`, "EISDIR");

export const normalizePath = (input: string): string => {
  const parts: Array<string> = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};
const parentOf = (path: string) => (path === "/" ? "/" : normalizePath(`${path}/..`));
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isUnder = (path: string, root: string) =>
  root === "/" || path === root || path.startsWith(`${root}/`);

interface Backend {
  stat(path: string): Promise<NodeInfo>;
  list(path: string): Promise<ReadonlyArray<Dirent>>;
  readAt(path: string, position: number, length: number): Promise<Uint8Array>;
  readAll(path: string): Promise<Uint8Array>;
  /** Replaces the file content (creating the file; its parent must exist). */
  writeAll(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, recursive: boolean): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** The space computer's phase (absent|starting|ready|stopping|stopped|error), never starting it. */
  phase?(): Promise<string>;
}

/** A synchronous node table: DO SQLite for userdata, a Map for /tmp. */
interface NodeTable {
  get(path: string): NodeInfo | undefined;
  put(path: string, info: NodeInfo): void;
  delete(path: string): void;
  children(path: string): ReadonlyArray<{ path: string; type: NodeType }>;
  read(path: string): Uint8Array;
  write(path: string, data: Uint8Array): void;
}

const CHUNK_BYTES = 1024 * 1024; // DO SQLite rejects blobs above ~2 MB.

const makeSqlTable = (storage: Pick<DoSqlStorage, "sql">): NodeTable => {
  const exec = (q: string, ...p: ReadonlyArray<unknown>) => storage.sql.exec(q, ...p);
  exec(
    "CREATE TABLE IF NOT EXISTS baskule_fs_nodes (path TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL)",
  );
  exec(
    "CREATE TABLE IF NOT EXISTS baskule_fs_chunks (path TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, idx))",
  );
  const rows = (q: string, ...p: ReadonlyArray<unknown>) => {
    const cursor = exec(q, ...p);
    const out: Array<Array<unknown>> = [];
    for (const row of cursor.raw()) out.push([...row]);
    return out;
  };
  return {
    get: (path) => {
      const [row] = rows("SELECT type, size, mtime_ms FROM baskule_fs_nodes WHERE path = ?", path);
      return row
        ? { type: row[0] as NodeType, size: Number(row[1]), mtimeMs: Number(row[2]) }
        : undefined;
    },
    put: (path, info) => {
      exec(
        "INSERT INTO baskule_fs_nodes (path, type, size, mtime_ms) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET type = excluded.type, size = excluded.size, mtime_ms = excluded.mtime_ms",
        path,
        info.type,
        info.size,
        info.mtimeMs,
      );
    },
    delete: (path) => {
      exec("DELETE FROM baskule_fs_nodes WHERE path = ?", path);
      exec("DELETE FROM baskule_fs_chunks WHERE path = ?", path);
    },
    children: (path) => {
      const prefix = path === "/" ? "/" : `${path}/`;
      // Every path between `prefix` and `prefix` with its last '/' bumped to '0'.
      const upper = `${prefix.slice(0, -1)}0`;
      return rows(
        "SELECT path, type FROM baskule_fs_nodes WHERE path > ? AND path < ?",
        prefix,
        upper,
      )
        .map(([p, t]) => ({ path: String(p), type: t as NodeType }))
        .filter((c) => !c.path.slice(prefix.length).includes("/"));
    },
    read: (path) => {
      const parts = rows(
        "SELECT data FROM baskule_fs_chunks WHERE path = ? ORDER BY idx",
        path,
      ).map(([d]) => (d instanceof ArrayBuffer ? new Uint8Array(d) : (d as Uint8Array)));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    },
    write: (path, data) => {
      exec("DELETE FROM baskule_fs_chunks WHERE path = ?", path);
      for (let i = 0, idx = 0; i < data.length; i += CHUNK_BYTES, idx++) {
        exec(
          "INSERT INTO baskule_fs_chunks (path, idx, data) VALUES (?, ?, ?)",
          path,
          idx,
          data.subarray(i, i + CHUNK_BYTES),
        );
      }
    },
  };
};

const makeMemoryTable = (): NodeTable => {
  const nodes = new Map<string, NodeInfo>();
  const data = new Map<string, Uint8Array>();
  return {
    get: (p) => nodes.get(p),
    put: (p, i) => void nodes.set(p, i),
    delete: (p) => {
      nodes.delete(p);
      data.delete(p);
    },
    children: (p) => {
      const prefix = p === "/" ? "/" : `${p}/`;
      return [...nodes]
        .filter(([k]) => k.startsWith(prefix) && k !== p && !k.slice(prefix.length).includes("/"))
        .map(([k, v]) => ({ path: k, type: v.type }));
    },
    read: (p) => data.get(p) ?? new Uint8Array(),
    write: (p, d) => void data.set(p, d),
  };
};

/** Directory-tree semantics over a node table whose root is `root` (always a directory). */
const makeTableBackend = (table: NodeTable, root: string): Backend => {
  const lookup = (path: string): NodeInfo | undefined =>
    path === root ? { type: "Directory", size: 0, mtimeMs: 0 } : table.get(path);
  const requireDir = (path: string) => {
    const info = lookup(path);
    if (!info) throw notFound(path);
    if (info.type !== "Directory") throw notDir(path);
  };
  const requireFile = (path: string) => {
    const info = lookup(path);
    if (!info) throw notFound(path);
    if (info.type === "Directory") throw isDir(path);
    return info;
  };
  const removeTree = (path: string) => {
    for (const child of table.children(path)) removeTree(child.path);
    table.delete(path);
  };
  return {
    stat: async (path) => {
      const info = lookup(path);
      if (!info) throw notFound(path);
      return info;
    },
    list: async (path) => {
      requireDir(path);
      return table.children(path).map((c) => ({ name: baseName(c.path), type: c.type }));
    },
    readAll: async (path) => {
      requireFile(path);
      return table.read(path);
    },
    readAt: async (path, position, length) => {
      requireFile(path);
      return table.read(path).slice(position, position + length);
    },
    writeAll: async (path, data) => {
      requireDir(parentOf(path));
      if (lookup(path)?.type === "Directory") throw isDir(path);
      table.write(path, data);
      table.put(path, { type: "File", size: data.length, mtimeMs: Date.now() });
    },
    mkdir: async (path, recursive) => {
      const existing = lookup(path);
      if (existing) {
        if (recursive && existing.type === "Directory") return;
        throw exists(path);
      }
      const parent = parentOf(path);
      if (!lookup(parent)) {
        if (!recursive || !isUnder(parent, root)) throw notFound(parent);
        await makeTableBackend(table, root).mkdir(parent, true);
      }
      requireDir(parent);
      table.put(path, { type: "Directory", size: 0, mtimeMs: Date.now() });
    },
    remove: async (path, recursive) => {
      const info = lookup(path);
      if (!info) throw notFound(path);
      if (path === root) throw new FsError("PermissionDenied", path, `cannot remove ${root}`);
      if (info.type === "Directory" && table.children(path).length > 0 && !recursive) {
        throw new FsError("BadResource", path, `directory not empty: ${path}`);
      }
      removeTree(path);
    },
    rename: async (from, to) => {
      const info = lookup(from);
      if (!info) throw notFound(from);
      requireDir(parentOf(to));
      const move = (src: string, dst: string) => {
        const node = table.get(src)!;
        if (node.type === "File") table.write(dst, table.read(src));
        for (const child of table.children(src)) move(child.path, `${dst}/${baseName(child.path)}`);
        table.delete(src);
        table.put(dst, node);
      };
      if (lookup(to)) removeTree(to);
      move(from, to);
    },
  };
};

const fromComputerError = (error: unknown, path: string): never => {
  if (error instanceof ComputerFsError) {
    switch (error.kind) {
      case "NotFound":
        throw notFound(path);
      case "AlreadyExists":
        throw exists(path);
      case "NotADirectory":
        throw notDir(path);
      case "Unavailable":
        throw new FsError("Unknown", path, `the space computer is unavailable: ${error.message}`);
      default:
        throw new FsError("Unknown", path, error.message);
    }
  }
  throw error;
};

const computerBackend = (computer: ComputerFs | undefined): Backend => {
  const call = async <A>(path: string, f: (c: ComputerFs) => Promise<A>): Promise<A> => {
    if (!computer) throw new FsError("Unknown", path, "no computer is configured for this space");
    try {
      return await f(computer);
    } catch (error) {
      return fromComputerError(error, path);
    }
  };
  return {
    stat: (path) =>
      call(path, async (c) => {
        const s = await c.stat(path);
        return {
          type: s.type === "Directory" ? "Directory" : "File",
          size: s.size,
          mtimeMs: s.mtimeMs,
        };
      }),
    list: (path) => call(path, (c) => c.list(path)),
    phase: async () => (computer ? computer.phase() : "absent"),
    readAll: (path) => call(path, (c) => c.readAll(path)),
    readAt: (path, position, length) =>
      call(path, async (c) => {
        if (length <= 0) return new Uint8Array();
        const response = await c.read(path, `bytes=${position}-${position + length - 1}`);
        // A server that ignores Range sends the whole file.
        const body = new Uint8Array(await response.arrayBuffer());
        return response.status === 206 ? body : body.slice(position, position + length);
      }),
    writeAll: (path, data) => call(path, (c) => c.write(path, data)),
    mkdir: (path, recursive) => call(path, (c) => c.mkdir(path, { recursive })),
    remove: (path, recursive) => call(path, (c) => c.remove(path, { recursive })),
    rename: (from, to) => call(from, (c) => c.rename(from, to)),
  };
};

/**
 * Chat folders are DO records first; the computer copy is created on the first write under
 * the folder. Reads under a folder the computer never saw are answered empty without waking it.
 */
const makeChatFolders = (
  storage: Pick<DoSqlStorage, "sql">,
  chatsRoot: string,
  computer: Backend,
) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS baskule_chat_folders (path TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, materialized INTEGER NOT NULL DEFAULT 0)",
  );
  const row = (path: string) => {
    for (const r of storage.sql
      .exec("SELECT created_ms, materialized FROM baskule_chat_folders WHERE path = ?", path)
      .raw()) {
      return { createdMs: Number(r[0]), materialized: Number(r[1]) === 1 };
    }
    return undefined;
  };
  const folderOf = (path: string): string | undefined => {
    if (!isUnder(path, chatsRoot) || path === chatsRoot) return undefined;
    const rest = path.slice(chatsRoot.length + 1);
    return `${chatsRoot}/${rest.split("/")[0]}`;
  };
  const materialize = async (folder: string) => {
    const r = row(folder);
    if (!r) throw notFound(folder);
    if (r.materialized) return;
    await computer.mkdir(folder, true);
    storage.sql.exec("UPDATE baskule_chat_folders SET materialized = 1 WHERE path = ?", folder);
  };
  // baskule(wp-h): the agent creates a chat's folder on the computer itself (its spawner runs `mkdir -p` in the session cwd, in the AgentCell), so a folder can exist there while its
  // record still says "not materialized". Before answering "empty"/"not found" for one, look on the computer (status call first, which never starts it): only if it is running, or, for
  // explicit user actions (`wake`: file panel listing, reads/downloads), if a computer exists at all. A space that never ran a tool keeps answering from DO SQLite without any computerd
  // file call.
  const known = async (folder: string, wake: boolean): Promise<boolean> => {
    const r = row(folder);
    if (!r) return false;
    if (r.materialized) return true;
    const phase = await (computer.phase?.() ?? Promise.resolve("absent"));
    const running = phase === "ready" || phase === "starting";
    if (!running && !(wake && phase !== "absent")) return false;
    try {
      const info = await computer.stat(folder);
      if (info.type !== "Directory") return false;
    } catch (error) {
      if (error instanceof FsError && error.tag === "NotFound") return false;
      throw error;
    }
    storage.sql.exec("UPDATE baskule_chat_folders SET materialized = 1 WHERE path = ?", folder);
    return true;
  };
  return {
    folderOf,
    row,
    known,
    materialize,
    list: (): ReadonlyArray<Dirent> => {
      const out: Array<Dirent> = [];
      for (const r of storage.sql
        .exec("SELECT path FROM baskule_chat_folders ORDER BY path")
        .raw()) {
        out.push({ name: baseName(String(r[0])), type: "Directory" });
      }
      return out;
    },
    create: (folder: string, recursive: boolean) => {
      if (row(folder)) {
        if (recursive) return;
        throw exists(folder);
      }
      storage.sql.exec(
        "INSERT INTO baskule_chat_folders (path, created_ms, materialized) VALUES (?, ?, 0)",
        folder,
        Date.now(),
      );
    },
    forget: (folder: string) => {
      storage.sql.exec("DELETE FROM baskule_chat_folders WHERE path = ?", folder);
    },
  };
};

export interface SpaceFileSystem {
  readonly fileSystem: FileSystem.FileSystem;
  /** Creates the chat folder on the computer if needed (used before tools run in it). */
  readonly materializeChatFolder: (path: string) => Promise<void>;
  /** The same mounts as plain promises, failing with `FsError` (for hostFileSystem.ts). */
  readonly primitives: {
    readonly stat: (path: string) => Promise<NodeInfo>;
    readonly list: (path: string) => Promise<ReadonlyArray<Dirent>>;
    readonly readRange: (path: string, position: number, length: number) => Promise<Uint8Array>;
    readonly readAll: (path: string) => Promise<Uint8Array>;
    readonly writeAll: (path: string, data: Uint8Array) => Promise<void>;
  };
  /** Synchronous access to T3's home in DO SQLite (attachments; see baskule/attachmentFs.ts). */
  readonly homeSync: {
    readonly stat: (path: string) => NodeInfo | undefined;
    readonly list: (path: string) => ReadonlyArray<string>;
    readonly remove: (path: string) => void;
  };
}

export const makeSpaceFileSystem = (config: SpaceFileSystemConfig): SpaceFileSystem => {
  const baseDir = normalizePath(config.baseDir);
  const sandboxRoot = normalizePath(config.sandboxRoot);
  const chatsRoot = normalizePath(config.chatsRoot);
  const homeTable = makeSqlTable(config.storage);
  const userdata = makeTableBackend(homeTable, baseDir);
  const tmp = makeTableBackend(makeMemoryTable(), "/tmp");
  const computer = computerBackend(config.computer);
  const chats = makeChatFolders(config.storage, chatsRoot, computer);
  const virtualDir: NodeInfo = { type: "Directory", size: 0, mtimeMs: 0 };

  type Route =
    | { readonly kind: "backend"; readonly backend: Backend }
    | { readonly kind: "chats-root" }
    | { readonly kind: "chat-folder"; readonly folder: string }
    | { readonly kind: "in-chat"; readonly folder: string }
    | { readonly kind: "ancestor" };

  // T3's per-project config (`.t3code/`, `t3.json`) is not a Baskule concept, and T3 probes
  // for it up the tree from the chats root on every turn: answering here keeps chats from
  // waking the computer.
  const isT3ProjectConfig = (path: string) =>
    isUnder(path, sandboxRoot) &&
    /\/(\.t3code(\/|$)|t3\.json$)/.test(path) &&
    !chats.folderOf(path);
  const absent: Backend = {
    stat: async (p) => Promise.reject(notFound(p)),
    list: async (p) => Promise.reject(notFound(p)),
    readAt: async (p) => Promise.reject(notFound(p)),
    readAll: async (p) => Promise.reject(notFound(p)),
    writeAll: async (p) => Promise.reject(new FsError("PermissionDenied", p, `EACCES: ${p}`)),
    mkdir: async (p) => Promise.reject(new FsError("PermissionDenied", p, `EACCES: ${p}`)),
    remove: async (p) => Promise.reject(notFound(p)),
    rename: async (p) => Promise.reject(notFound(p)),
  };

  const route = (path: string): Route => {
    if (isUnder(path, baseDir)) return { kind: "backend", backend: userdata };
    if (isT3ProjectConfig(path)) return { kind: "backend", backend: absent };
    if (isUnder(path, "/tmp")) return { kind: "backend", backend: tmp };
    if (path === chatsRoot) return { kind: "chats-root" };
    const folder = chats.folderOf(path);
    if (folder)
      return folder === path ? { kind: "chat-folder", folder } : { kind: "in-chat", folder };
    if (isUnder(path, sandboxRoot)) return { kind: "backend", backend: computer };
    // Ancestors of the mounts (`/`, `/sandbox` parents) exist as directories so path walks work.
    if ([baseDir, sandboxRoot, chatsRoot, "/tmp"].some((m) => isUnder(m, path)))
      return { kind: "ancestor" };
    throw new FsError("PermissionDenied", path, `outside the space file system: ${path}`);
  };

  const stat = async (raw: string): Promise<NodeInfo> => {
    const path = normalizePath(raw);
    const r = route(path);
    switch (r.kind) {
      case "backend":
        return r.backend.stat(path);
      case "chats-root":
      case "ancestor":
        return virtualDir;
      case "chat-folder": {
        const row = chats.row(r.folder);
        if (!row) throw notFound(path);
        return { type: "Directory", size: 0, mtimeMs: row.createdMs };
      }
      case "in-chat": {
        // T3 stats paths inside a chat on its own (e.g. `.git` up the tree): never wake the computer for that.
        if (!(await chats.known(r.folder, false))) throw notFound(path);
        return computer.stat(path);
      }
    }
  };

  const list = async (raw: string): Promise<ReadonlyArray<Dirent>> => {
    const path = normalizePath(raw);
    const r = route(path);
    switch (r.kind) {
      case "backend":
        return r.backend.list(path);
      case "chats-root":
        return chats.list();
      case "ancestor":
        return [baseDir, sandboxRoot, "/tmp"]
          .filter((m) => m !== path && isUnder(m, path))
          .map((m) => ({
            name: m.slice(path === "/" ? 1 : path.length + 1).split("/")[0]!,
            type: "Directory" as const,
          }))
          .filter((d, i, all) => all.findIndex((x) => x.name === d.name) === i);
      case "chat-folder": {
        const row = chats.row(r.folder);
        if (!row) throw notFound(path);
        return (await chats.known(r.folder, true)) ? computer.list(path) : [];
      }
      case "in-chat": {
        if (!(await chats.known(r.folder, true))) throw notFound(path);
        return computer.list(path);
      }
    }
  };

  const backendForData = async (path: string, forWrite: boolean): Promise<Backend> => {
    const r = route(path);
    switch (r.kind) {
      case "backend":
        return r.backend;
      case "in-chat":
        if (forWrite) await chats.materialize(r.folder);
        else if (!(await chats.known(r.folder, true))) throw notFound(path);
        return computer;
      case "chat-folder":
        // Only chat folders live directly in the chats root (no files such as t3.json).
        if (chats.row(r.folder)) throw isDir(path);
        if (forWrite)
          throw new FsError("PermissionDenied", path, `only chat folders live in ${chatsRoot}`);
        throw notFound(path);
      default:
        throw isDir(path);
    }
  };

  const mkdir = async (raw: string, recursive: boolean) => {
    const path = normalizePath(raw);
    const r = route(path);
    switch (r.kind) {
      case "backend":
        return r.backend.mkdir(path, recursive);
      case "chats-root":
      case "ancestor":
        if (!recursive) throw exists(path);
        return;
      case "chat-folder":
        return chats.create(r.folder, recursive);
      case "in-chat":
        if (!chats.row(r.folder)) {
          if (!recursive) throw notFound(parentOf(path));
          chats.create(r.folder, true);
        }
        await chats.materialize(r.folder);
        return computer.mkdir(path, recursive);
    }
  };

  const remove = async (raw: string, recursive: boolean) => {
    const path = normalizePath(raw);
    const r = route(path);
    switch (r.kind) {
      case "backend":
        return r.backend.remove(path, recursive);
      case "chat-folder": {
        const row = chats.row(r.folder);
        if (!row) throw notFound(path);
        if (row.materialized) await computer.remove(path, true).catch(() => undefined);
        return chats.forget(r.folder);
      }
      case "in-chat":
        if (!(await chats.known(r.folder, false))) throw notFound(path);
        return computer.remove(path, recursive);
      default:
        throw new FsError("PermissionDenied", path, `cannot remove ${path}`);
    }
  };

  const rename = async (rawFrom: string, rawTo: string) => {
    const from = normalizePath(rawFrom);
    const to = normalizePath(rawTo);
    const a = await backendForData(from, false);
    const b = await backendForData(to, true);
    if (a === b) return a.rename(from, to);
    // Across mounts: copy then delete (files only).
    await b.writeAll(to, await a.readAll(from));
    await a.remove(from, false);
  };

  const lift = <A>(method: string, path: string, f: () => Promise<A>) =>
    Effect.tryPromise({
      try: f,
      catch: (error) =>
        error instanceof FsError
          ? PlatformError.systemError({
              _tag: error.tag,
              module: "FileSystem",
              method,
              pathOrDescriptor: error.path,
              description: error.message,
            })
          : PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method,
              pathOrDescriptor: path,
              description: String(error),
              cause: error,
            }),
    });

  const toInfo = (info: NodeInfo): FileSystem.File.Info => ({
    type: info.type,
    size: ByteSize.bytes(info.size),
    mtime: Option.some(new Date(info.mtimeMs)),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0n,
    ino: Option.none(),
    mode: info.type === "Directory" ? 0o755 : 0o644,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    blksize: Option.none(),
    blocks: Option.none(),
  });

  const readFile = async (raw: string) => {
    const path = normalizePath(raw);
    return (await backendForData(path, false)).readAll(path);
  };
  const writeFile = async (raw: string, data: Uint8Array, flag?: string) => {
    const path = normalizePath(raw);
    const backend = await backendForData(path, true);
    let next = data;
    if (
      flag?.includes("x") &&
      (await backend.stat(path).then(
        () => true,
        () => false,
      ))
    )
      throw exists(path);
    if (flag?.startsWith("a")) {
      const prev = await backend.readAll(path).catch(() => new Uint8Array());
      next = new Uint8Array(prev.length + data.length);
      next.set(prev);
      next.set(data, prev.length);
    }
    await backend.writeAll(path, next);
  };

  /**
   * A file handle buffers writes and flushes them on `sync` and when its scope closes; reads go
   * to the backend by range, so streaming a large computer file does not load it whole.
   */
  const open = Effect.fn("SpaceFileSystem.open")(function* (raw: string, flag: string) {
    const path = normalizePath(raw);
    const backend = yield* lift("open", path, () => backendForData(path, flag !== "r"));
    const existing = yield* lift("open", path, () => backend.stat(path)).pipe(Effect.option);
    if (Option.isSome(existing) && existing.value.type === "Directory") {
      return yield* lift("open", path, () => Promise.reject(isDir(path)));
    }
    if (Option.isNone(existing) && (flag === "r" || flag === "r+")) {
      return yield* lift("open", path, () => Promise.reject(notFound(path)));
    }
    if (Option.isSome(existing) && flag.includes("x")) {
      return yield* lift("open", path, () => Promise.reject(exists(path)));
    }
    const writable = flag !== "r";
    const truncateOnOpen = flag.startsWith("w");
    const append = flag.startsWith("a");
    // Writable handles hold the content in memory; read-only ones read by range.
    let buffer: Uint8Array | undefined = writable
      ? truncateOnOpen || Option.isNone(existing)
        ? new Uint8Array()
        : yield* lift("open", path, () => backend.readAll(path))
      : undefined;
    let dirty = writable && (truncateOnOpen || Option.isNone(existing));
    let position = append && buffer ? buffer.length : 0;
    const size = () => (buffer ? buffer.length : Option.isSome(existing) ? existing.value.size : 0);
    const flush = lift("sync", path, async () => {
      if (buffer && dirty) {
        await backend.writeAll(path, buffer);
        dirty = false;
      }
    });
    yield* Effect.addFinalizer(() => Effect.ignore(flush));
    const readAt = (pos: number, length: number) =>
      buffer
        ? Effect.succeed(buffer.slice(pos, pos + length))
        : lift("read", path, () => backend.readAt(path, pos, length));
    const writeBytes = (bytes: Uint8Array) =>
      Effect.sync(() => {
        const at = append ? buffer!.length : position;
        const end = at + bytes.length;
        if (end > buffer!.length) {
          const grown = new Uint8Array(end);
          grown.set(buffer!);
          buffer = grown;
        }
        buffer!.set(bytes, at);
        position = end;
        dirty = true;
        return bytes.length;
      });
    const file: FileSystem.File = {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: Effect.sync(() => toInfo({ type: "File", size: size(), mtimeMs: Date.now() })),
      seek: (offset, from) =>
        Effect.sync(() => {
          position = from === "start" ? Number(offset) : position + Number(offset);
          return BigInt(position);
        }),
      sync: flush,
      // Suspended: callers such as `FileSystem.stream` build the effect once and rerun it.
      read: (target, options) =>
        Effect.suspend(() =>
          Effect.map(
            readAt(
              options?.position === undefined ? position : Number(options.position),
              target.length,
            ),
            (bytes) => {
              target.set(bytes);
              if (options?.position === undefined) position += bytes.length;
              return bytes.length;
            },
          ),
        ) as Effect.Effect<number, PlatformError.PlatformError>,
      readAlloc: (length, options) =>
        Effect.suspend(() =>
          Effect.map(
            readAt(
              options?.position === undefined ? position : Number(options.position),
              Number(length),
            ),
            (bytes) => {
              if (options?.position === undefined) position += bytes.length;
              return bytes.length === 0 ? Option.none() : Option.some(bytes);
            },
          ),
        ) as never,
      truncate: (length) =>
        writable
          ? Effect.sync(() => {
              buffer = buffer!.slice(0, Number(length ?? 0));
              dirty = true;
            })
          : lift("truncate", path, () =>
              Promise.reject(new FsError("PermissionDenied", path, "read-only handle")),
            ),
      write: (bytes) =>
        writable
          ? (writeBytes(bytes) as never)
          : lift("write", path, () =>
              Promise.reject(new FsError("PermissionDenied", path, "read-only handle")),
            ),
      writeAll: (bytes) =>
        writable
          ? Effect.asVoid(writeBytes(bytes))
          : lift("write", path, () =>
              Promise.reject(new FsError("PermissionDenied", path, "read-only handle")),
            ),
    } as FileSystem.File;
    return file;
  });

  let tempCounter = 0;
  const tempName = (prefix = "tmp") =>
    `${prefix}${Date.now().toString(36)}${(tempCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const fileSystem = FileSystem.make({
    access: (path) => Effect.asVoid(lift("access", path, () => stat(path))),
    copy: (from, to) => lift("copy", from, async () => writeFile(to, await readFile(from))),
    copyFile: (from, to) => lift("copyFile", from, async () => writeFile(to, await readFile(from))),
    chmod: () => Effect.void,
    chown: () => Effect.void,
    glob: (pattern) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "glob",
          pathOrDescriptor: pattern,
          description: "glob is not supported in a space cell",
        }),
      ),
    link: (from, to) => lift("link", from, async () => writeFile(to, await readFile(from))),
    makeDirectory: (path, options) =>
      lift("makeDirectory", path, () => mkdir(path, options?.recursive === true)),
    makeTempDirectory: (options) => {
      const dir = normalizePath(`${options?.directory ?? "/tmp"}/${tempName(options?.prefix)}`);
      return Effect.as(
        lift("makeTempDirectory", dir, () => mkdir(dir, true)),
        dir,
      );
    },
    makeTempDirectoryScoped: (options) => {
      const dir = normalizePath(`${options?.directory ?? "/tmp"}/${tempName(options?.prefix)}`);
      return Effect.acquireRelease(
        Effect.as(
          lift("makeTempDirectoryScoped", dir, () => mkdir(dir, true)),
          dir,
        ),
        () => Effect.ignore(lift("remove", dir, () => remove(dir, true))),
      );
    },
    makeTempFile: (options) => {
      const file = normalizePath(
        `${options?.directory ?? "/tmp"}/${tempName(options?.prefix)}${options?.suffix ?? ""}`,
      );
      return Effect.as(
        lift("makeTempFile", file, () => writeFile(file, new Uint8Array())),
        file,
      );
    },
    makeTempFileScoped: (options) => {
      const file = normalizePath(
        `${options?.directory ?? "/tmp"}/${tempName(options?.prefix)}${options?.suffix ?? ""}`,
      );
      return Effect.acquireRelease(
        Effect.as(
          lift("makeTempFileScoped", file, () => writeFile(file, new Uint8Array())),
          file,
        ),
        () => Effect.ignore(lift("remove", file, () => remove(file, false))),
      );
    },
    open: (path, options) => open(path, options?.flag ?? "r"),
    readDirectory: (path, options) =>
      lift("readDirectory", path, async () => {
        if (!options?.recursive) return (await list(path)).map((d) => d.name);
        const out: Array<string> = [];
        const walk = async (dir: string, rel: string) => {
          for (const d of await list(dir)) {
            const r = rel ? `${rel}/${d.name}` : d.name;
            out.push(r);
            if (d.type === "Directory") await walk(`${normalizePath(dir)}/${d.name}`, r);
          }
        };
        await walk(path, "");
        return out;
      }),
    readFile: (path) => lift("readFile", path, () => readFile(path)),
    // No path in a space cell is a symbolic link; callers treat EINVAL as "not a link".
    readLink: (path) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "InvalidData",
          module: "FileSystem",
          method: "readLink",
          pathOrDescriptor: path,
          description: "not a symbolic link",
          cause: Object.assign(new Error("EINVAL: not a symbolic link"), { code: "EINVAL" }),
        }),
      ),
    realPath: (path) =>
      Effect.as(
        lift("realPath", path, () => stat(path)),
        normalizePath(path),
      ),
    remove: (path, options) =>
      lift("remove", path, () => remove(path, options?.recursive === true)).pipe(
        options?.force
          ? Effect.catchIf(
              (e) => e.reason._tag === "NotFound",
              () => Effect.void,
            )
          : (eff) => eff,
      ),
    rename: (from, to) => lift("rename", from, () => rename(from, to)),
    stat: (path) =>
      Effect.map(
        lift("stat", path, () => stat(path)),
        toInfo,
      ),
    symlink: (_target, path) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "symlink",
          pathOrDescriptor: path,
          description: "symbolic links are not supported in a space cell",
        }),
      ),
    truncate: (path, length) =>
      lift("truncate", path, async () =>
        writeFile(path, (await readFile(path)).slice(0, Number(length ?? 0))),
      ),
    utimes: () => Effect.void,
    watch: () => Stream.empty,
    writeFile: (path, data, options) =>
      lift("writeFile", path, () => writeFile(path, data, options?.flag)),
  });

  return {
    fileSystem,
    materializeChatFolder: async (raw) => {
      const folder = chats.folderOf(normalizePath(raw));
      if (folder) await chats.materialize(folder);
    },
    primitives: {
      stat,
      list,
      readRange: async (raw, position, length) => {
        const path = normalizePath(raw);
        return (await backendForData(path, false)).readAt(path, position, length);
      },
      readAll: readFile,
      writeAll: (raw, data) => writeFile(raw, data),
    },
    homeSync: {
      stat: (raw) => {
        const path = normalizePath(raw);
        return isUnder(path, baseDir) ? homeTable.get(path) : undefined;
      },
      list: (raw) => {
        const path = normalizePath(raw);
        if (!isUnder(path, baseDir)) throw new FsError("PermissionDenied", path, `EACCES: ${path}`);
        if (path !== baseDir && homeTable.get(path)?.type !== "Directory") throw notFound(path);
        return homeTable.children(path).map((c) => baseName(c.path));
      },
      remove: (raw) => {
        const path = normalizePath(raw);
        if (!isUnder(path, baseDir) || !homeTable.get(path)) throw notFound(path);
        homeTable.delete(path);
      },
    },
  };
};

export const layer = (config: SpaceFileSystemConfig) =>
  Layer.succeed(FileSystem.FileSystem, makeSpaceFileSystem(config).fileSystem);
