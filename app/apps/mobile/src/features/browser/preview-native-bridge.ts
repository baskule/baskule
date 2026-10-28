import {
  createPreviewStreamClient,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamEvents,
  type PreviewStreamInput,
  type PreviewStreamPointer,
  type PreviewStreamProbe,
  type PreviewStreamTarget,
  type PreviewStreamViewport,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { PreviewViewportSetting } from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Schema from "effect/Schema";

const Binding = Schema.Struct({
  environmentId: Schema.String,
  connectionId: Schema.String,
  threadId: Schema.String,
  tabId: Schema.String,
  transportGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PreviewBridgeBinding = typeof Binding.Type;

export function samePreviewBinding(a: PreviewBridgeBinding, b: PreviewBridgeBinding): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.connectionId === b.connectionId &&
    a.threadId === b.threadId &&
    a.tabId === b.tabId &&
    a.transportGeneration === b.transportGeneration
  );
}

const number = Schema.Number.check(Schema.isFinite());
const dimensions = { width: number, height: number };
const point = { x: number, y: number };
const Input = Schema.Union([
  Schema.Struct({ type: Schema.Literal("takeControl") }),
  Schema.Struct({ type: Schema.Literal("releaseControl") }),
  Schema.Struct({
    type: Schema.Literal("dialog"),
    accept: Schema.Boolean,
    promptText: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("viewport"), setting: PreviewViewportSetting }),
  Schema.Struct({
    type: Schema.Literal("mouse"),
    ...point,
    action: Schema.Literals(["move", "down", "up"]),
    button: Schema.Literals(["none", "left", "middle", "right"]),
    buttons: number,
    clickCount: number,
    modifiers: number,
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    ...point,
    deltaX: number,
    deltaY: number,
    modifiers: number,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    key: Schema.String,
    code: Schema.String,
    keyCode: Schema.optionalKey(number),
    text: Schema.optionalKey(Schema.String),
    modifiers: number,
  }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("resize"), ...dimensions }),
  Schema.Struct({ type: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("history"), delta: Schema.Literals([-1, 1]) }),
  Schema.Struct({
    type: Schema.Literal("reload"),
    ignoreCache: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("probe"), ...point }),
]);
const ViewerMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connect"), binding: Binding, ...dimensions }),
  Schema.Struct({ type: Schema.Literal("consumed"), binding: Binding, frameId: number }),
  Schema.Struct({
    type: Schema.Literal("input"),
    binding: Binding,
    controlGeneration: number,
    input: Input,
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    binding: Binding,
    status: Schema.Literals(["connecting", "streaming", "error"]),
    detail: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("pictureInPicture"),
    binding: Binding,
    supported: Schema.Boolean,
    active: Schema.Boolean,
    detail: Schema.optionalKey(Schema.String),
  }),
]);
export type ViewerBridgeMessage = typeof ViewerMessage.Type;
const isViewerMessage = Schema.is(ViewerMessage);

export function parseViewerBridgeMessage(data: string): ViewerBridgeMessage | null {
  if (data.length > 256_000) return null;
  try {
    const value: unknown = JSON.parse(data);
    return isViewerMessage(value) ? value : null;
  } catch {
    return null;
  }
}

export type NativeViewerMessage = { readonly binding: PreviewBridgeBinding } & NativeViewerPayload;
type NativeViewerPayload =
  | { readonly type: "frame"; readonly frameId: number; readonly jpeg: string }
  | { readonly type: "control"; readonly control: PreviewStreamControl }
  | { readonly type: "viewport"; readonly viewport: PreviewStreamViewport }
  | { readonly type: "probe"; readonly probe: PreviewStreamProbe }
  | { readonly type: "pointer"; readonly pointer: PreviewStreamPointer }
  | { readonly type: "connected"; readonly connected: boolean }
  | { readonly type: "reconnect" };

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const CONSUMPTION_TIMEOUT_MS = 15_000;

