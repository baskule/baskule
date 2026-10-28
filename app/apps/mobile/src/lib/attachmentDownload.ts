import { t } from "../i18n";
import { AuthOrchestrationReadScope, type ChatFileAttachment } from "@t3tools/contracts";
import type { Directory } from "expo-file-system";
import type { SharingOptions } from "expo-sharing";
import { requireNativeModule } from "expo";

import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";
import {
  bindTransferLifetime,
  fetchNativeFile,
  type ProtectedTransfer,
} from "../connection/native-transfer";

const ATTACHMENT_DOWNLOAD_DIRECTORY = "t3-attachment-downloads";
const DOWNLOAD_RETENTION_MS = 24 * 60 * 60_000;
const DOWNLOAD_DIRECTORY_NAME = /^(\d+)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const activeDirectories = new Set<string>();
const managedFiles = new Map<
  string,
  {
    readonly transfer: ProtectedTransfer;
    readonly invalidate: () => void;
    readonly signal: AbortSignal;
  }
>();

/** Local descendants inherit the captured owner, including after a viewer or chooser returns. */
export function managedAttachmentOwner(uri: string) {
  const file = managedFiles.get(uri.split("#", 1)[0]!);
  return file ? { transfer: file.transfer, signal: file.signal } : null;
}

function downloadFileName(name: string): string {
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  const sanitized = Array.from(basename, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "_"
      : character;
  })
    .join("")
    .trim();
  if (!sanitized || /^\.+$/.test(sanitized)) {
    return "attachment";
  }
  const encoder = new TextEncoder();
  if (encoder.encode(sanitized).byteLength <= 255) {
    return sanitized;
  }
  const extensionMatch = /\.[a-z0-9]{1,16}$/i.exec(sanitized);
  const extension = extensionMatch && extensionMatch.index > 0 ? extensionMatch[0] : "";
  const stem = extension ? sanitized.slice(0, -extension.length) : sanitized;
  let remainingBytes = 255 - encoder.encode(extension).byteLength;
  let shortStem = "";
  for (const character of stem) {
    const bytes = encoder.encode(character).byteLength;
    if (bytes > remainingBytes) break;
    shortStem += character;
    remainingBytes -= bytes;
  }
  return `${shortStem || "attachment"}${extension}`;
}

function removeDownloadDirectory(directory: Directory): boolean {
  try {
    if (directory.exists) {
      directory.delete();
      for (const [uri, file] of managedFiles) {
        if (uri.startsWith(`${directory.uri}/`)) file.invalidate();
      }
    }
    return true;
  } catch (error) {
    console.warn("[attachment-downloads] could not remove a cached file", error);
    return false;
  }
}

type AttachmentFileMetadata = Pick<ChatFileAttachment, "name" | "mimeType">;

export interface AttachmentPreviewFile {
  readonly uri: string;
  readonly share: (signal: AbortSignal, sourceIdentifier?: string) => Promise<void>;
  readonly dispose: () => void;
}

async function availableSharing(signal: AbortSignal) {
  if (signal.aborted) return null;
  const Sharing = await import("expo-sharing");
  const canShare = await Sharing.isAvailableAsync();
  if (signal.aborted) return null;
  if (!canShare) {
    throw new Error("Saving and sharing files is unavailable on this device.");
  }
  return Sharing;
}

