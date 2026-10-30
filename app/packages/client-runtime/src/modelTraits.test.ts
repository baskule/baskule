import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { buildTraitsTriggerDisplay } from "./modelTraits.ts";
function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const OPENCODE = ProviderDriverKind.make("opencode");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  const { label } = buildTraitsTriggerDisplay({
    provider: OPENCODE,
    descriptors,
  });
  return { label };
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toMatchObject({
      label: "High · 1M",
    });
  });

  it("pairs fast mode with reasoning before the context window", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toMatchObject({
      label: "High Fast · 1M",
    });
    expect(display([EFFORT, CONTEXT_WINDOW, fastModeDescriptor(true)])).toMatchObject({
      label: "High Fast · 1M",
    });
  });

  it.each(["reasoningEffort", "reasoning", "effort", "variant", "thinking"])(
    "pairs Fast with %s even when context is the primary select",
    (id) => {
      for (const speed of [fastModeDescriptor(true)]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: OPENCODE,
            descriptors: [
              selectDescriptor("profile", [{ id: "balanced", label: "Balanced" }], "balanced"),
              CONTEXT_WINDOW,
              { ...EFFORT, id },
              speed,
            ],
          }),
        ).toMatchObject({ label: "Balanced · 1M · High Fast" });
      }
    },
  );

  it.each([true, false])("keeps boolean thinking %s independent of Fast", (currentValue) => {
    const thinking = {
      id: "thinking",
      label: "Thinking",
      type: "boolean" as const,
      currentValue,
    };
    const label = `Thinking ${currentValue ? "On" : "Off"}`;
    expect(display([thinking, fastModeDescriptor(true)])).toMatchObject({
      label: `${label} · Fast`,
    });
    expect(
      display([thinking, { ...EFFORT, id: "reasoning" }, fastModeDescriptor(true)]),
    ).toMatchObject({
      label: `${label} · High Fast`,
    });
    expect(display([thinking, fastModeDescriptor(false)])).toMatchObject({ label });
  });

  it("keeps speed separate when there is no reasoning descriptor", () => {
    expect(display([CONTEXT_WINDOW, fastModeDescriptor(true)])).toMatchObject({
      label: "1M · Fast",
    });
  });

  it.each(["Low", "Medium", "High", "Extra High", "Max", "Ultra"])(
    "preserves %s reasoning with Fast for OpenCode",
    (label) => {
      for (const provider of ["opencode"]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: ProviderDriverKind.make(provider),
            descriptors: [
              { ...EFFORT, options: [{ id: "effort", label }], currentValue: "effort" },
              fastModeDescriptor(true),
            ],
          }),
        ).toMatchObject({ label: `${label} Fast` });
      }
    },
  );

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toMatchObject({ label: "High · Thinking On" });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toMatchObject({ label: "Fast" });
    expect(display([fastModeDescriptor(false)])).toMatchObject({ label: "Normal" });
  });

  it("does not add Fast to a model without a speed option", () => {
    expect(display([EFFORT, CONTEXT_WINDOW])).toMatchObject({ label: "High · 1M" });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toMatchObject({ label: "" });
  });
});

it("shows Unknown until a matching provider report provides Default", () => {
  const selection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "ling",
    options: [],
  };
  const input = {
    provider: ProviderDriverKind.make("opencode"),
    descriptors: [
      selectDescriptor(
        "variant",
        [
          { id: "none", label: "None" },
          { id: "thinking", label: "Thinking" },
        ],
        "",
      ),
    ],
    modelSelection: selection,
  };
  expect(buildTraitsTriggerDisplay(input).label).toBe("Unknown");
  expect(
    buildTraitsTriggerDisplay({
      ...input,
      reportedModelSelection: { ...selection, options: [{ id: "variant", value: "default" }] },
    }).label,
  ).toBe("Default");
});