export function createNativePreviewBridge(input: {
  readonly binding: PreviewBridgeBinding;
  readonly target: Omit<PreviewStreamTarget, "maxWidth" | "maxHeight">;
  readonly createSocket: (url: string) => WebSocket;
  readonly isCurrent: () => boolean;
  readonly post: (message: NativeViewerMessage) => void;
  readonly events: Omit<PreviewStreamEvents, "onFrame">;
}) {
  let binding = input.binding;
  let client: PreviewStreamClient | null = null;
  let stopped = false;
  let controlGeneration = -1;
  let frameId = 0;
  type Frame = { jpeg: ArrayBuffer; consumed: () => void };
  let inFlight: { id: number; consumed: () => void } | null = null;
  let waiting: Frame | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const discardFrames = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    inFlight?.consumed();
    waiting?.consumed();
    inFlight = waiting = null;
  };
  const stop = () => {
    stopped = true;
    client?.stop();
    client = null;
    discardFrames();
  };
  const current = () => {
    if (!input.isCurrent()) stop();
    return !stopped;
  };
  const deliver = (frame: Frame) => {
    const id = ++frameId;
    inFlight = { id, consumed: frame.consumed };
    timer = setTimeout(() => {
      stop();
      input.events.onFailure?.("Browser viewer stopped consuming frames. Reconnect to try again.");
    }, CONSUMPTION_TIMEOUT_MS);
    input.post({
      type: "frame",
      binding,
      frameId: id,
      jpeg: Base64.encode(new Uint8Array(frame.jpeg)),
    });
  };
  const command = (message: PreviewStreamInput) => current() && (client?.send(message) ?? false);
  return {
    stop,
    command,
    accepts: (message: ViewerBridgeMessage) =>
      current() && samePreviewBinding(binding, message.binding),
    receive: (message: ViewerBridgeMessage) => {
      if (!current()) return;
      if (message.type === "connect") {
        if (
          !samePreviewBinding(
            { ...binding, transportGeneration: binding.transportGeneration + 1 },
            message.binding,
          )
        )
          return;
        client?.stop();
        discardFrames();
        binding = message.binding;
        controlGeneration = -1;
        const connectedBinding = binding;
        const live = () => current() && samePreviewBinding(binding, connectedBinding);
        const post = (event: NativeViewerPayload) => {
          if (live()) input.post({ ...event, binding });
        };
        client = createPreviewStreamClient(
          {
            ...input.target,
            maxWidth: Math.min(4096, Math.max(1, message.width)),
            maxHeight: Math.min(4096, Math.max(1, message.height)),
          },
          {
            ...input.events,
            onFrame: (jpeg, consumed) => {
              if (!live()) return consumed();
              if (jpeg.byteLength > MAX_FRAME_BYTES) {
                consumed();
                stop();
                input.events.onFailure?.("Browser frame exceeds the viewer limit.");
                return;
              }
              if (inFlight) {
                waiting?.consumed();
                waiting = { jpeg, consumed };
              } else deliver({ jpeg, consumed });
            },
            onControl: (control) => {
              if (!live()) return;
              controlGeneration = control.generation;
              input.events.onControl?.(control);
              post({ type: "control", control });
            },
            onViewport: (viewport) => {
              if (live()) input.events.onViewport(viewport);
              post({ type: "viewport", viewport });
            },
            onProbe: (probe) => post({ type: "probe", probe }),
            onPointer: (pointer) => post({ type: "pointer", pointer }),
            onConnectedChange: (connected) => {
              if (!live()) return;
              if (!connected) {
                controlGeneration = -1;
                discardFrames();
              }
              input.events.onConnectedChange(connected);
              post({ type: "connected", connected });
            },
          },
          {
            createSocket: input.createSocket,
            acknowledgeAfterConsumption: true,
            reconnect: () => post({ type: "reconnect" }),
          },
        );
        return;
      }
      if (!samePreviewBinding(binding, message.binding)) return;
      if (message.type === "input" && message.controlGeneration === controlGeneration)
        command(message.input);
      if (message.type === "consumed" && inFlight?.id === message.frameId) {
        if (timer) clearTimeout(timer);
        timer = null;
        inFlight.consumed();
        inFlight = null;
        const next = waiting;
        waiting = null;
        if (next) deliver(next);
      }
    },
  };
}
