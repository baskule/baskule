import { useTranslation } from "../i18n";

// baskule: "/" opens a fresh chat draft (composer first, like ChatGPT) instead of the
// most recent project's draft or the "Add project" hero.
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";

import { useBaskuleNewChat } from "./useBaskuleNewChat";

// Each failure also shows a toast, so back off: 5 s, 10 s, 20 s … up to a minute.
const retryDelayMs = (failures: number) => Math.min(5_000 * 2 ** (failures - 1), 60_000);

export function BaskuleIndexLanding() {
  const t = useTranslation();
  const { available, startNewChat } = useBaskuleNewChat();
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Consume the one-shot session-storage notification after space access is revoked.
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem("baskule:space-access-removed") !== "1") return;
      window.sessionStorage.removeItem("baskule:space-access-removed");
      toastManager.add({
        type: "info",
        title: t("Access to this space was removed"),
        description: t("You can continue in your personal space."),
        timeout: 10_000,
      });
    } catch {
      /* Browsers may disable session storage. */
    }
  }, [t]);
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const running = useRef(false);
  // Review M4: a failed start (scratch project unavailable, transient RPC error) must not leave
  // a blank page. Show it and retry on a timer, on reconnect, or on demand.
  const [failures, setFailures] = useState(0);
  const start = useEffectEvent(() => {
    if (running.current || !isStillOnIndex()) return;
    running.current = true;
    void startNewChat({ replace: true })
      .then(
        (result) => result !== null,
        () => false,
      )
      .then((ok) => {
        running.current = false;
        if (!ok && isStillOnIndex()) setFailures((count) => count + 1);
      });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the retry timer for opening the personal chat route while this landing view is mounted.
  useEffect(() => {
    if (!available) return;
    if (failures === 0) {
      start();
      return;
    }
    const timer = setTimeout(start, retryDelayMs(failures));
    return () => clearTimeout(timer);
  }, [available, failures]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {!available ? (
        <p>{t("Connecting to Baskule…")}</p>
      ) : failures === 0 ? (
        <Spinner className="size-4" />
      ) : (
        <>
          <p>{t("Couldn't start a new chat. Retrying…")}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setFailures(0)}>
            {t("Try again")}
          </Button>
        </>
      )}
    </div>
  );
}
