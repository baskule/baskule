import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { Image } from "expo-image";
import { useIsFocused } from "@react-navigation/native";
import type { VideoThumbnail } from "expo-video";
import { StyleSheet } from "react-native";

import { managedAttachmentOwner } from "../lib/attachmentDownload";
import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { cachedVideoThumbnail, loadVideoThumbnail } from "../lib/videoThumbnails";

interface VideoThumbnailTarget {
  readonly cacheKey: string;
  readonly source: string | DraftComposerFileAttachment;
}

const videoThumbnailAtom = Atom.family((target: VideoThumbnailTarget) =>
  Atom.make((get) => {
    const { cacheKey, source } = target;
    const managed = typeof source === "string" && source.startsWith("file:");
    const owner = typeof source === "string" ? managedAttachmentOwner(source) : null;
    const controller = new AbortController();
    const signal = owner ? AbortSignal.any([controller.signal, owner.signal]) : controller.signal;
    let frame: VideoThumbnail | null = null;
    const invalidate = () => {
      frame?.release();
      frame = null;
      get.setSelf(null);
    };
    owner?.signal.addEventListener("abort", invalidate, { once: true });
    get.addFinalizer(() => {
      controller.abort();
      owner?.signal.removeEventListener("abort", invalidate);
      if (managed) {
        frame?.release();
        frame = null;
      }
    });
    void loadVideoThumbnail(
      managed ? null : cacheKey,
      async (loadSignal) =>
        typeof source === "string"
          ? { uri: source, dispose: () => undefined }
          : loadLocalAttachmentPreview(source, loadSignal),
      signal,
    ).then((thumbnail) => {
      if (signal.aborted) {
        if (managed) thumbnail?.release();
        return;
      }
      if (managed) frame = thumbnail;
      get.setSelf(thumbnail);
    });
    return null as VideoThumbnail | null;
  }).pipe(Atom.withLabel(`video-thumbnail:${target.cacheKey}`)),
);
const noVideoThumbnail = Atom.make<VideoThumbnail | null>(null);

export function VideoThumbnailImage(props: {
  readonly cacheKey: string;
  readonly source: string | DraftComposerFileAttachment | null;
  readonly contentFit?: "cover" | "contain";
}) {
  const { cacheKey, source } = props;
  // Extraction runs only while the screen is focused; leaving it interrupts the load.
  const isFocused = useIsFocused();
  const managed = typeof source === "string" && source.startsWith("file:");
  const thumbnail =
    useAtomValue(
      source && isFocused ? videoThumbnailAtom({ cacheKey, source }) : noVideoThumbnail,
    ) ?? (!managed && source ? cachedVideoThumbnail(cacheKey) : null);

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
