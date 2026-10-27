// baskule: workerd replacement for `device/DeviceHubProxy.ts` (see build.mjs): no device hub in a space, so no
// `/api/device-hub/*` route (routes.ts refuses it before T3 anyway).
import * as Layer from "effect/Layer";

export const layer = Layer.empty;
