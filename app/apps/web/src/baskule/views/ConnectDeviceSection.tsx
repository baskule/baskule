import { useEffect, useState } from "react";

import { useTranslation } from "../../i18n";

import { Button } from "../../components/ui/button";
import { QRCodeSvg } from "../../components/ui/qr-code";
import { Spinner } from "../../components/ui/spinner";
import { baskuleApi } from "../api";
import {
  canHandOffToDesktopApp,
  connectLink,
  desktopConnectLink,
  installationOrigin,
} from "../connect";
import { useBaskuleMe } from "../session";
import { notifyError } from "../ui";
import { CopyField } from "./AddPersonDialog";
import { PageSection } from "./BaskulePage";
import { ReceiveConnectionDialog } from "./ReceiveConnectionDialog";

export function ConnectDeviceSection() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const origin = installationOrigin();
  const [link, setLink] = useState<
    | { readonly kind: "active"; readonly url: string; readonly expiresAt: number }
    | { readonly kind: "expired" }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (link?.kind !== "active") return;
    const timer = setTimeout(
      () => setLink({ kind: "expired" }),
      Math.max(0, link.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [link]);

  const showLink = async () => {
    setBusy(true);
    try {
      const { code, expiresAt } = await baskuleApi.createConnectCode();
      setLink({ kind: "active", url: connectLink(origin, code), expiresAt });
    } catch (cause) {
      notifyError(t("Could not create a connection link"), cause);
    } finally {
      setBusy(false);
    }
  };

  const openDesktop = async () => {
    setBusy(true);
    try {
      const { code } = await baskuleApi.createConnectCode();
      window.location.href = desktopConnectLink(origin, code);
    } catch (cause) {
      notifyError(t("Could not open the desktop app"), cause);
    } finally {
      setBusy(false);
    }
  };

  const expires =
    link?.kind === "active"
      ? new Date(link.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  // An anonymous installation has no accounts to hand over: apps connect with the address alone.
  if (me?.authentication.mode === "anonymous") {
    return (
      <PageSection
        title={t("Connect a device")}
        description={t(
          "Scan this server address with Baskule on another device, or receive a connection on this device.",
        )}
      >
        <div className="flex flex-col gap-4 px-3 py-3 sm:px-4">
          <ReceiveConnectionDialog />
          <QRCodeSvg
            value={origin}
            size={192}
            marginSize={4}
            title={t("Server address for another device")}
            className="self-start"
          />
          <CopyField label={t("Server address")} value={origin} />
        </div>
      </PageSection>
    );
  }
  return (
    <PageSection
      title={t("Connect a device")}
      description={t(
        "Sign in on your phone or computer without typing a password. A connection link works once and expires after 10 minutes.",
      )}
    >
      <div className="flex flex-col gap-4 px-3 py-3 sm:px-4">
        <ReceiveConnectionDialog />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void showLink()}>
            {busy ? <Spinner size="sm" /> : null}
            {link ? t("New connection link") : t("Show QR for another device")}
          </Button>
          {canHandOffToDesktopApp(navigator.userAgent) ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void openDesktop()}>
              {t("Open in the desktop app")}
            </Button>
          ) : null}
        </div>
        {link?.kind === "expired" ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("This connection link expired. Create a new one to sign in another device.")}
          </p>
        ) : null}
        {link?.kind === "active" ? (
          <div className="flex flex-col gap-3">
            <QRCodeSvg
              value={link.url}
              size={192}
              marginSize={4}
              title={t("Sign-in link for another device")}
              className="self-start"
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "Scan with Baskule on the device you want to sign in, or paste the link there. Valid until {{time}}.",
                { time: expires },
              )}
            </p>
            <CopyField label={t("Connection link")} value={link.url} />
          </div>
        ) : null}
        <CopyField label={t("Server address")} value={origin} />
      </div>
    </PageSection>
  );
}
