// baskule: shown right after a plugin is added. It is stored turned off and granted to no one;
// the admin sees what it contains, then keeps it (and sets it up) or removes it.
import type { Plugin } from "@t3tools/contracts/baskule-plugins";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Spinner } from "../../../components/ui/spinner";
import { notifyPluginError, pluginsApi } from "../../plugins/api";
import { PluginContents, PluginIcon } from "../../plugins/PluginParts";
import { kindLabel, sourceLabel } from "../../plugins/presentation";

export function PluginReviewDialog({
  plugin,
  onClose,
  onRemoved,
}: {
  readonly plugin: Plugin | null;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const t = useTranslation();
  const navigate = useNavigate();
  // Keep the last plugin while the dialog animates out.
  const [shown, setShown] = useState(plugin);
  if (plugin && plugin !== shown) setShown(plugin);
  const [removing, setRemoving] = useState(false);

  return (
    <Dialog open={plugin !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-lg">
        {shown ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <PluginIcon kind={shown.kind} icon={shown.icon} />
                <div className="flex min-w-0 flex-col gap-1">
                  <DialogTitle>{t("{{name}} was added", { name: shown.name })}</DialogTitle>
                  <span className="text-xs text-muted-foreground">
                    {kindLabel(shown.kind)} · {sourceLabel(shown.source)}
                  </span>
                </div>
              </div>
              <DialogDescription>
                {t(
                  "It is turned off, and no one can use it yet. Check what it contains before you set it up.",
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {shown.description ? (
                <p className="text-sm text-foreground/80">{shown.description}</p>
              ) : null}
              <PluginContents plugin={shown} />
            </DialogPanel>
            <DialogFooter>
              <Button
                variant="destructive-outline"
                className="sm:me-auto"
                disabled={removing}
                onClick={() => {
                  setRemoving(true);
                  pluginsApi.remove(shown.id).then(
                    () => {
                      setRemoving(false);
                      onRemoved();
                    },
                    (cause: unknown) => {
                      setRemoving(false);
                      notifyPluginError(
                        t("Could not remove {{name}}", { name: shown.name }),
                        cause,
                      );
                    },
                  );
                }}
              >
                {removing ? <Spinner size="sm" /> : null}
                {t("Remove it")}
              </Button>
              <Button variant="outline" onClick={onClose}>
                {t("Later")}
              </Button>
              <Button
                onClick={() => {
                  onClose();
                  void navigate({
                    to: "/admin/$section/$page/$item",
                    params: { section: "plugins", page: "installed", item: shown.id },
                  });
                }}
              >
                {t("Set it up")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
