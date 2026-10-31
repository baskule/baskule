// baskule: shown right after a plugin is added for the groups the admin chose. The admin sees what
// it contains and who can use it, then keeps it (and sets it up) or removes it.
import type { Group, Plugin } from "@t3tools/contracts/baskule-plugins";
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
import { contentsKind, contentsLabel, groupName, sourceLabel } from "../../plugins/presentation";

export interface AddedPlugin {
  readonly plugin: Plugin;
  /** The groups chosen when it was added. */
  readonly groups: ReadonlyArray<Group>;
}

export function PluginReviewDialog({
  added,
  onClose,
  onRemoved,
}: {
  readonly added: AddedPlugin | null;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const t = useTranslation();
  const navigate = useNavigate();
  // Keep the last plugin while the dialog animates out.
  const [last, setLast] = useState(added);
  if (added && added !== last) setLast(added);
  const [removing, setRemoving] = useState(false);
  const shown = last?.plugin;

  return (
    <Dialog open={added !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-lg">
        {shown && last ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <PluginIcon contents={contentsKind(shown)} icon={shown.icon} />
                <div className="flex min-w-0 flex-col gap-1">
                  <DialogTitle>{t("{{name}} was added", { name: shown.name })}</DialogTitle>
                  <span className="text-xs text-muted-foreground">
                    {contentsLabel(contentsKind(shown))} · {sourceLabel(shown.source)}
                  </span>
                </div>
              </div>
              <DialogDescription>
                {last.groups.length === 0
                  ? t("No group can use it yet. Open it to choose who can.")
                  : t("It is available to {{groups}}.", {
                      groups: last.groups.map(groupName).join(", "),
                    })}
                {shown.servers.some((server) => server.credential === "organization")
                  ? ` ${t("It needs an organization key before it works: add it on its page.")}`
                  : ""}
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
                {t("Done")}
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
                {t("Open it")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
