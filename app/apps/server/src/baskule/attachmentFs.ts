// baskule: the synchronous file calls attachmentStore.ts makes on an attachments directory.
// They are plain functions (no Effect context), so a space cell registers its DO-backed
// attachments directory here by path; every space has its own directory, so the path picks the
// space. Unregistered paths use `node:fs`, unchanged.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

export interface AttachmentFsSync {
  existsSync(path: string): boolean;
  readdirSync(path: string): Array<string>;
  statSync(path: string): { readonly mtimeMs: number };
  unlinkSync(path: string): void;
}

const roots = new Map<string, AttachmentFsSync>();

const routeFor = (path: string): AttachmentFsSync => {
  for (const [root, impl] of roots) {
    if (path === root || path.startsWith(`${root}/`)) return impl;
  }
  return NodeFS;
};

/** Returns the unregister function. */
export const registerAttachmentRoot = (root: string, impl: AttachmentFsSync): (() => void) => {
  roots.set(root, impl);
  return () => {
    if (roots.get(root) === impl) roots.delete(root);
  };
};

export const attachmentFs: AttachmentFsSync = {
  existsSync: (path) => routeFor(path).existsSync(path),
  readdirSync: (path) => routeFor(path).readdirSync(path),
  statSync: (path) => routeFor(path).statSync(path),
  unlinkSync: (path) => routeFor(path).unlinkSync(path),
};
