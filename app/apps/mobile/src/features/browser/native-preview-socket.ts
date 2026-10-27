import { transferHeaders, type ProtectedTransfer } from "../../connection/native-transfer";
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
