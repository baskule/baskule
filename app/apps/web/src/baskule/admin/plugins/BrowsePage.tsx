// baskule: Admin → Plugins → Browse: every plugin the registries and connected app platforms
// offer, by category, with search. Adding one opens its page, where the admin reviews it.
import {
  PLUGIN_CATEGORIES,
  PLUGIN_PROVIDERS,
  type CatalogEntry,
  type PluginCategory,
} from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../../components/ui/menu";
import { Spinner } from "../../../components/ui/spinner";
import { useTranslation } from "../../../i18n";
import { pluginsApi } from "../../plugins/api";
import { PluginLogo } from "../../plugins/PluginLogo";
import {
  categoryLabel,
  pluginSite,
  providerName,
  searchScore,
  sourceName,
} from "../../plugins/presentation";
import { useApiResource } from "../../ui";
import { PageMessage } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

const loadCatalog = () => pluginsApi.catalog();

const SECTION_SIZE = 6;
const PAGE_SIZE = 24;
const PROVIDER_PAGE_SIZE = 60;
const CHIP_COUNT = 6;
type Filter = PluginCategory | "other";

const isProvider = (entry: CatalogEntry) =>
  (PLUGIN_PROVIDERS as ReadonlyArray<string>).includes(entry.source);

export function BrowsePage() {
  const t = useTranslation();
  const data = useApiResource(loadCatalog);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [providerShown, setProviderShown] = useState(PROVIDER_PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const entries = data.data?.entries ?? [];

  const choose = (next: Filter | null) => {
    setFilter(next);
    setShown(PAGE_SIZE);
  };
  const retry = async () => {
    setRefreshing(true);
    try {
      await pluginsApi.catalog(true);
    } catch {
      // The reload below reports the failure.
    }
    await data.reload();
    setRefreshing(false);
  };

  const categories = PLUGIN_CATEGORIES.filter((category) =>
    entries.some((entry) => entry.category === category),
  );
  const uncategorized = entries.filter((entry) => !entry.category && !isProvider(entry));
  const filters: ReadonlyArray<Filter> = [
    ...categories,
    ...(uncategorized.length > 0 ? (["other"] as const) : []),
  ];
  const label = (value: Filter) => (value === "other" ? t("Other") : categoryLabel(value));
  const inFilter = (entry: CatalogEntry) =>
    filter === null ||
    (filter === "other" ? !entry.category && !isProvider(entry) : entry.category === filter);

  const trimmed = query.trim();
  const listed = trimmed
    ? entries
        .map((entry, index) => ({ entry, index, score: searchScore(entry, trimmed) }))
        .filter((match) => match.score > 0 && inFilter(match.entry))
        .toSorted((a, b) => b.score - a.score || a.index - b.index)
        .map((match) => match.entry)
    : entries.filter(inFilter);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        <div className="flex items-center gap-2">
          <Input
            type="search"
            size="lg"
            aria-label={t("Search plugins")}
            placeholder={t("Search plugins")}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setShown(PAGE_SIZE);
            }}
          />
          <AddMenu />
        </div>
        {filters.length >= 2 ? (
          <div
            role="group"
            aria-label={t("Categories")}
            className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
          >
            {[null, ...filters.slice(0, CHIP_COUNT)].map((value) => (
              <Button
                key={value ?? "all"}
                size="sm-pill"
                variant={filter === value ? "default" : "secondary"}
                aria-pressed={filter === value}
                onClick={() => choose(value)}
              >
                {value ? label(value) : t("All")}
              </Button>
            ))}
            {filters.length > CHIP_COUNT ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="sm-pill"
                      variant={
                        filter && !filters.slice(0, CHIP_COUNT).includes(filter)
                          ? "default"
                          : "secondary"
                      }
                    />
                  }
                >
                  {filter && !filters.slice(0, CHIP_COUNT).includes(filter)
                    ? label(filter)
                    : t("More")}
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  {filters.slice(CHIP_COUNT).map((value) => (
                    <MenuItem key={value} onClick={() => choose(value)}>
                      {label(value)}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        ) : null}
      </div>

      {data.data && data.data.unavailable.length > 0 ? (
        <div className="px-3 sm:px-4">
          <Alert variant="warning">
            <AlertDescription>
              {t("Some catalogs could not be loaded: {{sources}}.", {
                sources: data.data.unavailable.map((entry) => sourceName(entry.source)).join(", "),
              })}
            </AlertDescription>
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                disabled={refreshing}
                onClick={() => void retry()}
              >
                {refreshing ? <Spinner size="sm" /> : null}
                {t("Retry")}
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}

      <ResourceState
        error={data.error}
        loading={data.loading}
        empty={entries.length === 0}
        emptyText={t("No plugins are listed. Add one from GitHub or by its server address.")}
      />

      {entries.length === 0 ? null : trimmed || filter ? (
        listed.length === 0 ? (
          <PageMessage>
            {t("No plugins match your search. Add it from GitHub or by its server address.")}
          </PageMessage>
        ) : (
          <section className="flex flex-col gap-2">
            <PluginGrid entries={listed.slice(0, shown)} />
            {listed.length > shown ? (
              <ShowMore onClick={() => setShown((count) => count + PAGE_SIZE)} />
            ) : null}
          </section>
        )
      ) : (
        <>
          <Section
            title={t("Recommended")}
            entries={entries.filter((entry) => entry.recommended).slice(0, SECTION_SIZE)}
          />
          {categories.map((category) => {
            const inCategory = entries.filter((entry) => entry.category === category);
            return (
              <Section
                key={category}
                title={categoryLabel(category)}
                entries={inCategory.slice(0, SECTION_SIZE)}
                onViewAll={inCategory.length > SECTION_SIZE ? () => choose(category) : undefined}
              />
            );
          })}
          <Section
            title={t("More")}
            entries={uncategorized.slice(0, SECTION_SIZE)}
            onViewAll={uncategorized.length > SECTION_SIZE ? () => choose("other") : undefined}
          />
          <ProviderSection
            entries={entries.filter((entry) => !entry.category && isProvider(entry))}
            shown={providerShown}
            onShowMore={() => setProviderShown((count) => count + PROVIDER_PAGE_SIZE)}
          />
        </>
      )}
    </div>
  );
}

function AddMenu() {
  const t = useTranslation();
  const to = "/admin/$section/$page/$item";
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-lg"
            variant="outline"
            aria-label={t("Add a plugin that isn't listed")}
          />
        }
      >
        <PlusIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          render={<Link to={to} params={{ section: "plugins", page: "browse", item: "github" }} />}
        >
          {t("From GitHub")}
        </MenuItem>
        <MenuItem
          render={<Link to={to} params={{ section: "plugins", page: "browse", item: "mcp" }} />}
        >
          {t("MCP server")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function Section({
  title,
  entries,
  onViewAll,
}: {
  readonly title: string;
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly onViewAll?: (() => void) | undefined;
}) {
  const t = useTranslation();
  if (entries.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-4 px-3 sm:px-4">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {onViewAll ? (
          <Button size="sm" variant="ghost-muted" onClick={onViewAll}>
            {t("View all")}
          </Button>
        ) : null}
      </div>
      <PluginGrid entries={entries} />
    </section>
  );
}

function ProviderSection({
  entries,
  shown,
  onShowMore,
}: {
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly shown: number;
  readonly onShowMore: () => void;
}) {
  const t = useTranslation();
  if (entries.length === 0) return null;
  const providers = PLUGIN_PROVIDERS.filter((provider) =>
    entries.some((entry) => entry.source === provider),
  ).map(providerName);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center px-3 sm:px-4">
        <h2 className="text-sm font-medium text-foreground">
          {t("More apps from {{providers}}", { providers: providers.join(" & ") })}
        </h2>
      </div>
      <PluginGrid entries={entries.slice(0, shown)} />
      {entries.length > shown ? <ShowMore onClick={onShowMore} /> : null}
    </section>
  );
}

