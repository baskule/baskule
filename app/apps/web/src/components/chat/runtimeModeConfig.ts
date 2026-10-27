import { t } from "../../i18n";
import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    get label() {
      return t("Supervised");
    },
    get description() {
      return t("Ask before commands and file changes.");
    },
    icon: LockIcon,
  },
  "auto-accept-edits": {
    get label() {
      return t("Auto-accept edits");
    },
    get description() {
      return t("Auto-approve edits, ask before other actions.");
    },
    icon: PenLineIcon,
  },
  auto: {
    get label() {
      return t("Auto");
    },
    get description() {
      return t("Supported providers approve routine actions; others still ask.");
    },
    icon: SparklesIcon,
  },
  "full-access": {
    get label() {
      return t("Full access");
    },
    get description() {
      return t("Allow commands and edits without prompts.");
    },
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
