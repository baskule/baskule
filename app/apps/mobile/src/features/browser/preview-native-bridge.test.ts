import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativePreviewBridge,
  parseViewerBridgeMessage,
  type NativeViewerMessage,
  type PreviewBridgeBinding,
} from "./preview-native-bridge";
import { previewStreamDocument } from "./preview-stream-document";

class Socket extends EventTarget {
  readyState = 1;
  binaryType = "";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(generation = 7) {
    this.message(
      JSON.stringify({
        type: "control",
        canOperate: true,
        controller: "you",
        generation,
        dialog: null,
      }),
    );
  }
}
const binding: PreviewBridgeBinding = {
  environmentId: "environment",
  connectionId: "originating-connection",
  threadId: "thread",
  tabId: "tab",
  transportGeneration: 0,
};

function setup() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const post = vi.fn<(message: NativeViewerMessage) => void>();
  const state = { current: true };
  const events = {
    onViewport: vi.fn(),
    onConnectedChange: vi.fn(),
    onUnauthorized: vi.fn(),
    onControl: vi.fn(),
    onDownload: vi.fn(),
    onFileChooser: vi.fn(),
    onFailure: vi.fn(),
  };
  const createSocket = vi.fn((url: string) => {
    expect(new URL(url).pathname).toBe("/s/space/api/preview-stream/ws");
    const socket = new Socket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const bridge = createNativePreviewBridge({
    binding,
    target: {
      access: {
        httpBase: "https://front.test/s/space/api/preview-stream",
        wsBase: "wss://front.test/s/space/api/preview-stream",
        query: {},
        credentials: false,
      },
      threadId: "thread",
      tabId: "tab",
      interactive: true,
    },
    createSocket,
    isCurrent: () => state.current,
    post,
    events,
  });
  const connected = { ...binding, transportGeneration: 1 };
  bridge.receive({ type: "connect", binding: connected, width: 800, height: 600 });
  const socket = sockets[0];
  if (!socket) throw new Error("The bridge did not connect.");
  return { bridge, socket, sockets, post, createSocket, state, events, connected };
}
afterEach(() => {
  vi.useRealTimers();
});

it("uses the exact space-local stream URL with no authentication query or HTML configuration", () => {
  const { bridge, createSocket } = setup();
  expect(createSocket).toHaveBeenCalledExactlyOnceWith(
    "wss://front.test/s/space/api/preview-stream/ws?threadId=thread&tabId=tab&maxWidth=800&maxHeight=600",
  );
  const html = previewStreamDocument(
    JSON.stringify({ binding, interactive: true, background: "black" }),
    "viewer();",
  );
  expect(html).not.toMatch(/Bearer|wsTicket|authorization|front-token/);
  bridge.stop();
});

it("ACKs only consumed or discarded frames and keeps one in flight plus the latest waiting frame", () => {
  const { bridge, socket, post, connected } = setup();
  for (const value of [1, 2, 3]) socket.message(Uint8Array.of(value).buffer);
  const frames = () =>
    post.mock.calls.flatMap(([message]) => (message.type === "frame" ? [message] : []));
  expect(frames().map((frame) => frame.jpeg)).toEqual(["AQ=="]);
  expect(socket.send.mock.calls).toEqual([[JSON.stringify({ type: "ack" })]]);
  bridge.receive({ type: "consumed", binding: { ...connected, tabId: "other-tab" }, frameId: 1 });
  expect(frames()).toHaveLength(1);
  bridge.receive({ type: "consumed", binding: connected, frameId: 1 });
  expect(frames().map((frame) => frame.jpeg)).toEqual(["AQ==", "Aw=="]);
  expect(socket.send).toHaveBeenCalledTimes(2);
  bridge.receive({ type: "consumed", binding: connected, frameId: 1 });
  expect(socket.send).toHaveBeenCalledTimes(2);
  bridge.receive({ type: "consumed", binding: connected, frameId: 2 });
  expect(socket.send).toHaveBeenCalledTimes(3);
  bridge.stop();
});

it("rejects stale transport and server control generations independently", () => {
  const { bridge, socket, sockets, post, connected } = setup();
  socket.control();
  const command = {
    type: "input",
    binding: connected,
    controlGeneration: 7,
    input: { type: "text", text: "hello" },
  } as const;
  bridge.receive({ ...command, controlGeneration: 6 });
  bridge.receive({ ...command, binding: { ...connected, connectionId: "replacement" } });
  expect(socket.send).not.toHaveBeenCalled();
  bridge.receive(command);
  expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(command.input));
  bridge.receive({
    type: "connect",
    binding: { ...connected, transportGeneration: 2 },
    width: 900,
    height: 600,
  });
  expect(socket.close).toHaveBeenCalledOnce();
  post.mockClear();
  socket.message(Uint8Array.of(1).buffer);
  socket.control(99);
  bridge.receive(command);
  expect(post).not.toHaveBeenCalled();
  expect(sockets[1]?.send).not.toHaveBeenCalled();
  bridge.stop();
});

