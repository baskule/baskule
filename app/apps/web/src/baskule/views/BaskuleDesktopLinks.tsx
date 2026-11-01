import { useTranslation } from "../../i18n";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";

import { DesktopServerForm } from "./DesktopServerForm";

/** A one-time OS connection link is shown for approval before changing installations. */
export function BaskuleDesktopLinks() {
  const t = useTranslation();
  const [link, setLink] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register desktop deep-link delivery and release readiness when the handler unmounts.
  useEffect(() => {
    const links = window.desktopBridge?.webLinks;
    if (!links) return;
    const unsubscribe = links.onOpen((url) => {
      if (url.startsWith("baskule://connect?")) setLink(url);
    });
    void links.setReady(true);
    return () => {
      unsubscribe();
      void links.setReady(false);
    };
  }, []);
  return (
    <Dialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) setLink(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Connect to a server")}</DialogTitle>
        </DialogHeader>
        {link ? (
          <div className="px-6 pb-6">
            <DesktopServerForm key={link} initialAddress={link} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
