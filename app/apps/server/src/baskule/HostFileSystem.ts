// baskule: the `node:fs/promises` subset that T3's workspace and media modules use directly
// (WorkspaceEntries, WorkspaceFileSystem, MediaFile), as a service. The default is Node's own
// module, so nothing changes outside Baskule; a space cell provides its computer-backed
// implementation (baskule/workerd/hostFileSystem.ts).
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";

import * as Context from "effect/Context";

export type HostFileSystemApi = Pick<
  typeof NodeFSP,
  "realpath" | "lstat" | "readdir" | "open" | "writeFile"
> & {
  readonly searchEntries?: (
    input: ProjectSearchEntriesInput,
  ) => Promise<ProjectSearchEntriesResult>;
  readonly searchContents?: (
    input: ProjectSearchContentsInput,
  ) => Promise<ProjectSearchContentsResult>;
  /** Node's JS realpath (callback API), which canonicalises like Effect's FileSystem.realPath. */
  readonly realpathLikeFileSystem: (path: string) => Promise<string>;
};

export type HostFileHandle = NodeFSP.FileHandle;
export type HostBigIntStats = NodeFS.BigIntStats;

export class HostFileSystem extends Context.Reference<HostFileSystemApi>(
  "baskule/HostFileSystem",
  {
    defaultValue: () => ({
      realpath: NodeFSP.realpath,
      lstat: NodeFSP.lstat,
      readdir: NodeFSP.readdir,
      open: NodeFSP.open,
      writeFile: NodeFSP.writeFile,
      realpathLikeFileSystem: (path) =>
        new Promise<string>((resolve, reject) => {
          NodeFS.realpath(path, (error, resolved) => (error ? reject(error) : resolve(resolved)));
        }),
    }),
  },
) {}

// Linux values where a runtime's `node:fs` has no constants (workerd).
export const hostFsConstants = {
  O_RDONLY: NodeFS.constants?.O_RDONLY ?? 0,
  O_WRONLY: NodeFS.constants?.O_WRONLY ?? 1,
  O_CREAT: NodeFS.constants?.O_CREAT ?? 0o100,
  O_TRUNC: NodeFS.constants?.O_TRUNC ?? 0o1000,
  O_NONBLOCK: NodeFS.constants?.O_NONBLOCK ?? 0o4000,
  O_NOFOLLOW: NodeFS.constants?.O_NOFOLLOW ?? 0o400000,
};
