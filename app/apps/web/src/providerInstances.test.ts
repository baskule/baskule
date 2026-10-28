import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderEntriesByEnvironment,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  resolveDefaultProviderModelSelection,
  resolveProviderCatalogAvailability,
  resolveSelectableProviderInstance,
  shouldShowInstanceBadge,
} from "./providerInstances";
function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
  supportsTextGeneration?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("isProviderInstancePickerReady", () => {
  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });
});

describe("resolveProviderCatalogAvailability", () => {
  const [entry] = deriveProviderInstanceEntries([
    provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
  ]);

  it("keeps the initial reactive config state distinct from an empty catalogue", () => {
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: false,
        entries: [],
        selectedEntry: undefined,
      }),
    ).toBe("loading");
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: true,
        entries: [],
        selectedEntry: undefined,
      }),
    ).toBe("unconfigured");
  });

  it("distinguishes a selected provider from configured but unusable providers", () => {
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: true,
        entries: entry ? [entry] : [],
        selectedEntry: entry,
      }),
    ).toBe("ready");
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: true,
        entries: entry ? [entry] : [],
        selectedEntry: undefined,
      }),
    ).toBe("unavailable");
  });
});

describe("applyProviderInstanceSettings", () => {
  it("uses settings when a streamed snapshot still reports a disabled default as enabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {
          [ProviderInstanceId.make("opencode")]: {
            driver: ProviderDriverKind.make("opencode"),
            enabled: false,
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.enabled).toBe(false);
  });

  it.each(["constructor", "toString"])(
    "treats a removed custom instance named %s as disabled",
    (instanceId) => {
      const entries = deriveProviderInstanceEntries([
        provider({
          provider: ProviderDriverKind.make("opencode"),
          instanceId,
        }),
      ]);
      const [entry] = applyProviderInstanceSettings(
        entries,
        {
          providerInstances: {},
          projectSettingsOverrides: {},
        },
        null,
      );

      expect(entry?.enabled).toBe(false);
    },
  );

  // regression: #8337 provider ids matching Object.prototype keys resolved to prototype members
  it("uses settings for a configured custom instance named constructor", () => {
    const instanceId = ProviderInstanceId.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId,
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("opencode"),
            enabled: false,
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.enabled).toBe(false);
  });

  it("uses the driver default for an unconfigured built-in default instance", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode_other",
        enabled: true,
      }),
    ]);
    const [opencode, opencode_other] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {},
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(opencode?.enabled).toBe(false);
    expect(opencode_other?.enabled).toBe(false);
  });
});

