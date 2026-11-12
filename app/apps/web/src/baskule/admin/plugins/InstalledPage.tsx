// baskule: Admin → Plugins → Installed: the plugins this organization added, whether each is
// ready, who can use it and how many people signed in.
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { Button } from "../../../components/ui/button";
import { useTranslation } from "../../../i18n";
import { pluginsApi } from "../../plugins/api";
import { PluginLogo } from "../../plugins/PluginLogo";
import { pluginSite } from "../../plugins/presentation";
import { useApiResource } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";
import { groupsApi } from "../people/groups";
import { ResourceState } from "../ResourceState";
import { accessSummary, StatusBadge } from "./parts";

const loadInstalled = () => Promise.all([pluginsApi.installed(), groupsApi.list().catch(() => [])]);

export function InstalledPage() {
  const t = useTranslation();
  const data = useApiResource(loadInstalled);
  const [list, groups] = data.data ?? [null, null];
  const plugins = list?.plugins ?? [];
  return (
    <PageSection
      title={list ? t("Installed ({{count}})", { count: plugins.length }) : t("Installed")}
      action={
        <Button
          size="sm"
          variant="outline"
          render={
            <Link to="/admin/$section/$page" params={{ section: "plugins", page: "browse" }} />
          }
        >
          {t("Browse plugins")}
        </Button>
      }
    >
      {list && plugins.length === 0 ? (
        <PageMessage>{t("No plugins yet. Browse the catalog to add one.")}</PageMessage>
      ) : (
        <ResourceState
          error={data.error}
          loading={data.loading}
          empty={plugins.length === 0}
          emptyText=""
        />
      )}
      {plugins.map((plugin) => {
        const params = { section: "plugins", page: "installed", item: plugin.id };
        const signedIn = Math.max(0, ...plugin.servers.map((server) => server.connectedMembers));
        return (
          <PageRow
            key={plugin.id}
            muted={plugin.status === "paused"}
            leading={
              <PluginLogo
                name={plugin.displayName}
                logo={plugin.logo}
                site={pluginSite({ homepage: plugin.homepage })}
              />
            }
            trailing={
              <>
                <StatusBadge status={plugin.status} />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("Open {{name}}", { name: plugin.displayName })}
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
              className="truncate rounded-sm text-sm font-medium text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {plugin.displayName}
            </Link>
            <span className="truncate text-xs text-muted-foreground">
              {accessSummary(plugin.access, groups, t)}
              {signedIn > 0
                ? ` · ${t("{{count}} person signed in", {
                    count: signedIn,
                    defaultValue_other: "{{count}} people signed in",
                  })}`
                : null}
            </span>
          </PageRow>
        );
      })}
    </PageSection>
  );
}
