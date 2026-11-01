// baskule: Plugins → Installed: every plugin the admin added, whether it is paused or needs setup,
// and who may use it; above them, what the mounted plugins folder couldn't use.
import type { Group, Plugin, PluginFolder } from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, SearchIcon } from "lucide-react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { pluginsApi } from "../../plugins/api";
import { PluginIcon } from "../../plugins/PluginParts";
import { contentsKind, contentsLabel, groupName } from "../../plugins/presentation";
import { useApiResource } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

const loadInventory = () =>
  Promise.all([pluginsApi.inventory(), pluginsApi.groups()]).then(
    ([{ plugins, folder }, groups]) => ({
      plugins,
      folder,
      groups,
    }),
  );

export function grantedGroups(plugin: Plugin, groups: ReadonlyArray<Group>) {
  return groups.filter((group) => group.plugins.includes(plugin.id));
}

export function InstalledPage() {
  const t = useTranslation();
  const data = useApiResource(loadInventory);
  const plugins = data.data?.plugins ?? [];
  const groups = data.data?.groups ?? [];

  const catalogLink = (
    <Button
      size="sm"
      variant="outline"
      render={<Link to="/admin/$section/$page" params={{ section: "plugins", page: "catalog" }} />}
    >
      <SearchIcon />
      {t("Browse the catalog")}
    </Button>
  );

  return (
    <>
      {data.data?.folder ? <FolderProblems folder={data.data.folder} /> : null}
      <PageSection
        title={data.data ? t("Plugins ({{count}})", { count: plugins.length }) : t("Plugins")}
        description={t(
          "A plugin works for the people of the groups you choose, unless you pause it.",
        )}
        action={plugins.length > 0 ? catalogLink : null}
      >
        {data.data && plugins.length === 0 ? (
          <PageMessage>
            <span className="flex flex-col items-center gap-3">
              {t("No plugins yet. Add one from the catalog.")}
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
          const params = { section: "plugins", page: "installed", item: plugin.id };
          return (
            <PageRow
              key={plugin.id}
              muted={!plugin.enabled}
              leading={<PluginIcon contents={contentsKind(plugin)} icon={plugin.icon} />}
              trailing={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("Open {{name}}", { name: plugin.name })}
                  render={<Link to="/admin/$section/$page/$item" params={params} />}
                >
                  <ChevronRightIcon />
                </Button>
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
                {!plugin.enabled ? (
                  t("Paused")
                ) : allowed.length === 0 ? (
                  <span className="text-warning-foreground">{t("No group can use it yet")}</span>
                ) : plugin.setup.some((entry) => !entry.done) ? (
                  <span className="text-warning-foreground">{t("Needs setup")}</span>
                ) : (
                  allowed.map(groupName).join(", ")
                )}
                {" · "}
                {contentsLabel(contentsKind(plugin))}
              </span>
              {plugin.source.type === "folder" ? (
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {t("From the plugins folder")} ·{" "}
                  <span className="font-mono">{plugin.source.path}</span>
                </span>
              ) : null}
            </PageRow>
          );
        })}
      </PageSection>
    </>
  );
}

function FolderProblems({ folder }: { readonly folder: PluginFolder }) {
  const t = useTranslation();
  if (folder.problems.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>{t("Some of the plugins folder couldn't be used")}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {folder.problems.map((problem) => (
            <li key={`${problem.path}:${problem.message}`} className="[overflow-wrap:anywhere]">
              <span className="font-mono text-xs">{problem.path}</span> · {problem.message}
            </li>
          ))}
        </ul>
        <p>{t("Fix them in the folder, then restart Baskule.")}</p>
      </AlertDescription>
    </Alert>
  );
}
