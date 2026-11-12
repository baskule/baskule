// @effect-diagnostics effectFnOpportunity:off -- inert implementations perform no operations to trace.
// Hosted Spaces have no desktop input, power feed, native resource process, or Connect tunnel.
import { KeybindingsConfigError } from "@t3tools/contracts";
import {
  DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as PlatformError from "effect/PlatformError";
import * as ConnectReachability from "../../cloud/ConnectReachability.ts";
import * as SpeechModelStore from "../../speech/SpeechModelStore.ts";
import * as Stream from "effect/Stream";
import * as Keybindings from "../../keybindings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as NativeTelemetryClient from "../../resourceTelemetry/NativeTelemetryClient.ts";
import * as ManagedEndpointRuntime from "../../cloud/ManagedEndpointRuntime.ts";

// The hosted adapter manages keybindings.json as []; clients receive the same compiled defaults.
// This value contains no Space state. Mutations are already refused by the hosted RPC policy.
const keybindings = {
  keybindings: mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS)),
  issues: [],
} satisfies Keybindings.KeybindingsConfigState;
const readKeybindings = Effect.succeed(keybindings);
const refusedKeybinding = Effect.fail(
  new KeybindingsConfigError({
    configPath: "keybindings.json",
    detail: "Keybindings are managed by Baskule.",
  }),
);
export const layerKeybindings = Layer.succeed(Keybindings.Keybindings, {
  start: Effect.void,
  ready: Effect.void,
  syncDefaultKeybindingsOnStartup: Effect.void,
  loadConfigState: readKeybindings,
  getSnapshot: readKeybindings,
  streamChanges: Stream.never,
  subscribeChanges: Effect.succeed(Stream.never),
  upsertKeybindingRule: () => refusedKeybinding,
  removeKeybindingRule: () => refusedKeybinding,
});

// Telemetry is unconditionally disabled by SpaceServer's managed configuration.
export const layerAnalytics = Layer.succeed(AnalyticsService.AnalyticsService, {
  record: () => Effect.void,
  flush: Effect.void,
  recordOwners: () => Effect.void,
});

// Retain BackgroundPolicy's unknown-power behavior and client activity leases, without a desktop reader.
export const layerHostPower = Layer.effect(
  HostPowerMonitor.HostPowerMonitor,
  HostPowerMonitor.make(),
);

const unavailable = Effect.fail(
  new NativeTelemetryClient.NativeTelemetryUnavailable({
    reason: "A hosted Space has no native resource monitor.",
  }),
);
const health: NativeTelemetryClient.NativeTelemetryClientHealth = {
  status: "unavailable",
  hello: Option.none(),
  lastSampleAt: Option.none(),
  lastError: Option.some("A hosted Space has no native resource monitor."),
  restartCount: 0,
  sampleIntervalMs: 0,
};
export const layerNativeTelemetry = Layer.succeed(NativeTelemetryClient.NativeTelemetryClient, {
  capabilities: unavailable,
  snapshots: Stream.never,
  readHistory: () => unavailable,
  setExternalProcesses: () => Effect.void,
  setHostPowerState: () => Effect.void,
  sampleNow: unavailable,
  processTable: unavailable,
  retry: Effect.succeed(false),
  health: Effect.succeed(health),
  subscribeHealth: Effect.succeed({ latest: health, changes: Stream.never }),
});

export const layerManagedEndpoint = Layer.succeed(
  ManagedEndpointRuntime.CloudManagedEndpointRuntime,
  {
    applyConfig: (config) =>
      Effect.succeed(
        config === null
          ? { status: "disabled" }
          : { status: "unsupported", providerKind: config.providerKind },
      ),
    inspectConnector: Effect.succeed(null),
    readinessChanged: Stream.never,
    recoveryRequests: Stream.never,
    requestRecovery: () => Effect.void,
    restartConnector: () => Effect.succeed(false),
    tunnelConnected: Stream.never,
    withLinkStateLock: (effect) => effect,
  },
);

// No Connect address is configured for a Space; the installation front owns reachability.
export const layerConnectReachability = Layer.succeed(ConnectReachability.ConnectReachability, {
  latest: Effect.succeedNone,
  check: Effect.map(DateTime.now, (now) =>
    ConnectReachability.classifyReachability(
      {
        managedTunnelConfigured: false,
        connector: null,
        endpoint: null,
        edgeReachable: null,
        exitNode: null,
      },
      DateTime.formatIso(now),
    ),
  ),
});

// Installation transcription runs outside the Space; native speech files cannot be installed here.
const speechUnsupported = Effect.fail(
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "speechModel",
    pathOrDescriptor: "speech",
    description: "Hosted Spaces do not install native speech models.",
  }),
);
export const layerSpeechModelStore = Layer.succeed(SpeechModelStore.SpeechModelStore, {
  isReady: () => Effect.succeed(false),
  installedPath: () => Effect.undefined,
  download: () => speechUnsupported,
  link: () => speechUnsupported,
  linkedFrom: () => Effect.undefined,
  remove: () => speechUnsupported,
});
