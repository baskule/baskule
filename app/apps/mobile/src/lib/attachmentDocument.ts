import { useTranslation } from "../i18n";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../components/ui/Dialog";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import type { EnvironmentId } from "@t3tools/contracts";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { File } from "expo-file-system";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import type { FileBackedComposerAttachment } from "./composerImages";
import { localAttachmentPreviewAtom, localAttachmentPreviewState } from "./localAttachmentPreview";
import { shareLocalAttachment } from "./attachmentDownload";
import { useAssetConnectionLifetime, useFreshAssetUrl, useRefreshAssetUrl } from "../state/assets";
import { attachmentDocumentPresentation } from "./attachmentDocumentPresentation";

interface AttachmentTextKey {
  readonly uri: string;
  readonly revision: number;
}

async function readAttachmentText(key: AttachmentTextKey, signal: AbortSignal) {
  return readFilePreviewResponse({ ok: true, body: new File(key.uri).readableStream() }, signal);
}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`). Unmounting the
// last reader interrupts the read.
const attachmentTextAtom = Atom.family((key: AttachmentTextKey) =>
  Atom.make(
    Effect.tryPromise({
      try: (signal) => readAttachmentText(key, signal),
      catch: (cause) => (cause instanceof Error ? cause : new Error("Could not read this file.")),
    }),
  ).pipe(Atom.withLabel("attachment-text")),
);

const noAttachmentText = Atom.make(
  AsyncResult.initial<{ text: string; truncated: boolean }, Error>(),
).pipe(Atom.withLabel("attachment-text:none"));

/** Captured bytes never resolve against the workspace. */
export function useAttachmentDocument(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId | null;
  readonly attachment: FileBackedComposerAttachment | null;
}) {
  const t = useTranslation();
  const kind = filePreviewKind(input, { richDocuments: false });
  const delimiter = filePreviewDelimiter(input);
  const shareController = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight attachment share download when the component unmounts
  useEffect(() => () => shareController.current?.abort(), []);
  const resource = {
    _tag: "attachment" as const,
    attachmentId: input.attachmentId,
    fileName: input.name,
    mimeType: input.mimeType,
    disposition: "inline" as const,
  };
  const environmentId = input.attachment ? null : input.environmentId;
  const refreshExport = useRefreshAssetUrl(environmentId, resource, "attachment");
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  useAssetConnectionLifetime(environmentId, () => {
    shareController.current?.abort();
    setInvalidated(true);
  });
  const attachment = input.attachment;
  const localPreviewAtom = localAttachmentPreviewAtom(attachment);
  const localPreview = localAttachmentPreviewState(useAtomValue(localPreviewAtom));
  const refreshLocalPreview = useAtomRefresh(localPreviewAtom);
  const remote = useFreshAssetUrl(environmentId, attachment ? null : resource, revision);
  const remoteUrl = AsyncResult.isSuccess(remote) && !remote.waiting ? remote.value : null;
  const uri = invalidated ? null : attachment ? localPreview.uri : (remoteUrl?.url ?? null);
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  const text = useAtomValue(
    uri && needsText
      ? attachmentTextAtom({
          uri,
          revision,
        })
      : noAttachmentText,
  );
  const content = AsyncResult.isSuccess(text) ? text.value : null;
  const contentError = AsyncResult.isFailure(text)
    ? (Option.getOrNull(AsyncResult.error(text))?.message ?? "Could not read this file.")
    : null;
  const table = content && delimiter ? parseDelimitedPreview(content.text, delimiter) : null;
  const presentation = attachmentDocumentPresentation({
    kind,
    hasTable: table !== null,
    hasEnvironment: input.environmentId !== null,
    rendered,
  });
  const error = attachment
    ? localPreview.error && (localPreview.error.message || t("The local file is unavailable."))
    : AsyncResult.isFailure(remote)
      ? (Option.getOrNull(AsyncResult.error(remote))?.message ??
        t("The attachment is unavailable."))
      : null;
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
    error: invalidated ? t("The attachment is unavailable.") : (error ?? contentError),
    needsText,
    rendered,
    setRendered,
    revision,
    retry: () => {
      setInvalidated(false);
      setRevision((value) => value + 1);
      if (attachment) refreshLocalPreview();
    },
    share,
    sharing,
  };
}
