// baskule: the HostFileSystem (`node:fs/promises` subset) of a space cell, for T3's workspace
// and media modules: file tree, file reads and writes, downloads and attachment bytes.
// Members reach these through RPCs and signed asset URLs, so only the computer (`/sandbox`) and
// attachments and saved browser captures are visible; T3's settings and secrets are not.
// @effect-diagnostics nodeBuiltinImport:off
import { Readable } from "node:stream";

import type { HostFileSystemApi } from "../HostFileSystem.ts";
import { FsError, normalizePath, type NodeInfo, type SpaceFileSystem } from "./fileSystem.ts";

import type { ComputerFs } from "./computerFs.ts";
import { makeComputerSearch } from "./computerSearch.ts";

const READ_CHUNK = 64 * 1024;

const denied = (path: string) =>
  new FsError("PermissionDenied", path, `EACCES: permission denied, '${path}'`, "EACCES");

/** A stable, non-zero inode per path (MediaFile checks identity by device and inode). */
const inodeOf = (path: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash + 1;
};

const makeStats = (path: string, info: NodeInfo, bigint: boolean) => {
  const n = (v: number) => (bigint ? BigInt(Math.trunc(v)) : v);
  const isFile = info.type === "File";
  return {
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    size: n(info.size),
    mtimeMs: n(info.mtimeMs),
    ctimeMs: n(info.mtimeMs),
    atimeMs: n(info.mtimeMs),
    birthtimeMs: n(info.mtimeMs),
    mtime: new Date(info.mtimeMs),
    ctime: new Date(info.mtimeMs),
    atime: new Date(info.mtimeMs),
    birthtime: new Date(info.mtimeMs),
    dev: n(1),
    ino: n(inodeOf(path)),
    mode: n(isFile ? 0o100644 : 0o40755),
    nlink: n(1),
    uid: n(1000),
    gid: n(1000),
    rdev: n(0),
    blksize: n(4096),
    blocks: n(Math.ceil(info.size / 512)),
  };
};

const dirent = (parentPath: string, name: string, type: string) => ({
  name,
  parentPath,
  path: parentPath,
  isFile: () => type === "File",
  isDirectory: () => type === "Directory",
  isSymbolicLink: () => type === "SymbolicLink",
  isFIFO: () => false,
  isSocket: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
});

const toBytes = (data: unknown): Uint8Array => {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("writeFile: unsupported data");
};

export const makeHostFileSystem = (
  space: SpaceFileSystem,
  baseDir: string,
  computer?: ComputerFs,
): HostFileSystemApi => {
  const fs = space.primitives;
  const visibleRoots = [
    "/sandbox",
    `${baseDir}/userdata/attachments`,
    `${baseDir}/userdata/browser-artifacts`,
  ];
  const visible = (path: string) =>
    visibleRoots.some((root) => path === root || path.startsWith(`${root}/`));
  // Outside the visible roots nothing exists for reads (T3 walks up to `/` looking for git
  // folders); writes there are refused.
  const guard = (raw: unknown, forWrite = false): string => {
    const path = normalizePath(String(raw));
    if (!visible(path)) {
      throw forWrite
        ? denied(path)
        : new FsError("NotFound", path, `ENOENT: no such file or directory, '${path}'`);
    }
    return path;
  };
  const statOf = async (raw: unknown, options?: { readonly bigint?: boolean }) => {
    const path = guard(raw);
    return makeStats(path, await fs.stat(path), options?.bigint === true);
  };

  const open = async (raw: unknown, flags?: unknown) => {
    // Only read handles: T3 writes workspace files with writeFile.
    const write =
      typeof flags === "string" ? flags !== "r" : typeof flags === "number" && (flags & 3) !== 0;
    const path = guard(raw, write);
    if (write) throw denied(path);
    const info = await fs.stat(path);
    if (info.type !== "File") throw new FsError("BadResource", path, `EISDIR: ${path}`, "EISDIR");
    let closed = false;
    const readRange = (position: number, length: number) => fs.readRange(path, position, length);
    return {
      fd: 3,
      stat: async (options?: { readonly bigint?: boolean }) =>
        makeStats(path, info, options?.bigint === true),
      read: async (
        buffer: Uint8Array,
        offset = 0,
        length = buffer.length - offset,
        position: number | bigint | null = 0,
      ) => {
        if (closed) throw new FsError("BadResource", path, "EBADF: file closed", "EBADF");
        const bytes = await readRange(Number(position ?? 0), length);
        buffer.set(bytes, offset);
        return { bytesRead: bytes.length, buffer };
      },
      readFile: async () => fs.readAll(path),
      close: async () => {
        closed = true;
      },
      createReadStream: (options?: { readonly start?: number; readonly end?: number }) => {
        const start = options?.start ?? 0;
        const end = options?.end ?? info.size - 1;
        async function* chunks() {
          for (let at = start; at <= end; at += READ_CHUNK) {
            const bytes = await readRange(at, Math.min(READ_CHUNK, end - at + 1));
            if (bytes.length === 0) return;
            yield bytes;
          }
        }
        return Readable.from(chunks(), { objectMode: false });
      },
    };
  };

  const api = {
    ...(computer ? makeComputerSearch(computer) : {}),
    realpath: async (raw: unknown) => {
      const path = guard(raw);
      await fs.stat(path);
      return path;
    },
    realpathLikeFileSystem: async (raw: string) => {
      const path = guard(raw);
      await fs.stat(path);
      return path;
    },
    lstat: statOf,
    readdir: async (raw: unknown, options?: { readonly withFileTypes?: boolean }) => {
      const path = guard(raw);
      const entries = await fs.list(path);
      return options?.withFileTypes
        ? entries.map((e) => dirent(path, e.name, e.type))
        : entries.map((e) => e.name);
    },
    open,
    writeFile: async (raw: unknown, data: unknown) => {
      const path = guard(raw, true);
      await fs.writeAll(path, toBytes(data));
    },
  };
  // One cast at the boundary: this implements the subset of Node's overloads T3 calls.
  return api as unknown as HostFileSystemApi;
};
