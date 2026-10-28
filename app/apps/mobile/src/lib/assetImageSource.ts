import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { ImageSource } from "expo-image";
import type { ImageURISource } from "react-native";

/** Cache immutable attachments by id; signed URLs change on each mint and reconnect. */
export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  return resource._tag === "attachment" && !uri.startsWith("file:")
    ? {
        uri,
        cacheKey: `t3-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`,
      }
    : { uri };
}

export function assetImageCachePolicy(uri: string | null | undefined): "none" | "memory-disk" {
  return uri?.startsWith("file:") ? "none" : "memory-disk";
}

export function nativeAssetImageSource(uri: string): ImageURISource {
  return uri.startsWith("file:")
    ? { uri, cache: "reload", headers: { "Cache-Control": "no-store" } }
    : { uri };
}
