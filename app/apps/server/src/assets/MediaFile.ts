// FileSystem does not expose no-follow or non-blocking open flags, and the response must
// keep the validated descriptor: this module works on `node:fs/promises` handles.
// baskule: through the HostFileSystem service, so a space cell serves the computer's files.
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  HostFileSystem,
  hostFsConstants,
  type HostBigIntStats,
  type HostFileHandle,
} from "../baskule/HostFileSystem.ts";

class MediaFileOpenError extends Schema.TaggedError<MediaFileOpenError>()("MediaFileOpenError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to open media file '${this.path}'.`;
  }
}

class MediaFileReadError extends Schema.TaggedError<MediaFileReadError>()("MediaFileReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read media file '${this.path}'.`;
  }
}

class MediaFileStatError extends Schema.TaggedError<MediaFileStatError>()("MediaFileStatError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read metadata for media file '${this.path}'.`;
  }
}

export interface OpenMediaFile {
  readonly handle: HostFileHandle;
  readonly info: HostBigIntStats;
}

export const openMediaFile = Effect.fn("openMediaFile")(function* (
  filePath: string,
  identity?: { readonly device: string; readonly inode: string },
) {
  const NodeFSP = yield* HostFileSystem;
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const before = await NodeFSP.lstat(filePath, { bigint: true });
        if (!before.isFile() || before.ino === 0n) return null;
        if (
          identity &&
          (before.dev.toString() !== identity.device || before.ino.toString() !== identity.inode)
        ) {
          return null;
        }

        // Windows lacks these flags; the descriptor/path identity checks still apply.
        const handle = await NodeFSP.open(
          filePath,
          hostFsConstants.O_RDONLY | hostFsConstants.O_NOFOLLOW | hostFsConstants.O_NONBLOCK,
        );
        let accepted = false;
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return null;
          if (
            identity &&
            (info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode)
          ) {
            return null;
          }
          // Match FileSystem.realPath's JS behavior; native realpath expands Windows 8.3 names too.
          if ((await NodeFSP.realpathLikeFileSystem(filePath)) !== filePath) return null;
          const after = await NodeFSP.lstat(filePath, { bigint: true });
          if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino) return null;
          accepted = true;
          return { handle, info } satisfies OpenMediaFile;
        } finally {
          if (!accepted) await handle.close();
        }
      },
      catch: (cause) => new MediaFileOpenError({ path: filePath, cause }),
    }),
    (file) => (file ? Effect.promise(() => file.handle.close()) : Effect.void),
  );
});

export const readMediaFileHeader = (filePath: string, file: OpenMediaFile, byteCount: number) =>
  Effect.tryPromise({
    try: async () => {
      const buffer = new Uint8Array(byteCount);
      const { bytesRead } = await file.handle.read(buffer, 0, byteCount, 0);
      return buffer.subarray(0, bytesRead);
    },
    catch: (cause) => new MediaFileReadError({ path: filePath, cause }),
  });

export const statMediaFile = Effect.fn("statMediaFile")(function* (
  filePath: string,
  file: OpenMediaFile,
) {
  return yield* Effect.tryPromise({
    try: () => file.handle.stat({ bigint: true }),
    catch: (cause) => new MediaFileStatError({ path: filePath, cause }),
  });
});

export const streamMediaFile = (file: OpenMediaFile, offset: bigint, bytesToRead: bigint) => {
  const start = Number(offset);
  const end = Number(offset + bytesToRead - 1n);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null;
  }
  return NodeStream.fromReadable<Uint8Array>({
    evaluate: () =>
      file.handle.createReadStream({
        autoClose: false,
        start,
        end,
      }),
  });
};
