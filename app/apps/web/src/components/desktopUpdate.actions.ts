import { t } from "../i18n";

import type { DesktopBridge } from "@t3tools/contracts";

import { getDesktopUpdateActionError } from "./desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";
import { stackedThreadToast, toastManager } from "./ui/toast";

export type ReportLocalUpdateError = (title: string, description: string) => void;

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : t("An unexpected error occurred.");
}

export async function checkLocalUpdate(
  bridge: DesktopBridge,
  {
    reportError = toastUpdateError,
    unavailableReason,
  }: {
    readonly reportError?: ReportLocalUpdateError;
    readonly unavailableReason?: string | undefined;
  } = {},
): Promise<boolean> {
  try {
    const result = await bridge.checkForUpdate();
    if (!result.checked) {
      reportError(
        t("Could not check for updates"),
        unavailableReason ??
          result.state.message ??
          t("Automatic updates are not available in this build."),
      );
    }
    return result.checked;
  } catch (error) {
    reportError(
      t("Could not check for updates"),
      error instanceof Error ? error.message : t("Update check failed."),
    );
    return false;
  }
}

export async function downloadLocalUpdate(
  bridge: DesktopBridge,
  {
    notifyDownloaded,
    reportError = toastUpdateError,
    reportRefused = false,
  }: {
    readonly notifyDownloaded: boolean;
    readonly reportError?: ReportLocalUpdateError;
    readonly reportRefused?: boolean;
  },
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (result.completed && notifyDownloaded) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
    }
    if (!result.accepted && reportRefused) {
      reportError(t("Could not download update"), t("The download did not start. Try again."));
    }
    const actionError = getDesktopUpdateActionError(result);
    if (actionError) reportError(t("Could not download update"), actionError);
    return result.completed;
  } catch (error) {
    reportError(t("Could not start update download"), describeError(error));
    return false;
  }
}

/** A refused install toasts that the download is ready, unless `reportRefused` reports it. */
export async function installLocalUpdate(
  bridge: DesktopBridge,
  {
    reportError = toastUpdateError,
    reportRefused = false,
  }: { readonly reportError?: ReportLocalUpdateError; readonly reportRefused?: boolean } = {},
): Promise<boolean> {
  try {
    const result = await bridge.installUpdate();
    if (!result.accepted) {
      if (reportRefused) {
        reportError(
          t("Could not install update"),
          t("The update is not ready to install yet. Try again."),
        );
      } else {
        showDesktopUpdateDownloadedToast(bridge, result.state);
      }
      return false;
    }
    const actionError = getDesktopUpdateActionError(result);
    if (!actionError) return true;
    reportError(t("Could not install update"), actionError);
    return false;
  } catch (error) {
    reportError(t("Could not install update"), describeError(error));
    return false;
  }
}
