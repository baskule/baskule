// baskule: a team space's plugin settings, for its owners and admins: whether plugins that act
// with a member's own account may run here (off by default), and plugins turned off in this space.
import type { Plugin, SpacePluginSettings as Settings } from "@t3tools/contracts/baskule-plugins";
import { useState } from "react";

import { useTranslation } from "../../i18n";
import { Label } from "../../components/ui/label";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { useApiResource } from "../ui";
import { notifyPluginError, pluginsApi } from "./api";
import { PluginIcon } from "./PluginParts";
import { kindLabel } from "./presentation";

export function SpacePluginSettings({
  spaceId,
  isAdmin,
}: {
  readonly spaceId: string;
  /** Admins see every installed plugin; an owner sees the ones they may use themselves. */
  readonly isAdmin: boolean;
}) {
  const t = useTranslation();
  // The parent remounts this per item (`key`), so one loader per mount keeps its identity.
  const [load] = useState(
    () => () =>
      Promise.all([
        pluginsApi.space(spaceId),
        isAdmin ? pluginsApi.installed() : pluginsApi.mine().then((list): Plugin[] => list),
      ]).then(([settings, plugins]) => ({
        settings,
        plugins: plugins.filter((plugin) => plugin.enabled),
      })),
  );
  const data = useApiResource(load);
  const [saving, setSaving] = useState<string | null>(null);

  const save = async (key: string, next: Settings) => {
    setSaving(key);
    return (async () => {
      await pluginsApi.saveSpace(spaceId, next);
      await data.reload();
    })()
      .catch((cause: unknown) => {
        notifyPluginError(t("Could not change the plugins of this space"), cause);
      })
      .finally(() => {
        setSaving(null);
      });
  };

  if (!data.data) {
    return data.error ? null : (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner size="sm" tone="muted" />
        {t("Loading plugins…")}
      </p>
    );
  }
  const { settings, plugins } = data.data;

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t("Plugins")}</Label>
      <ul className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
        <li className="flex items-start gap-3 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm">{t("Allow personal-account plugins")}</span>
            <span className="text-xs text-muted-foreground">
              {t(
                "Plugins that act with a member's own account, such as their mailbox. Everyone here can read what they return.",
              )}
            </span>
          </div>
          {saving === "personal" ? <Spinner size="sm" tone="muted" /> : null}
          <Switch
            aria-label={t("Allow personal-account plugins")}
            checked={settings.personalPluginsAllowed}
            disabled={saving !== null}
            onCheckedChange={(personalPluginsAllowed) =>
              void save("personal", { ...settings, personalPluginsAllowed })
            }
          />
        </li>
        {plugins.map((plugin) => {
          const personal = plugin.servers.some((server) => server.personal);
          const blocked = personal && !plugin.servers.some((server) => !server.personal);
          const used = !settings.disabled.includes(plugin.id);
          return (
            <li key={plugin.id} className="flex items-center gap-3 px-3 py-2">
              <PluginIcon kind={plugin.kind} icon={plugin.icon} className="size-7" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{plugin.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {blocked && !settings.personalPluginsAllowed
                    ? t("Needs personal accounts allowed")
                    : kindLabel(plugin.kind)}
                </span>
              </div>
              {saving === plugin.id ? <Spinner size="sm" tone="muted" /> : null}
              <Switch
                aria-label={t("Use {{name}} in this space", { name: plugin.name })}
                checked={used}
                disabled={saving !== null}
                onCheckedChange={(checked) =>
                  void save(plugin.id, {
                    ...settings,
                    disabled: checked
                      ? settings.disabled.filter((entry) => entry !== plugin.id)
                      : [...settings.disabled, plugin.id],
                  })
                }
              />
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {plugins.length === 0
          ? t("No plugins are turned on in your organization yet.")
          : t("A plugin turned off here is off for every member of this space.")}
      </p>
    </div>
  );
}
