import { Image } from "expo-image";
import { useIsFocused } from "@react-navigation/native";
import type { VideoThumbnail } from "expo-video";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";

import { managedAttachmentOwner } from "../lib/attachmentDownload";
import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { cachedVideoThumbnail, loadVideoThumbnail } from "../lib/videoThumbnails";

export function VideoThumbnailImage(props: {
  readonly cacheKey: string;
  readonly source: string | DraftComposerFileAttachment | null;
  readonly contentFit?: "cover" | "contain";
}) {
  const { cacheKey, source } = props;
  const isFocused = useIsFocused();
  const managed = typeof source === "string" && source.startsWith("file:");
  const thumbnailKey = managed ? JSON.stringify([cacheKey, source]) : cacheKey;
  const [loaded, setLoaded] = useState<{ key: string; thumbnail: VideoThumbnail } | null>(null);
  const thumbnail = source
    ? loaded?.key === thumbnailKey
      ? loaded.thumbnail
      : managed
        ? null
        : cachedVideoThumbnail(cacheKey)
    : null;

  useEffect(() => {
    if (!source || !isFocused) return;
    const controller = new AbortController();
    const ownerSignal = typeof source === "string" ? managedAttachmentOwner(source)?.signal : null;
    const signal = ownerSignal
      ? AbortSignal.any([controller.signal, ownerSignal])
      : controller.signal;
    let frame: VideoThumbnail | null = null;
    const invalidate = () => {
      setLoaded(null);
      frame?.release();
      frame = null;
    };
    ownerSignal?.addEventListener("abort", invalidate, { once: true });
    void loadVideoThumbnail(
      managed ? null : cacheKey,
      async (signal) =>
        typeof source === "string"
          ? { uri: source, dispose: () => undefined }
          : loadLocalAttachmentPreview(source, signal),
      signal,
    ).then((thumbnail) => {
      if (!thumbnail) return;
      if (signal.aborted) {
        if (managed) thumbnail.release();
        return;
      }
      if (managed) frame = thumbnail;
      setLoaded({ key: thumbnailKey, thumbnail });
    });
    return () => {
      controller.abort();
      ownerSignal?.removeEventListener("abort", invalidate);
      if (managed) invalidate();
    };
  }, [cacheKey, thumbnailKey, source, managed, isFocused]);

  return thumbnail ? (
    <Image
      source={thumbnail}
      cachePolicy={managed ? "none" : undefined}
      style={StyleSheet.absoluteFill}
      contentFit={props.contentFit ?? "cover"}
      recyclingKey={cacheKey}
      accessible={false}
    />
  ) : null;
}
