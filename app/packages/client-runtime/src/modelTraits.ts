import { t } from "@t3tools/shared/localization";
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

export const REASONING_SELECT_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  ...REASONING_EFFORT_OPTION_IDS,
  "thinking",
]);

export function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor, selection, reportedSelection);
  return typeof value === "string" ? value : null;
}

export function selectableProviderOptionChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  return descriptor.options;
}

export function getTraitSelectChange(
  selected: {
    descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  },
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  value: string,
) {
  if (!value) return null;
  return {
    modelOptions: buildProviderOptionSelectionsFromDescriptors(
      replaceDescriptorCurrentValue(selected.descriptors, descriptor.id, value),
    ),
  };
}

export function buildTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  modelSelection?: ModelSelection | null;
  reportedModelSelection?: ModelSelection | null | undefined;
}): {
  label: string;
  /** "Fast" or "Ultrafast" when a speed option is on. */
  speedLabel: string | null;
  /** Labels other than reasoning and speed, such as context window or thinking. */
  otherLabels: ReadonlyArray<string>;
} {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? t("Fast") : null;
      fastModeFallbackLabel = speedLabel ?? t("Normal");
      continue;
    }
    const label =
      descriptor.type === "boolean"
        ? `${descriptor.label} ${descriptor.currentValue === true ? t("On") : t("Off")}`
        : getProviderOptionCurrentLabel(
            descriptor,
            input.modelSelection,
            input.reportedModelSelection,
          );
    if (typeof label === "string" && label.length > 0) {
      if (
        reasoningLabelIndex === -1 &&
        descriptor.type === "select" &&
        REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id)
      ) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  const otherLabels = labels.filter((_, index) => index !== reasoningLabelIndex);
  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel, speedLabel, otherLabels };
  }
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return { label: labels.join(" · "), speedLabel, otherLabels };
}
