import { getTraitSelectChange } from "@t3tools/client-runtime/model-traits";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyProviderOptionSelection } from "../../lib/providerOptions";
import { selectableChoices } from "./thread-settings-options";

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
