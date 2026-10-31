import { useTranslation } from "../../../i18n";
// baskule: Plugins → Installed: every plugin the admin added, on or off, and who may use it.
import type { Group, Plugin } from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { notifyPluginError, pluginsApi } from "../../plugins/api";
import { PluginIcon } from "../../plugins/PluginParts";
import { credentialLabel, groupName, kindLabel } from "../../plugins/presentation";
import { useApiResource } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

const loadInventory = () =>
  Promise.all([pluginsApi.installed(), pluginsApi.groups()]).then(([plugins, groups]) => ({
    plugins,
    groups,
  }));

/** The credential modes a plugin's connectors need, without "none". */
export function credentialSummary(plugin: Plugin): string | null {
  const modes = [...new Set(plugin.servers.map((server) => server.credential))].filter(
    (mode) => mode !== "none",
  );
  return modes.length > 0 ? modes.map(credentialLabel).join(", ") : null;
}

export function grantedGroups(plugin: Plugin, groups: ReadonlyArray<Group>) {
  return groups.filter((group) => group.plugins.includes(plugin.id));
}

export function InstalledPage() {
  const t = useTranslation();
  const data = useApiResource(loadInventory);
  const [busyId, setBusyId] = useState<string | null>(null);
  const plugins = data.data?.plugins ?? [];
  const groups = data.data?.groups ?? [];

  const setEnabled = async (plugin: Plugin, enabled: boolean) => {
    setBusyId(plugin.id);
    return (async () => {
      await pluginsApi.update(plugin.id, { enabled });
      await data.reload();
    })()
      .catch((cause: unknown) => {
        notifyPluginError(
          enabled
            ? t("Could not turn on {{name}}", { name: plugin.name })
            : t("Could not turn off {{name}}", { name: plugin.name }),
          cause,
        );
      })
      .finally(() => {
        setBusyId(null);
      });
  };

  const catalogLink = (
    <Button
      size="sm"
      variant="outline"
      render={<Link to="/admin/$section/$page" params={{ section: "plugins", page: "catalog" }} />}
    >
      <SearchIcon />
      {t("Find plugins")}
    </Button>
  );

  return (
    <PageSection
      title={data.data ? t("Plugins ({{count}})", { count: plugins.length }) : t("Plugins")}
      description={t(
        "A plugin works for the people of the groups you choose, once it is on and they turn it on for themselves.",
      )}
      action={plugins.length > 0 ? catalogLink : null}
    >
      {data.data && plugins.length === 0 ? (
        <PageMessage>
          <span className="flex flex-col items-center gap-3">
            {t("No plugins yet. Nothing is installed until you add it.")}
            {catalogLink}
          </span>
        </PageMessage>
      ) : (
        <ResourceState
          error={data.error}
          loading={data.loading}
          empty={plugins.length === 0}
          emptyText=""
        />
      )}
      {plugins.map((plugin) => {
        const allowed = grantedGroups(plugin, groups);
        const credentials = credentialSummary(plugin);
        const params = { section: "plugins", page: "installed", item: plugin.id };
        return (
          <PageRow
            key={plugin.id}
            muted={!plugin.enabled}
            leading={<PluginIcon kind={plugin.kind} icon={plugin.icon} />}
            trailing={
              <>
                {busyId === plugin.id ? <Spinner size="sm" tone="muted" /> : null}
                <Switch
                  aria-label={t("{{name}} is on", { name: plugin.name })}
                  checked={plugin.enabled}
                  disabled={busyId === plugin.id}
                  onCheckedChange={(checked) => void setEnabled(plugin, checked)}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("Open {{name}}", { name: plugin.name })}
                  render={<Link to="/admin/$section/$page/$item" params={params} />}
                >
                  <ChevronRightIcon />
                </Button>
              </>
            }
          >
            <Link
              to="/admin/$section/$page/$item"
              params={params}
              className="truncate rounded-sm text-sm text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {plugin.name}
            </Link>
            <span className="truncate text-xs text-muted-foreground">
              {kindLabel(plugin.kind)}
              {" · "}
              {allowed.length === 0 ? (
                <span className="text-warning-foreground">{t("No group can use it yet")}</span>
              ) : (
                allowed.map(groupName).join(", ")
              )}
              {credentials ? <span className="max-sm:hidden"> · {credentials}</span> : null}
            </span>
          </PageRow>
        );
      })}
    </PageSection>
  );
}
