import { useTranslation } from "../../i18n";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { baskuleApi } from "../api";

/** Electron uses the system browser, since identity providers can reject embedded browsers. */
export function BrowserSignInButton({
  next,
  onError,
}: {
  next: string;
  onError: (message: string) => void;
}) {
  const t = useTranslation();
  const [pending, setPending] = useState<{ id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll the pending browser sign-in exchange only until the exchange or mounted view ends.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false,
      polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void baskuleApi
        .pollBrowserLogin(pending)
        .then((result) => {
          if (!cancelled && result.token) {
            clearInterval(timer);
            window.location.assign(next);
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            onError(cause instanceof Error ? cause.message : t("Sign-in expired."));
            setPending(null);
          }
        })
        .finally(() => {
          polling = false;
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pending, next, onError, t]);
  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        disabled={busy || pending !== null}
        onClick={() => {
          setBusy(true);
          void baskuleApi
            .requestBrowserLogin()
            .then((login) => {
              setPending({ id: login.id, secret: login.secret });
              window.open(login.url, "_blank", "noopener,noreferrer");
            })
            .catch((cause) =>
              onError(cause instanceof Error ? cause.message : t("Could not start sign-in.")),
            )
            .finally(() => setBusy(false));
        }}
      >
        {pending ? t("Waiting for browser…") : t("Sign in in browser")}
      </Button>
      {pending ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("Finish signing in and approve the app connection in your browser.")}
          </p>
          <Button variant="ghost" onClick={() => setPending(null)}>
            {t("Cancel")}
          </Button>
        </>
      ) : null}
    </div>
  );
}
