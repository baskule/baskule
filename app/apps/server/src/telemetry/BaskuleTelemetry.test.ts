// baskule: telemetry defaults OFF in Baskule deployments.
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { telemetryEnabledConfig } from "./BaskuleTelemetry.ts";

const enabledFor = (env: Record<string, string>) =>
  telemetryEnabledConfig.parse(ConfigProvider.fromEnvRecord(env));

it.effect("defaults telemetry off only for Baskule deployments", () =>
  Effect.gen(function* () {
    expect(yield* enabledFor({})).toBe(true);
    expect(yield* enabledFor({ BASKULE: "1" })).toBe(false);
    expect(yield* enabledFor({ BASKULE_AUTH_MODE: "none" })).toBe(false);
    expect(yield* enabledFor({ BASKULE: "1", T3CODE_TELEMETRY_ENABLED: "true" })).toBe(true);
    expect(yield* enabledFor({ T3CODE_TELEMETRY_ENABLED: "false" })).toBe(false);
  }),
);
