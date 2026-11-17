import { getTraitSelectChange } from "@t3tools/client-runtime/model-traits";
import {
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ProviderOptionDescriptor,
  type RuntimeMode,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
  withImplicitFastModeSelection,
} from "../../lib/providerOptions";
import {
  RUNTIME_MODE_CHOICES,
  resolveNewThreadRuntimeMode,
  selectableChoices,
  withManagedRuntimeModeLimits,
} from "./thread-settings-options";

const policy = (organization: string, maxRuntimeMode?: RuntimeMode): ManagedPolicySummary => ({
  organization,
  lockedSettings: [],
  ...(maxRuntimeMode === undefined ? {} : { limits: { maxRuntimeMode } }),
});

describe("managed runtime mode limits", () => {
  it("disables modes above the strictest target's ceiling with that target's reason", () => {
    const choices = withManagedRuntimeModeLimits(RUNTIME_MODE_CHOICES, [
      policy("Wide Corp", "auto"),
      undefined,
      policy("Narrow Corp", "auto-accept-edits"),
    ]);

    expect(choices.map((choice) => [choice.mode, choice.disabledReason])).toEqual([
      ["approval-required", undefined],
      ["auto-accept-edits", undefined],
      ["auto", "Narrow Corp limits threads to Auto-accept edits."],
      ["full-access", "Wide Corp limits threads to Auto."],
    ]);
  });

  it("drops a new thread's draft mode above the ceiling for the default", () => {
    const capped = policy("Corp", "auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("approval-required", "auto", capped)).toBe(
      "approval-required",
    );
    expect(resolveNewThreadRuntimeMode(undefined, "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", undefined)).toBe("full-access");
  });
});

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
  currentValue: "high",
};

describe("fast mode switch", () => {
  // regression: #29729 Cursor reports Fast on by default, but its picker shows an unset fastMode as off
  it("shows an unset fast mode as off, saves it as off and turns it on when toggled", () => {
    const capabilities = {
      optionDescriptors: [
        { id: "fastMode", label: "Fast", type: "boolean", currentValue: true } as const,
      ],
    };
    const selection = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" };
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: undefined });
    const shown = descriptors.find((descriptor) => descriptor.id === "fastMode")?.currentValue;

    expect({
      shown,
      saved: withImplicitFastModeSelection(selection, [
        { instanceId: selection.instanceId, models: [{ slug: selection.model, capabilities }] },
      ]).options,
      afterToggle: applyProviderOptionSelection(descriptors, { id: "fastMode", value: !shown }),
    }).toEqual({
      shown: false,
      saved: [{ id: "fastMode", value: false }],
      afterToggle: [{ id: "fastMode", value: true }],
    });
  });
});

describe("selectableChoices", () => {
  // regression: #21406 bring model controls in line with web
  it("includes model choices in declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("model option selections", () => {
  const thinkingDescriptor: ProviderOptionDescriptor = {
    id: "thinking",
    label: "Thinking",
    type: "boolean",
    currentValue: true,
  };
  const descriptors = [effortDescriptor, thinkingDescriptor];

  it("updates reasoning while preserving boolean options", () => {
    expect(getTraitSelectChange({ descriptors }, effortDescriptor, "low")).toEqual({
      modelOptions: [
        { id: "effort", value: "low" },
        { id: "thinking", value: true },
      ],
    });
  });

  it("updates a boolean while preserving reasoning", () => {
    expect(applyProviderOptionSelection(descriptors, { id: "thinking", value: false })).toEqual([
      { id: "effort", value: "high" },
      { id: "thinking", value: false },
    ]);
  });

  it("ignores an empty select choice", () => {
    expect(getTraitSelectChange({ descriptors }, effortDescriptor, "")).toBeNull();
  });
});
