import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { useTranslation } from "../../i18n";
import { DesktopServerForm } from "./DesktopServerForm";

/** A one-time OS connection link is shown for approval before changing installations. */
export function BaskuleDesktopLinks() {
  const t = useTranslation();
  const [link, setLink] = useState<string | null>(null);
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