async function createCachedAttachmentFile(
  attachment: AttachmentFileMetadata,
  transfer: ProtectedTransfer | null = null,
) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const cache = new Directory(Paths.cache, ATTACHMENT_DOWNLOAD_DIRECTORY);
  cache.create({ idempotent: true, intermediates: true });
  const now = Date.now();
  try {
    for (const entry of cache.list()) {
      const match = DOWNLOAD_DIRECTORY_NAME.exec(entry.name);
      if (
        entry instanceof Directory &&
        match &&
        Number(match[1]) < now - DOWNLOAD_RETENTION_MS &&
        !activeDirectories.has(entry.uri)
      ) {
        removeDownloadDirectory(entry);
      }
    }
  } catch (error) {
    console.warn("[attachment-downloads] could not inspect cached files", error);
  }

  const directory = new Directory(cache, `${now}-${uuidv4()}`);
  directory.create();
  let file: InstanceType<typeof File>;
  try {
    file = new File(directory, downloadFileName(attachment.name));
  } catch (error) {
    removeDownloadDirectory(directory);
    throw error;
  }
  activeDirectories.add(directory.uri);
  let disposed = false;
  let shared = false;
  let sharing = false;
  let invalidated = false;
  let lifetime: ReturnType<typeof bindTransferLifetime> | null = null;
  const controller = new AbortController();
  const invalidate = () => {
    invalidated = true;
    disposed = true;
    const owner = managedFiles.get(file.uri);
    managedFiles.delete(file.uri);
    activeDirectories.delete(directory.uri);
    lifetime?.dispose();
    controller.abort();
    if (transfer) {
      try {
        requireNativeModule<{ evictImage?: (uri: string) => void }>(
          "T3NativeControls",
        ).evictImage?.(file.uri);
      } catch (error) {
        console.warn("[attachment-downloads] could not evict a native image", error);
      }
    }
    if (!removeDownloadDirectory(directory) && owner) managedFiles.set(file.uri, owner);
  };
  if (transfer) {
    managedFiles.set(file.uri, { transfer, invalidate, signal: controller.signal });
    lifetime = bindTransferLifetime({
      ...transfer,
      signal: controller.signal,
      scope: transfer.scope ?? AuthOrchestrationReadScope,
      invalidate,
    });
    if (invalidated) lifetime.dispose();
  }
  const release = () => {
    if (!disposed || sharing) return;
    activeDirectories.delete(directory.uri);
    // A receiver can still be reading after Android's chooser returns.
    if (invalidated || !shared) invalidate();
  };
  const preview: AttachmentPreviewFile = {
    uri: file.uri,
    dispose: () => {
      disposed = true;
      release();
    },
    share: async (signal, sourceIdentifier) => {
      if (disposed || sharing || signal.aborted) return;
      sharing = true;
      try {
        const Sharing = await availableSharing(signal);
        if (Sharing === null || disposed) return;
        const endHandoff = beginForegroundHandoff();
        try {
          const options: SharingOptions = {
            mimeType: attachment.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream",
            dialogTitle: attachment.name,
          };
          if (sourceIdentifier) {
            const { shareFileFromSource } = await import("./shareFileFromSource");
            if (signal.aborted || disposed) return;
            await shareFileFromSource(file.uri, options, sourceIdentifier);
          } else {
            await Sharing.shareAsync(file.uri, options);
          }
          shared = true;
        } catch (cause) {
          if (!signal.aborted) {
            throw new Error("Could not open the share sheet. Try again.", { cause });
          }
        } finally {
          endHandoff();
        }
      } finally {
        sharing = false;
        release();
      }
    },
  };
  return {
    file,
    preview,
    invalidate,
    signal: controller.signal,
    retainAfterHandoff: () => {
      shared = true;
    },
  };
}

export function nativeViewerErrorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /ActivityNotFound|cannot be previewed/i.test(text)
    ? t("No app on this device can show this format. Save or share it to open it elsewhere.")
    : t("The file could not be opened. Check the connection and try again.");
}

