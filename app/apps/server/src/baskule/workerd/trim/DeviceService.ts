// baskule: workerd replacement for `device/DeviceService.ts` (see build.mjs). Device testing (local simulators, SSH
// and EAS device hosts) needs host processes; its RPCs and MCP tools are off in a space (rpcPolicy.ts). Same service
// key; the state is "disabled" with no hosts or devices, and every operation fails. Drops ~180 KiB (hosts, hub,
// Expo/EAS clients, SSH scripts).
// The service key is the real module's, on purpose (stubs keep the replaced module's identity).
// @effect-diagnostics deterministicKeys:off
import {
  type DeviceServiceState,
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type * as Real from "../../../device/DeviceService.ts";
import { unsupportedInBaskule } from "./unsupported.ts";

export const DEVICE_HUB_ROUTE_PREFIX = "/api/device-hub";

const DISABLED: DeviceServiceState = {
  hostStatus: "disabled",
  hostStatusDetail: unsupportedInBaskule("Device testing"),
  hostStatuses: { [LOCAL_DEVICE_HOST_ID]: { status: "disabled" } },
  hosts: [],
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: DEVICE_HUB_ROUTE_PREFIX,
  revision: 0,
};

type Service = Real.DeviceService["Service"];
const fail = (operation: string) =>
  Effect.fail(
    new DeviceOperationError({
      operation,
      reason: "request_failed",
      cause: unsupportedInBaskule("Device testing"),
    }),
  );

export class DeviceService extends Context.Service<DeviceService, Service>()(
  "t3/device/DeviceService",
) {}

export const layer = Layer.effect(
  DeviceService,
  Effect.gen(function* () {
    // Never published to: subscribers see the initial state only.
    const changes = yield* PubSub.unbounded<DeviceServiceState>();
    const service: Service = {
      testHost: () => fail("testHost"),
      easAccount: () => fail("easAccount") as never,
      agentLauncher: () => fail("agentLauncher"),
      locateDevice: () => Effect.succeedNone,
      locateSession: () => Effect.succeedNone,
      agentTarget: () => fail("agentTarget"),
      state: Effect.succeed(DISABLED),
      subscribe: PubSub.subscribe(changes),
      configure: () => fail("configure"),
      list: Effect.succeed(DISABLED),
      updateTool: () => fail("updateTool"),
      inspect: Effect.succeed(DISABLED),
      retryHost: () => fail("retryHost"),
      open: () => fail("open"),
      close: () => fail("close"),
      shutdown: () => fail("shutdown"),
      detail: () => fail("detail"),
      action: () => fail("action"),
      screenshot: () => fail("screenshot"),
      readiness: () => fail("readiness"),
      readinessIfSupported: () => Effect.succeed(null),
      agentReadinessIfSupported: () => Effect.succeed(null),
      currentReadiness: () => Effect.succeed(null),
      sessionsForThread: () => Effect.succeed([]),
    };
    return service;
  }),
);

export const stateStream = (service: Service): Stream.Stream<DeviceServiceState> =>
  Stream.fromEffect(service.state);
