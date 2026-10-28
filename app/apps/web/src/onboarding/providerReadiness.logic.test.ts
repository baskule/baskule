import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  getOnboardingProviderState,
  selectOnboardingProvidersByDriver,
} from "./providerReadiness.logic";
const readyOpenCode: ServerProvider = {
  instanceId: ProviderInstanceId.make("opencode"),
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getOnboardingProviderState", () => {
  it("treats authenticated providers as ready only when their provider status is ready", () => {
    expect(
      getOnboardingProviderState({ ...readyOpenCode, auth: { status: "authenticated" } }),
    ).toBe("ready");
    expect(
      getOnboardingProviderState({
        ...readyOpenCode,
        auth: { status: "authenticated" },
        status: "error",
      }),
    ).toBe("attention");
    expect(
      getOnboardingProviderState({
        ...readyOpenCode,
        auth: { status: "authenticated" },
        status: "warning",
      }),
    ).toBe("attention");
  });

  it("offers sign-in only when the server reports an authentication failure", () => {
    expect(
      getOnboardingProviderState({
        ...readyOpenCode,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("signIn");
    expect(getOnboardingProviderState({ ...readyOpenCode, status: "error" })).toBe("attention");
    expect(getOnboardingProviderState({ ...readyOpenCode, status: "warning" })).toBe("attention");
  });

  it("does not offer installation or sign-in for disabled providers", () => {
    expect(getOnboardingProviderState({ ...readyOpenCode, enabled: false, installed: false })).toBe(
      "disabled",
    );
    expect(getOnboardingProviderState({ ...readyOpenCode, status: "disabled" })).toBe("disabled");
  });

  it("offers installation only when an enabled provider is missing", () => {
    expect(
      getOnboardingProviderState({ ...readyOpenCode, installed: false, status: "error" }),
    ).toBe("install");
  });
});

describe("selectOnboardingProvidersByDriver", () => {
  it("prefers a ready instance with unknown authentication to an unauthenticated instance", () => {
    const signedOutOpenCode: ServerProvider = {
      ...readyOpenCode,
      instanceId: ProviderInstanceId.make("opencode_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(
      selectOnboardingProvidersByDriver([signedOutOpenCode, readyOpenCode]).get("opencode"),
    ).toBe(readyOpenCode);
  });

  it("prefers a provider with an actionable sign-in over a failed provider", () => {
    const failedOpenCode: ServerProvider = { ...readyOpenCode, status: "error" };
    const signedOutOpenCode: ServerProvider = {
      ...readyOpenCode,
      instanceId: ProviderInstanceId.make("opencode_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(
      selectOnboardingProvidersByDriver([failedOpenCode, signedOutOpenCode]).get("opencode"),
    ).toBe(signedOutOpenCode);
  });

  it("prefers installed providers over missing or disabled instances", () => {
    const disabledOpenCode: ServerProvider = { ...readyOpenCode, enabled: false };
    const missingOpenCode: ServerProvider = {
      ...readyOpenCode,
      instanceId: ProviderInstanceId.make("opencode_work"),
      installed: false,
      status: "error",
    };

    expect(
      selectOnboardingProvidersByDriver([disabledOpenCode, missingOpenCode, readyOpenCode]).get(
        "opencode",
      ),
    ).toBe(readyOpenCode);
  });
});
