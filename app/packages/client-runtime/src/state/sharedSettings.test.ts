import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { filterSharedServerPatch } from "./sharedSettings.ts";

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
// Every default provider is disabled until configured; these tests share selections between
// environments that have OpenCode set up.
const SETTINGS = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [ProviderInstanceId.make("opencode")]: { driver: OPENCODE_DRIVER, enabled: true },
    [ProviderInstanceId.make("opencode_work")]: { driver: OPENCODE_DRIVER, enabled: true },
  },
};

describe("filterSharedServerPatch", () => {
  it("holds the restart preference until the target's config loads", () => {
    const patch = { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, undefined)).toEqual({ sidebarAutoSettleAfterDays: 7 });
    expect(filterSharedServerPatch(patch, DEFAULT_SERVER_SETTINGS)).toEqual(patch);
  });

  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...SETTINGS,
        providerInstances: {
          opencode: { driver: OPENCODE_DRIVER, enabled: false, config: {} },
          opencode_work: { driver: OPENCODE_DRIVER, enabled: true, config: {} },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode_work"),
          model: "anthropic/claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(filterSharedServerPatch(patch, settings, settings, targetIsSource)).toEqual({
        ...(targetIsSource
          ? { textGenerationModelSelection: SETTINGS.textGenerationModelSelection }
          : {}),
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      });
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("opencode_personal");
      const selection = {
        instanceId,
        model: "openai/gpt-5",
        options: [{ id: "variant", value: "low" }],
      };
      const instance = {
        driver:
          availability === "different-driver" ? ProviderDriverKind.make("other") : OPENCODE_DRIVER,
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: OPENCODE_DRIVER, enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
    },
  );
});
