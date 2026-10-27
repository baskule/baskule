import type { AssetResource, ThreadId } from "@t3tools/contracts";

import {
  isAbsolutePath,
  isAudioPreviewFile,
  isVideoPreviewFile,
  resolveWorkspaceFilePath,
} from "./filePath";

export function workspaceFileResource(input: {
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  readonly draftCwd?: string | null;
}): Extract<
  AssetResource,
  { readonly _tag: "workspace-file" | "media-file" | "draft-workspace-file" }
> | null {
  if (input.cwd === null || input.relativePath === null) return null;
  const path = resolveWorkspaceFilePath(input.cwd, input.relativePath);
  if (input.threadId !== null) {
    return {
      _tag:
        isVideoPreviewFile(path) || isAudioPreviewFile(path) || isAbsolutePath(input.relativePath)
          ? "media-file"
          : "workspace-file",
      threadId: input.threadId,
      path,
    };
  }
  return input.draftCwd === null || input.draftCwd === undefined
    ? null
    : { _tag: "draft-workspace-file", cwd: input.draftCwd, path: input.relativePath };
}
