import { transferHeaders, type ProtectedTransfer } from "../../lib/nativeTransfer";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";

export function baskulePreviewStreamAccess(
  connection: PreparedConnection,
): DeviceHubAccess | null {
  if (
    !connection.socketHeaders &&
    !/^\/s\/[^/]+\/?$/.test(new URL(connection.httpBaseUrl).pathname)
  )
    return null;
  const httpBase = connection.httpBaseUrl.replace(/\/$/, "") + "/api/preview-stream";
  return { httpBase, wsBase: httpBase.replace(/^http/, "ws"), query: {}, credentials: false };
}

export function createNativePreviewSocket(
  input: ProtectedTransfer & { readonly url: string },
): WebSocket {
  const url = new URL(input.url);
  const path =
    new URL(input.origin.connection.httpBaseUrl).pathname.replace(/\/$/, "") +
    "/api/preview-stream/ws";
  if (!/^wss?:$/.test(url.protocol) || url.pathname !== path) {
    throw new Error("Invalid browser stream URL.");
  }
  transferHeaders({ ...input, url: input.url.replace(/^ws/, "http") });
  const preparedHeaders =
    input.origin.connection.httpAuthorization === null
      ? {}
      : (input.origin.connection.socketHeaders ?? {});
  const headers = Object.fromEntries(
    Object.entries(preparedHeaders).filter(([name]) => name.toLowerCase() !== "cookie"),
  );
  const NativeWebSocket = globalThis.WebSocket as unknown as new (
    url: string,
    protocols: undefined,
    options: { headers: Readonly<Record<string, string>> },
  ) => WebSocket;
  return new NativeWebSocket(input.url, undefined, { headers: { ...headers, Cookie: "" } });
}