it("keeps chooser and download destination URLs in native protocol callbacks", () => {
  const { bridge, socket, post, events } = setup();
  socket.message(
    JSON.stringify({ type: "fileChooser", id: "chooser-1", multiple: true, accept: ".png" }),
  );
  socket.message(
    JSON.stringify({
      type: "download",
      id: "download-1",
      fileName: "original.bin",
      sizeBytes: 999,
    }),
  );
  expect(events.onFileChooser).toHaveBeenCalledWith({
    multiple: true,
    accept: ".png",
    credentials: false,
    uploadUrl:
      "https://front.test/s/space/api/preview-stream/upload?threadId=thread&tabId=tab&chooser=chooser-1",
  });
  expect(events.onDownload).toHaveBeenCalledWith({
    fileName: "original.bin",
    sizeBytes: 999,
    url: "https://front.test/s/space/api/preview-stream/download?threadId=thread&tabId=tab&id=download-1",
  });
  expect(JSON.stringify(post.mock.calls)).not.toMatch(/upload|download/);
  socket.message(JSON.stringify({ type: "fileChooserClosed", id: "chooser-1" }));
  expect(events.onFileChooser).toHaveBeenLastCalledWith(null);
  bridge.stop();
});

it("starts a new transport generation after socket reconnect", async () => {
  const { bridge, socket, sockets, connected, post } = setup();
  socket.dispatchEvent(new Event("open"));
  socket.dispatchEvent(
    Object.assign(new Event("close"), { code: 1001, reason: "network changed" }),
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(post).toHaveBeenLastCalledWith({ type: "reconnect", binding: connected });
  bridge.receive({
    type: "connect",
    binding: { ...connected, transportGeneration: 2 },
    width: 800,
    height: 600,
  });
  expect(sockets).toHaveLength(2);
  bridge.receive({
    type: "input",
    binding: connected,
    controlGeneration: 7,
    input: { type: "text", text: "old connection" },
  });
  expect(sockets[1]?.send).not.toHaveBeenCalled();
  bridge.stop();
});

it.each(["revoked", "stopped", "stalled"])(
  "closes a %s bridge and rejects later callbacks",
  async (kind) => {
    const { bridge, socket, state, post, events } = setup();
    if (kind === "revoked") state.current = false;
    if (kind === "stopped") bridge.stop();
    socket.message(Uint8Array.of(1).buffer);
    if (kind === "stalled") {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(events.onFailure).toHaveBeenCalledWith(expect.stringContaining("consuming frames"));
    }
    expect(socket.close).toHaveBeenCalled();
    post.mockClear();
    socket.control();
    expect(bridge.command({ type: "text", text: "stale" })).toBe(false);
    expect(post).not.toHaveBeenCalled();
    bridge.stop();
  },
);

it.each([
  "null",
  "{}",
  JSON.stringify({ type: "download", url: "https://attacker.test" }),
  JSON.stringify({ type: "input", binding, controlGeneration: 1, input: { type: "key", key: 42 } }),
  JSON.stringify({ type: "connect", binding, width: "large", height: 10 }),
])("rejects malformed or privileged WebView messages: %s", (value) => {
  expect(parseViewerBridgeMessage(value)).toBeNull();
});