export async function openAttachmentInViewer(input: {
  readonly uri: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly transfer: ProtectedTransfer | null;
}): Promise<void> {
  const { File } = await import("expo-file-system");
  if (input.signal.aborted) return;
  const transfer = input.transfer ?? managedAttachmentOwner(input.uri)?.transfer ?? null;
  const cached = await createCachedAttachmentFile(input.attachment, transfer);
  const signal = AbortSignal.any([input.signal, cached.signal]);
  try {
    if (signal.aborted) return;
    if (/^(file|content):/.test(input.uri)) {
      await new File(input.uri).copy(cached.file);
    } else {
      const response = await fetchNativeFile({
        url: input.uri,
        transfer,
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
      cached.file.create();
      await response.body.pipeTo(cached.file.writableStream(), { signal });
    }
    if (signal.aborted) return;
    const endHandoff = beginForegroundHandoff();
    try {
      await requireNativeModule<{ openFile(uri: string, mimeType: string): Promise<void> }>(
        "T3NativeControls",
      ).openFile(
        cached.file.uri,
        input.attachment.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream",
      );
      cached.retainAfterHandoff();
    } finally {
      endHandoff();
    }
  } finally {
    cached.preview.dispose();
  }
}

/** App-owned handoff files retain their account lifetime after the caller disposes the preview. */
export async function downloadAttachmentForPreview(input: {
  readonly url: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly transfer: ProtectedTransfer | null;
  readonly onInvalidated?: () => void;
}): Promise<AttachmentPreviewFile | null> {
  if (input.signal.aborted) return null;
  const cached = await createCachedAttachmentFile(input.attachment, input.transfer);
  const signal = AbortSignal.any([input.signal, cached.signal]);
  const onInvalidated = () => input.onInvalidated?.();
  cached.signal.addEventListener("abort", onInvalidated, { once: true });
  const dispose = () => {
    cached.signal.removeEventListener("abort", onInvalidated);
    cached.preview.dispose();
  };
  try {
    if (signal.aborted) {
      dispose();
      return null;
    }
    const response = await fetchNativeFile({
      url: input.url,
      transfer: input.transfer,
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    cached.file.create();
    await response.body.pipeTo(cached.file.writableStream(), { signal });
    if (signal.aborted) {
      dispose();
      return null;
    }
    return { ...cached.preview, dispose };
  } catch (cause) {
    // Android may leave a partial file after a failed or interrupted request.
    dispose();
    if (signal.aborted) return null;
    throw new Error("Could not download the attachment. Check the connection and try again.", {
      cause,
    });
  }
}

export async function downloadAndShareAttachment(input: {
  readonly url: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly sourceIdentifier?: string;
  readonly transfer: ProtectedTransfer | null;
}): Promise<void> {
  if ((await availableSharing(input.signal)) === null) return;
  const file = await downloadAttachmentForPreview(input);
  if (file === null) return;
  try {
    await file.share(input.signal, input.sourceIdentifier);
  } finally {
    file.dispose();
  }
}

export async function shareLocalAttachment(input: {
  readonly uri: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly sourceIdentifier?: string;
}): Promise<void> {
  if ((await availableSharing(input.signal)) === null) return;
  const { File } = await import("expo-file-system");
  const transfer = managedAttachmentOwner(input.uri)?.transfer ?? null;
  const cached = await createCachedAttachmentFile(input.attachment, transfer);
  const signal = AbortSignal.any([input.signal, cached.signal]);
  try {
    if (signal.aborted) return;
    try {
      await new File(input.uri).copy(cached.file);
    } catch (cause) {
      if (signal.aborted) return;
      throw new Error("Could not prepare the attachment for sharing.", { cause });
    }
    if (!signal.aborted) {
      await cached.preview.share(signal, input.sourceIdentifier);
    }
  } finally {
    cached.preview.dispose();
  }
}

export async function shareGeneratedAttachment(input: {
  readonly bytes: Uint8Array;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly transfer: ProtectedTransfer | null;
}): Promise<boolean> {
  const sharing = await availableSharing(input.signal).catch(() => null);
  if (sharing === null) return false;
  const cached = await createCachedAttachmentFile(input.attachment, input.transfer);
  const signal = AbortSignal.any([input.signal, cached.signal]);
  try {
    if (signal.aborted) return false;
    cached.file.write(input.bytes);
    await cached.preview.share(signal);
    return !signal.aborted;
  } finally {
    cached.preview.dispose();
  }
}