function ShowMore({ onClick }: { readonly onClick: () => void }) {
  const t = useTranslation();
  return (
    <div className="flex justify-center pt-2">
      <Button size="sm" variant="secondary" onClick={onClick}>
        {t("Show more")}
      </Button>
    </div>
  );
}

function PluginGrid({ entries }: { readonly entries: ReadonlyArray<CatalogEntry> }) {
  return (
    <ul className="grid grid-cols-1 gap-1 md:grid-cols-2">
      {entries.map((entry) => (
        <PluginRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}

function PluginRow({ entry }: { readonly entry: CatalogEntry }) {
  const t = useTranslation();
  const params = entry.installedPluginId
    ? { section: "plugins", page: "installed", item: entry.installedPluginId }
    : { section: "plugins", page: "browse", item: entry.id };
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-xl px-3 py-2 hover:bg-accent/60 has-[a:focus-visible]:bg-accent/60 sm:px-4">
      <Link
        to="/admin/$section/$page/$item"
        params={params}
        className="flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-hidden"
      >
        <PluginLogo name={entry.displayName} logo={entry.logo} site={pluginSite(entry)} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{entry.displayName}</span>
          {entry.description ? (
            <span className="truncate text-xs text-muted-foreground">{entry.description}</span>
          ) : null}
        </span>
      </Link>
      <Button
        size="sm"
        variant="secondary"
        aria-label={
          entry.installedPluginId
            ? t("Open {{name}}", { name: entry.displayName })
            : t("Add {{name}}", { name: entry.displayName })
        }
        render={<Link to="/admin/$section/$page/$item" params={params} tabIndex={-1} />}
      >
        {entry.installedPluginId ? t("Added") : t("Add")}
      </Button>
    </li>
  );
}
