// baskule: opening a connection link (`/link#code=…`) signs this browser or desktop window in.
import { useEffect, useRef, useState } from "react";
import type { BaskuleManagementDestination } from "@t3tools/contracts/baskule";

import { useTranslation } from "../../i18n";

import { Button } from "../../components/ui/button";
import { StandalonePage } from "../../components/ui/standalone-page";
import { baskuleApi } from "../api";
import { errorText, BaskuleWordmark } from "../ui";

export function ConnectLinkView({
  code,
  destination = "/",
}: {
  readonly code: string | null;
  readonly destination?: BaskuleManagementDestination | "/";
}) {
  const t = useTranslation();
  const [error, setError] = useState<string | null>(
    code === null ? t("This link has no connection code in it. Copy the whole link.") : null,
  );
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = async () => {
    if (!code || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    return (async () => {
      await baskuleApi.redeemConnectCode(code);
      if (mounted.current) window.location.replace(destination);
    })()
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(errorText(cause, t("This device could not be connected.")));
          setBusy(false);
        }
      })
      .finally(() => {
        submitting.current = false;
      });
  };

  return (
    <StandalonePage tone="brand">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <BaskuleWordmark className="text-base" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {busy ? t("Connecting…") : t("Connect this browser")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Sign this browser in as the person who created this link. This replaces any account currently signed in here.",
            )}
          </p>
          <p className="break-all text-sm">{window.location.origin}</p>
          <p className="text-sm text-muted-foreground">
            {t(
              "This browser stays signed in independently. Signing out of your phone does not sign this browser out.",
            )}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </div>
        <Button disabled={!code || busy} onClick={() => void connect()}>
          {t("Confirm connection")}
        </Button>
        <Button variant="outline" render={<a href="/" />}>
          {t("Cancel")}
        </Button>
      </div>
    </StandalonePage>
  );
}
