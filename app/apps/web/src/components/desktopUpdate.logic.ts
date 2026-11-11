import { t } from "../i18n";

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "baskule/baskule";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return t("This install is using the correct architecture.");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return t(
      "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
    );
  }
  if (action === "install") {
    return t(
      "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
    );
  }
  return t(
    "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
  );
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return t("Update {{notAppliedVersion}} did not apply. Click to retry.", {
      notAppliedVersion: state.notAppliedVersion,
    });
  }
  if (state.status === "available") {
    return t("Update {{value1}} ready to download", {
      value1: state.availableVersion ?? "available",
    });
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return t("Downloading update{{progress}}", { progress: progress });
  }
  if (state.status === "downloaded") {
    return t("Update {{value1}} downloaded. Click to restart and install.", {
      value1: state.downloadedVersion ?? state.availableVersion ?? "ready",
    });
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return t("Download failed for {{availableVersion}}. Click to retry.", {
        availableVersion: state.availableVersion,
      });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return t("Install failed for {{downloadedVersion}}. Click to retry.", {
        downloadedVersion: state.downloadedVersion,
      });
    }
    if (state.downloadedVersion) {
      return t("Update {{downloadedVersion}} downloaded. Click to restart and install.", {
        downloadedVersion: state.downloadedVersion,
      });
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return t(
    "Install update{{value1}} and restart T3 Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
    { value1: version ? ` ${version}` : "" },
  );
}

/** An accepted install never completes before the app quits, so only an error state counts. */
export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  const { state } = result;
  if (state.status !== "error" && state.errorContext === null) return null;
  const message = state.message?.trim();
  return message ? message : null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Automatic updates are not available in this build.";
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, managedDenial);
  return disabledReason
    ? { title: t("Updates unavailable"), detail: disabledReason }
    : { title: t("Check for updates"), detail: null };
}

export type RequiredUpdateView =
  | { readonly kind: "managed"; readonly detail: string }
  | { readonly kind: "manual"; readonly detail: string | null }
  | { readonly kind: "checking" }
  | { readonly kind: "downloading"; readonly percent: number | null }
  | {
      readonly kind: "update";
      readonly action: "download" | "install";
      readonly error: string | null;
    }
  | { readonly kind: "retry"; readonly error: string | null };

/** What the required-update dialog offers, or `null` while this app satisfies its installation. */
export function resolveRequiredUpdateView(
  state: DesktopUpdateState | null,
  managedDenial: string | undefined,
): RequiredUpdateView | null {
  if (state?.requiredVersion == null) return null;
  if (managedDenial !== undefined) return { kind: "managed", detail: managedDenial };
  if (!state.enabled || state.status === "disabled") {
    return { kind: "manual", detail: state.message };
  }
  if (state.status === "downloading") {
    return { kind: "downloading", percent: state.downloadPercent };
  }
  // Without an error, the message only restates the requirement the dialog already shows.
  const error = state.status === "error" || state.errorContext !== null ? state.message : null;
  const action = resolveDesktopUpdateButtonAction(state);
  if (action !== "none") return { kind: "update", action, error };
  // An installation change starts a check right after resetting to idle.
  if (state.status === "idle" || state.status === "checking") return { kind: "checking" };
  return { kind: "retry", error };
}
