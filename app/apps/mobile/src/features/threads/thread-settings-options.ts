import { t } from "../../i18n";
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";

/**
 * Prompt-injected values are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not a
 * reasoning level.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    get label() {
      return t("Supervised");
    },
    get description() {
      return t("Ask before commands and file changes.");
    },
  },
  {
    mode: "auto-accept-edits",
    get label() {
      return t("Auto-accept edits");
    },
    get description() {
      return t("Auto-approve edits, ask before other actions.");
    },
  },
  {
    mode: "auto",
    get label() {
      return t("Auto");
    },
    get description() {
      return t("Supported providers approve routine actions; others still ask.");
    },
  },
  {
    mode: "full-access",
    get label() {
      return t("Full access");
    },
    get description() {
      return t("Allow commands and edits without prompts.");
    },
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes && supportedRuntimeModes.length > 0
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}