describe("deriveProviderEntriesByEnvironment", () => {
  // regression: #7292 sidebar provider icons resolved from the wrong environment
  it("keeps same-id default instances distinct per environment", () => {
    const byEnvironment = deriveProviderEntriesByEnvironment([
      [
        "local",
        [
          provider({
            provider: ProviderDriverKind.make("opencode"),
            instanceId: "opencode",
            displayName: "OpenCode Local",
            accentColor: "#112233",
          }),
        ],
      ],
      [
        "remote",
        [
          provider({
            provider: ProviderDriverKind.make("opencode"),
            instanceId: "opencode",
            displayName: "OpenCode Remote",
            accentColor: "#445566",
          }),
        ],
      ],
    ]);

    expect(byEnvironment.get("local")?.get("opencode")?.displayName).toBe("OpenCode Local");
    expect(byEnvironment.get("local")?.get("opencode")?.accentColor).toBe("#112233");
    expect(byEnvironment.get("remote")?.get("opencode")?.displayName).toBe("OpenCode Remote");
    expect(byEnvironment.get("remote")?.get("opencode")?.accentColor).toBe("#445566");
  });

  it("keeps an instance a project turns on as a sibling for the instance badge", () => {
    const opencode = ProviderDriverKind.make("opencode");
    const byEnvironment = deriveProviderEntriesByEnvironment([
      [
        "local",
        [
          provider({ provider: opencode, instanceId: "opencode" }),
          provider({ provider: opencode, instanceId: "codex_work" }),
        ],
        {
          providerInstances: {
            [ProviderInstanceId.make("codex_work")]: { driver: opencode, enabled: false },
          },
          projectSettingsOverrides: {
            [ProjectId.make("project-work")]: {
              providerInstances: { [ProviderInstanceId.make("codex_work")]: { enabled: true } },
            },
          },
        },
      ],
    ]);
    const entries = byEnvironment.get("local");
    const personal = entries?.get("opencode");

    expect(personal && shouldShowInstanceBadge(personal, entries?.values() ?? [])).toBe(true);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("opencode");
    const fallback = ProviderInstanceId.make("opencode_team");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("prefers a ready instance over an enabled one whose driver cannot start", () => {
    const notInstalled = ProviderInstanceId.make("opencode");
    const ready = ProviderInstanceId.make("opencode_team");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: ready }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(ready);
  });

  it("keeps a requested instance even when its probe errored", () => {
    const requested = ProviderInstanceId.make("opencode");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: requested,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode_team" }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  // regression: #4117 users without Codex got a broken default provider
  it("does not invent an errored instance as a new-user default", () => {
    const notInstalled = ProviderInstanceId.make("opencode");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: notInstalled,
        status: "error",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBeUndefined();
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("opencode");
    const unavailable = ProviderInstanceId.make("opencode_team");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("getDefaultProviderInstanceModel", () => {
  it("uses the instance's own models, not the default instance of the kind", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "claude_openrouter",
        models: [model("openai/gpt-5.5", true), model("claude-opus-4-8")],
      }),
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode_team",
        models: [model("claude-sonnet-5")],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claude_openrouter")),
    ).toBe("claude-opus-4-8");
  });

  it("falls back to the driver default when the instance reports no models", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode_team" }),
    ];

    const resolved = getDefaultProviderInstanceModel(
      providers,
      ProviderInstanceId.make("opencode_team"),
    );
    expect(resolved).toBe(DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("opencode")]);
  });

  it("honors the instance's declared default before model-list order", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode_team",
        models: [model("claude-sonnet-5"), model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("opencode_team")),
    ).toBe("claude-opus-4-8");
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  // regression: #4117 users without Codex got a broken default provider
  it.each([
    ["opencode", "opencode", "gpt-5.6"],
    ["opencode", "opencode_team", "claude-fable-5"],
    ["opencode", "opencode_third", "composer-2"],
  ])("uses the only available %s instance", (driver, instanceId, modelSlug) => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make(driver),
        instanceId,
        models: [model(modelSlug, false, true)],
      }),
    ];

    expect(resolveDefaultProviderModelSelection(providers, null)).toEqual({
      instanceId,
      model: modelSlug,
    });
  });

  it("preserves a valid stored selection including its options", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode_team",
        models: [model("claude-opus-4-8")],
      }),
    ];
    const stored = {
      instanceId: ProviderInstanceId.make("opencode_team"),
      model: "custom-model",
      options: [{ id: "effort", value: "high" }],
    };

    expect(resolveDefaultProviderModelSelection(providers, stored)).toBe(stored);
  });

  it("replaces a stale stored instance with the first ready instance and its model", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        status: "warning",
        models: [model("gpt-5.6")],
      }),
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode_team",
        models: [model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(
      resolveDefaultProviderModelSelection(providers, {
        instanceId: ProviderInstanceId.make("removed-provider"),
        model: "stale-model",
      }),
    ).toEqual({ instanceId: "opencode_team", model: "claude-opus-4-8" });
  });

  // regression: #4117 users without Codex got a broken default provider
  it.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "replaces an unavailable stored instance deterministically",
    (requestedState) => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make("opencode"),
          instanceId: "opencode",
          models: [model("gpt-5.6")],
          ...requestedState,
        }),
        provider({
          provider: ProviderDriverKind.make("opencode"),
          instanceId: "opencode_team",
          models: [model("claude-opus-4-8", false, true)],
        }),
      ];

      expect(
        resolveDefaultProviderModelSelection(providers, {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "gpt-5.6",
        }),
      ).toEqual({ instanceId: "opencode_team", model: "claude-opus-4-8" });
    },
  );

  it("returns no selection for empty, disabled, unavailable, or error-only profiles", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("opencode"),
            instanceId: "opencode",
            enabled: false,
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("opencode"),
            instanceId: "opencode",
            availability: "unavailable",
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("opencode"),
            instanceId: "opencode",
            status: "error",
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});
