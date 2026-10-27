import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("marks passive viewers without changing active viewer URLs", () => {
    const { client, socket } = connect();
    expect(new URL(socket.url).searchParams.has("interactive")).toBe(false);
    client.stop();
    const passive = createPreviewStreamClient(
      { ...target, interactive: false },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(new URL(FakeSocket.current.url).searchParams.get("interactive")).toBe("false");
    passive.stop();
  });

  it("reports a browser launch failure instead of reconnecting forever", () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
      onFailure,
    });
    const socket = FakeSocket.current;
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(
      Object.assign(new Event("close"), { code: 1011, reason: "Browser could not start" }),
    );
    expect(onFailure).toHaveBeenCalledWith("Browser could not start");
    vi.runAllTimers();
    expect(FakeSocket.current).toBe(socket);
    client.stop();
    vi.useRealTimers();
  });

  it("does not resize or navigate before ownership is granted", () => {
    const { client, socket } = connect();
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "navigate", url: "http://example.test" })).toBe(false);
    socket.control(agent);
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(client.send({ type: "text", text: "premature" })).toBe(false);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send({ type: "text", text: "owned" })).toBe(true);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "takeControl" },
      { type: "text", text: "owned" },
    ]);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame, expect.any(Function));
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});

it("defers native ACK until consumption and ignores a consumed callback after stop", () => {
  const socket = new FakeSocket("ws://fixture");
  let consume = () => {};
  const client = createPreviewStreamClient(
    target,
    {
      onFrame: (_jpeg, consumed) => {
        consume = consumed;
      },
      onViewport() {},
      onConnectedChange() {},
      onUnauthorized() {},
    },
    { createSocket: () => socket as unknown as WebSocket, acknowledgeAfterConsumption: true },
  );
  socket.message(Uint8Array.of(1).buffer);
  expect(socket.sent).toEqual([]);
  consume();
  consume();
  expect(socket.sent).toEqual([JSON.stringify({ type: "ack" })]);
  socket.message(Uint8Array.of(2).buffer);
  client.stop();
  consume();
  expect(socket.sent).toHaveLength(1);
});

it("finishes frame consumption after paint, decode failure, or intentional discard", async () => {
  const decode = Promise.withResolvers<ImageBitmap>();
  const createBitmap = vi
    .fn()
    .mockReturnValueOnce(decode.promise)
    .mockRejectedValue(new Error("bad jpeg"));
  vi.stubGlobal("createImageBitmap", createBitmap);
  try {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) };
    const painter = createPreviewFramePainter(canvas as unknown as HTMLCanvasElement);
    const consumed = [vi.fn(), vi.fn(), vi.fn()];
    painter.paint(Uint8Array.of(1).buffer, consumed[0]);
    painter.paint(Uint8Array.of(2).buffer, consumed[1]);
    painter.paint(Uint8Array.of(3).buffer, consumed[2]);
    expect(consumed[0]).not.toHaveBeenCalled();
    expect(consumed[1]).toHaveBeenCalledOnce();
    const bitmap = { width: 10, height: 20, close: vi.fn() };
    decode.resolve(bitmap as unknown as ImageBitmap);
    await vi.waitFor(() => expect(consumed[2]).toHaveBeenCalledOnce());
    expect(drawImage).toHaveBeenCalledOnce();
    expect(consumed[0]).toHaveBeenCalledOnce();
    painter.stop();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("discards an active decode after its transport's painter stops", async () => {
  const decode = Promise.withResolvers<ImageBitmap>();
  vi.stubGlobal("createImageBitmap", () => decode.promise);
  try {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) };
    const painted = vi.fn();
    const consumed = vi.fn();
    const painter = createPreviewFramePainter(canvas as unknown as HTMLCanvasElement, painted);
    painter.paint(Uint8Array.of(1).buffer, consumed);
    painter.stop();
    const close = vi.fn();
    decode.resolve({ width: 10, height: 20, close } as unknown as ImageBitmap);
    await vi.waitFor(() => expect(consumed).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
    expect(painted).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
