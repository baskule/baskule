import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { providerInstanceEntriesFor } from "../../providerInstances";
import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";

const opencodeId = ProviderInstanceId.make("opencode");
const high = [{ id: "effort", value: "high" }];
const savedOpenCode = createModelSelection(opencodeId, "openai/gpt-5.4", high);
function provider(input: {
  instanceId: string;
  driver: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  models: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

const bothInstances = [
  provider({ instanceId: "opencode_secondary", driver: "opencode", models: ["gpt-5.6"] }),
  provider({ instanceId: "opencode", driver: "opencode", models: ["openai/gpt-5.4"] }),
];

function present(
  providers: ReadonlyArray<ServerProvider>,
  overrides: Partial<UnifiedSettings> = {},
) {
  const settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [opencodeId]: { driver: ProviderDriverKind.make("opencode"), enabled: true },
    },
    defaultModelSelection: savedOpenCode,
    ...overrides,
  };
  return resolveDefaultModelSettingsPresentation({
    entries: providerInstanceEntriesFor(providers, settings, null),
    providers,
    settings,
    projectId: null,
  });
}

const opencodeOff: Partial<UnifiedSettings> = {
  providerInstances: {
    [opencodeId]: { driver: ProviderDriverKind.make("opencode"), enabled: false },
  },
};

describe("resolveDefaultModelSettingsPresentation", () => {
  it("keeps the saved model and explains why when its provider cannot run", () => {
    const withoutOpenCode = bothInstances.filter((entry) => entry.instanceId !== opencodeId);
    const opencodeUnavailable = bothInstances.map((entry) =>
      entry.instanceId === opencodeId ? { ...entry, availability: "unavailable" as const } : entry,
    );
    // Settings turn OpenCode off before the server snapshot reflects it.
    expect(present(bothInstances, opencodeOff)).toEqual({
      selection: savedOpenCode,
      providerNote: "OpenCode is turned off.",
    });
    expect(present(opencodeUnavailable)).toEqual({
      selection: savedOpenCode,
      providerNote: "OpenCode is unavailable.",
    });
    expect(present(withoutOpenCode)).toEqual({
      selection: savedOpenCode,
      providerNote: "This provider is not available on this environment.",
    });
  });

  it("leaves effort editable when the saved provider can run", () => {
    expect(present(bothInstances)).toEqual({ selection: savedOpenCode, providerNote: null });
  });

  it("still follows a hidden model on the same provider", () => {
    const row = present(
      [
        provider({
          instanceId: "opencode",
          driver: "opencode",
          models: ["openai/gpt-5.5", "openai/gpt-5.4"],
        }),
      ],
      {
        providerModelPreferences: {
          [opencodeId]: { hiddenModels: ["openai/gpt-5.4"], modelOrder: [] },
        },
      },
    );
    expect(row.providerNote).toBeNull();
    expect(row.selection).toMatchObject({ instanceId: opencodeId, model: "openai/gpt-5.5" });
  });
});
