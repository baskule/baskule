import { t } from "../../i18n";

import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  neutral: {
    dot: "bg-muted-foreground",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

export function getProviderStatusKey(provider: ServerProvider | undefined): ProviderStatusKey {
  if (provider && !provider.enabled) return "disabled";
  return provider?.status ?? "warning";
}

export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: t("Waiting for the server to report installation and authentication details."),
    };
  }
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: t("Disabled"),
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in T3 Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Not authenticated · ${authLabel}` : t("Not authenticated"),
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: t("Unavailable"),
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : t("Authenticated"),
      detail: provider.message ?? null,
    };
  }
  return {
    headline: t("Available"),
    detail: provider.message ?? null,
  };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES = {
  get graceful() {
    return t("Limited support");
  },
  get unsupported() {
    return t("Unsupported version");
  },
  get broken() {
    return t("Known broken version");
  },
} as const;

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
} | null {
  const latestIsIncompatible =
    compatibility?.latestVersionStatus === "broken" ||
    compatibility?.latestVersionStatus === "unsupported";
  if (
    showCompatibility &&
    compatibility &&
    (compatibility.status === "graceful" ||
      compatibility.status === "unsupported" ||
      compatibility.status === "broken")
  ) {
    const targetVersion = compatibility.recommendedVersion;
    const recommendation = getProviderVersionLabel(targetVersion) ?? compatibility.recommendedRange;
    // Latest package versions cannot be updated into recommendations requiring another package.
    const isAlreadyLatest = advisory?.status === "current";
    return {
      title: COMPATIBILITY_TITLES[compatibility.status],
      detail:
        compatibility.message ??
        (recommendation ? `Use ${recommendation} for full support.` : "Update for full support."),
      updateCommand:
        targetVersion || latestIsIncompatible || isAlreadyLatest
          ? null
          : (advisory?.updateCommand ?? null),
      emphasis: compatibility.status === "graceful" ? "normal" : "strong",
      targetVersion,
    };
  }
  if (
    !advisory ||
    advisory.status === "current" ||
    advisory.status === "unknown" ||
    latestIsIncompatible
  ) {
    return null;
  }

  const label = t("Update available");
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: label,
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}
