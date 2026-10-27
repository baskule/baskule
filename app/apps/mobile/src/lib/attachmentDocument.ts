import { useTranslation } from "../i18n";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../components/ui/Dialog";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import type { EnvironmentId } from "@t3tools/contracts";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";

import type { FileBackedComposerAttachment } from "./composerImages";
import { loadLocalAttachmentPreview } from "./localAttachmentPreview";
import { shareLocalAttachment } from "./attachmentDownload";
import { useAssetConnectionLifetime, useRefreshAssetUrl } from "../state/assets";
import { attachmentDocumentPresentation } from "./attachmentDocumentPresentation";

/**
 * Captured bytes never resolve against the workspace.
 */
export function useAttachmentDocument(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId | null;
  readonly attachment: FileBackedComposerAttachment | null;
}) {
  const t = useTranslation();
  const kind = filePreviewKind(input);
  const delimiter = filePreviewDelimiter(input);
  const shareController = useRef<AbortController | null>(null);
  useEffect(() => () => shareController.current?.abort(), []);
  const resource = {
    _tag: "attachment" as const,
    attachmentId: input.attachmentId,
    fileName: input.name,
    mimeType: input.mimeType,
    disposition: "inline" as const,
  };
  const environmentId = input.attachment ? null : input.environmentId;
  const refresh = useRefreshAssetUrl(environmentId, resource);
  const refreshExport = useRefreshAssetUrl(environmentId, resource, "attachment");
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [remoteUri, setRemoteUri] = useState<string | null>(null);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  useAssetConnectionLifetime(environmentId, () => {
    shareController.current?.abort();
    setRemoteUri(null);
    setContent(null);
  });
  const table = content && delimiter ? parseDelimitedPreview(content.text, delimiter) : null;
  const [error, setError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const presentation = attachmentDocumentPresentation({
    kind,
    hasTable: table !== null,
    hasEnvironment: input.environmentId !== null,
    rendered,
  });
  const [revision, setRevision] = useState(0);
  const [sharing, setSharing] = useState(false);
  const uri = input.attachment ? localUri : remoteUri;
  const attachment = input.attachment;
  useEffect(() => {
    if (attachment) return;
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- A new preview request clears its previous URL and error.
    setRemoteUri(null);
    setError(null);
    void refresh()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error("Reconnect to this environment and try again.");
        setRemoteUri(url);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : t("The attachment is unavailable."));
      });
    return () => {
      cancelled = true;
    };
  }, [attachment, refresh, revision]);
  useEffect(() => {
    if (!attachment) return;
    // A new attachment must not keep the previous file behind it: `share()` would otherwise
    // send the old bytes under the new name if this load fails.
    setLocalUri(null);
    setContent(null);
    setContentError(null);
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadLocalAttachmentPreview(attachment, controller.signal)
      .then((file) => {
        if (!file) return;
        if (controller.signal.aborted) return file.dispose();
        release = file.dispose;
        setLocalUri(file.uri);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : t("The local file is unavailable."));
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [attachment, revision]);
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  useEffect(() => {
    if (!uri || !needsText) return;
    const controller = new AbortController();
    setContent(null);
    setContentError(null);
    const response = Promise.resolve().then(() => ({
      ok: true,
      body: new File(uri).readableStream(),
    }));
    void response
      .then((value) => readFilePreviewResponse(value, controller.signal))
      .then((value) => {
        if (!controller.signal.aborted) setContent(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setContentError(cause instanceof Error ? cause.message : "Could not read this file.");
      });
    return () => controller.abort();
  }, [uri, needsText, revision]);
  const share = async () => {
    if (!uri || sharing) return;
    setSharing(true);
    const controller = new AbortController();
    shareController.current = controller;
    const request = {
      attachment: { name: input.name, mimeType: input.mimeType },
      signal: controller.signal,
    };
    const result = await settlePromise(async () => {
      const exportUri = attachment ? uri : await refreshExport();
      if (!exportUri) throw new Error("Reconnect to this environment and try again.");
      await shareLocalAttachment({ ...request, uri: exportUri });
    });
    if (shareController.current === controller) shareController.current = null;
    if (controller.signal.aborted) return;
    setSharing(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not share file",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    }
  };
  return {
    kind,
    ...presentation,
    uri,
    /** Native viewers resolve their own fresh URL from this instead of reusing `uri`. */
    resource,
    content,
    table,
    error: error ?? (needsText ? contentError : null),
    needsText,
    rendered,
    setRendered,
    revision,
    retry: () => setRevision((value) => value + 1),
    share,
    sharing,
  };
}
