import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { ImageSource } from "expo-image";
import type { ImageURISource } from "react-native";

/**
 * Every mint signs a new URL, and a reconnect mints again, so a URL-keyed cache
 * misses each time. Attachments never change once stored, so they cache under
 * their id instead.
 */
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
