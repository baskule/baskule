import * as Dialog from "./ui/Dialog";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import {
  downloadAndShareAttachment,
  nativeViewerErrorMessage,
  managedAttachmentOwner,
  shareLocalAttachment,
} from "../lib/attachmentDownload";
import { assetReadScope } from "../lib/mediaActionsSource";
import { usePreviewPresentation } from "../lib/previewPresentation";
import { refreshAssetUrl, useAssetConnectionLifetime } from "../state/assets";
import { filePreviewGallery, filePreviewKey, filePreviewName } from "../lib/filePreviewGallery";
import { FilePreviewGallery } from "./FilePreviewGallery";
import { FilePreview } from "./FilePreview";
import type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

class PreviewResolutionError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly fallbackMessage: string,
  ) {
    super(fallbackMessage, { cause });
  }
}

interface ResolvedPreviewItem {
  readonly source: ResolvedFilePreviewSource;
  readonly dispose?: () => void;
}

async function resolvePreviewItem(
  item: FilePreviewItem,
  signal: AbortSignal,
): Promise<ResolvedPreviewItem | null> {
  const name = filePreviewName(item);
  if ("attachment" in item) {
    const file = await loadLocalAttachmentPreview(item.attachment, signal).catch(
      (error: unknown) => {
        throw new PreviewResolutionError(error, "Attach the file again and retry.");
      },
    );
    return file && { source: { ...item, name, uri: file.uri }, dispose: file.dispose };
  }
  if (!("environmentId" in item)) return { source: { ...item, name } };
  // Refresh expired URLs before handing them to Quick Look or ACTION_VIEW, which retain them.
  const url = await refreshAssetUrl(item.environmentId, item.resource, signal)
    .then((value) => {
      if (!value) throw new Error("Reconnect to this environment and try again.");
      return value;
    })
    .catch((error: unknown) => {
      throw new PreviewResolutionError(
        error,
        "Reconnect to this environment and try again. The file may have been moved or deleted.",
      );
    });
  return { source: { ...item, name, uri: url + (item.srcFragment ?? "") } };
}

function PreviewItemLifetime(props: {
  readonly item: FilePreviewItem;
  readonly onInvalidated: () => void;
}) {
  const environmentId = "environmentId" in props.item ? props.item.environmentId : null;
  useAssetConnectionLifetime(
    environmentId,
    props.onInvalidated,
    "resource" in props.item ? assetReadScope(props.item.resource) : undefined,
  );
  return null;
}

function ResolvedFilePreview(props: {
  readonly source: FilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  // Freeze the group at opening; streaming messages and URL refreshes must not reopen the viewer.
  const [items] = useState(() => filePreviewGallery(props.source, []));
  const selectedKey = filePreviewKey(props.source);
  const [gallery, setGallery] = useState<readonly ResolvedFilePreviewSource[] | null>(() =>
    items.every((item) => "uri" in item)
      ? items.map((item) => ({ ...item, name: filePreviewName(item) }))
      : null,
  );
  const onResolutionError = useEffectEvent((error: PreviewResolutionError) => {
    if (props.onOpenError) props.onOpenError(error.cause);
    else Dialog.alert("Could not open preview", error.fallbackMessage);
    props.onRequestClose();
  });
  // Resolves once per presentation and holds local file leases until it closes.
  useEffect(() => {
    if (items.every((item) => "uri" in item)) return;
    const controller = new AbortController();
    // The first failure closes the preview at once and cancels the rest of the gallery.
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      controller.abort();
      onResolutionError(
        error instanceof PreviewResolutionError
          ? error
          : new PreviewResolutionError(error, "Try again."),
      );
    };
    const resolving = Promise.allSettled(
      items.map((item) =>
        resolvePreviewItem(item, controller.signal).catch((error: unknown) => {
          fail(error);
          throw error;
        }),
      ),
    );
    void resolving.then((settled) => {
      if (controller.signal.aborted) return;
      const sources = settled.flatMap((item) =>
        item.status === "fulfilled" && item.value ? [item.value.source] : [],
      );
      if (sources.length === items.length) setGallery(sources);
    });
    return () => {
      controller.abort();
      void resolving.then((settled) => {
        for (const item of settled) if (item.status === "fulfilled") item.value?.dispose?.();
      });
    };
  }, [items]);
  const lifetimes = items.map((item) => (
    <PreviewItemLifetime
      key={filePreviewKey(item)}
      item={item}
      onInvalidated={props.onRequestClose}
    />
  ));
  const selected = gallery?.[items.findIndex((item) => filePreviewKey(item) === selectedKey)];
  if (!gallery || !selected) return <>{lifetimes}</>;
  const onOpenError = (error: unknown) => {
    if (props.onOpenError) {
      props.onOpenError(error);
      props.onRequestClose();
      return;
    }
    const owner = managedAttachmentOwner(selected.uri);
    let shareStarted = false;
    Dialog.alert(
      "Could not open preview",
      nativeViewerErrorMessage(error),
      [
        { text: "Cancel", style: "cancel", onPress: props.onRequestClose },
        ...(selected.kind === "document"
          ? [
              {
                text: "Save or share",
                onPress: () => {
                  shareStarted = true;
                  const input = {
                    attachment: {
                      name: filePreviewName(selected),
                      mimeType: selected.mimeType ?? "application/octet-stream",
                    },
                    signal: owner?.signal ?? new AbortController().signal,
                  };
                  const sharing = /^(file|content):/.test(selected.uri)
                    ? shareLocalAttachment({ ...input, uri: selected.uri })
                    : downloadAndShareAttachment({ ...input, url: selected.uri, transfer: null });
                  void sharing
                    .catch(() => Dialog.alert("Could not share file", "Please try again."))
                    .finally(props.onRequestClose);
                },
              },
            ]
          : []),
      ],
      {
        onDismiss: () => {
          if (!shareStarted) props.onRequestClose();
        },
      },
    );
  };
  return (
    <>
      {lifetimes}
      <FilePreview
        source={{ ...selected, gallery }}
        onRequestClose={props.onRequestClose}
        onOpenError={onOpenError}
      />
    </>
  );
}

export function FilePreviewModal(props: {
  readonly source: FilePreviewSource | null;
  readonly onRequestClose: () => void;

  readonly onOpenError?: (error: unknown) => void;
}) {
  const group = useContext(FilePreviewGallery);
  const source =
    props.source === null
      ? null
      : { ...props.source, gallery: filePreviewGallery(props.source, group) };
  usePreviewPresentation(source && filePreviewKey(source), props.onRequestClose);

  if (!source) return null;
  return (
    <ResolvedFilePreview
      key={filePreviewKey(source)}
      source={source}
      onRequestClose={props.onRequestClose}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}
