import { t, useTranslation } from "../../i18n";

import { type DesktopBridge, managedUpdatesDenial } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryManagedPolicy } from "../../state/managedPolicy";
import {
  checkLocalUpdate,
  downloadLocalUpdate,
  installLocalUpdate,
  type ReportLocalUpdateError,
} from "../desktopUpdate.actions";
import {
  getDesktopUpdateReleaseHistoryUrl,
  type RequiredUpdateView,
  resolveRequiredUpdateView,
} from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

function installationName(bridge: DesktopBridge | undefined): string {
  const origin = bridge?.getBaskuleServer?.();
  if (!origin) return t("This installation");
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function viewDetail(view: RequiredUpdateView, requiredVersion: string): string | null {
  switch (view.kind) {
    case "managed":
      return t("{{policy}} Ask your administrator to update Baskule to {{version}}.", {
        policy: view.detail,
        version: requiredVersion,
      });
    case "manual":
      return t("{{reason}} Download Baskule {{version}} or newer from the releases page.", {
        reason: view.detail ?? t("Automatic updates are not available in this build."),
        version: requiredVersion,
      });
    case "checking":
      return t("Looking for a compatible update…");
    case "retry":
      return view.error === null
        ? t("No compatible update is available yet. Check again later or use the releases page.")
        : null;
    case "downloading":
    case "update":
      return null;
  }
}

/** Blocks the app while it is older than its installation allows, and updates it in one step. */
export function RequiredUpdateDialog() {
  const t = useTranslation();
  const state = useDesktopUpdateState();
  // The desktop updates this machine, whose policy the primary environment reports.
  const view = resolveRequiredUpdateView(state, managedUpdatesDenial(usePrimaryManagedPolicy()));
  const [pending, setPending] = useState<"working" | "restarting" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    setSeenState(state);
    // The updater can fail after accepting the install; the app then keeps running.
    if (pending === "restarting" && state?.errorContext === "install") setPending(null);
  }

  if (view === null || state?.requiredVersion == null) return null;
  const requiredVersion = state.requiredVersion;
  const bridge = window.desktopBridge;
  const error = actionError ?? ("error" in view ? view.error : null);
  const detail = viewDetail(view, requiredVersion);

  const runAction = async () => {
    if (!bridge || pending !== null) return;
    setPending("working");
    setActionError(null);
    const reportError: ReportLocalUpdateError = (title, description) =>
      setActionError(`${title}: ${description}`);
    if (view.kind === "retry") {
      await checkLocalUpdate(bridge, { reportError });
    } else if (view.kind === "update") {
      const downloaded =
        view.action === "install" ||
        (await downloadLocalUpdate(bridge, {
          notifyDownloaded: false,
          reportError,
          reportRefused: true,
        }));
      if (downloaded && (await installLocalUpdate(bridge, { reportError, reportRefused: true }))) {
        setPending("restarting");
        return;
      }
    }
    setPending(null);
  };
  const openReleases = () =>
    void openDesktopUpdateReleaseNotes(bridge, getDesktopUpdateReleaseHistoryUrl());
  const run = pending === null ? () => void runAction() : null;

  const primary =
    pending === "restarting"
      ? { label: t("Restarting…"), busy: true, run: null }
      : view.kind === "update"
        ? { label: t("Update and restart"), busy: pending !== null, run }
        : view.kind === "downloading"
          ? {
              label:
                view.percent === null
                  ? t("Downloading update…")
                  : t("Downloading update ({{percent}}%)", { percent: Math.floor(view.percent) }),
              busy: true,
              run: null,
            }
          : view.kind === "checking"
            ? { label: t("Checking for updates…"), busy: true, run: null }
            : view.kind === "retry"
              ? { label: t("Check again"), busy: pending !== null, run }
              : view.kind === "manual"
                ? { label: t("Open releases page"), busy: false, run: openReleases }
                : null;

  return (
    <AlertDialog open>
      <AlertDialogPopup className="sm:max-w-xl" initialFocus={primaryRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Update required")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "{{installation}} requires Baskule {{requiredVersion}} or newer. This app is version {{currentVersion}}.",
              {
                installation: installationName(bridge),
                requiredVersion,
                currentVersion: state.currentVersion,
              },
            )}
          </AlertDialogDescription>
          {detail === null ? null : <p className="text-muted-foreground text-sm">{detail}</p>}
          {error === null ? null : (
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {bridge?.connectBaskuleServer ? (
            <Button
              className="sm:mr-auto"
              variant="ghost"
              onClick={() => window.location.assign("/login?server=1")}
            >
              {t("Connect to another server")}
            </Button>
          ) : null}
          {view.kind === "retry" ? (
            <Button variant="outline" onClick={openReleases}>
              {t("Open releases page")}
            </Button>
          ) : null}
          {primary === null ? null : (
            // aria-disabled keeps focus on the button while its label follows the update.
            <Button
              ref={primaryRef}
              aria-disabled={primary.run === null || undefined}
              onClick={() => primary.run?.()}
            >
              {primary.busy ? <Spinner aria-hidden /> : null}
              {primary.label}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
