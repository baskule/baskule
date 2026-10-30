import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import * as Dpop from "../features/cloud/dpop";
import * as ManagedRelayLayer from "../features/cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../features/cloud/publicConfig";
import * as Persistence from "../persistence/layer";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";
import { whenProtectedDataAvailable } from "./protectedData";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relay.url ?? "http://relay.invalid";
}

const layerHttpClient = layerRemoteHttpClient(fetch);

// baskule: Baskule spaces authenticate the socket upgrade from `Authorization` (no T3 ticket).
// React Native's WebSocket takes handshake headers as a third argument; Effect's global
// constructor refuses an options object, so map `{ protocols, headers }` here.
const layerWebSocketConstructor = Layer.succeed(Socket.WebSocketConstructor, (url, options) => {
  if (options === undefined || typeof options === "string" || Array.isArray(options)) {
    return new globalThis.WebSocket(url, options);
  }
  const NativeWebSocket = globalThis.WebSocket as unknown as new (
    url: string,
    protocols: string | Array<string> | undefined,
    options: { headers?: Readonly<Record<string, string>> },
  ) => globalThis.WebSocket;
  return new NativeWebSocket(url, options.protocols, { headers: options.headers });
});

type RuntimeLayerSource =
  | ReturnType<typeof ManagedRelayLayer.layer>
  | typeof layerWebSocketConstructor
  | typeof Dpop.layer
  | typeof layerHttpClient
  | typeof Persistence.layer;

const layerRuntime = Layer.merge(
  ManagedRelayLayer.layer(configuredRelayUrl()),
  layerWebSocketConstructor,
).pipe(
  Layer.provideMerge(Dpop.layer),
  Layer.provideMerge(layerHttpClient),
  Layer.provideMerge(Persistence.layer),
  // These layers read the keychain and the database while they build, and a
  // failed build is kept for the life of the process.
  Layer.provide(Layer.effectDiscard(Effect.promise(whenProtectedDataAvailable))),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
