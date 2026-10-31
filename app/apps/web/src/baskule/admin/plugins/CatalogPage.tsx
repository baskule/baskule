import { useTranslation } from "../../../i18n";
// baskule: Plugins → Catalog: search the registries live, add a result, or add your own plugin.
// Adding inspects the plugin and stores it turned off; the review dialog shows what it contains.
import type {
  Plugin,
  PluginKind,
  PluginSearchResponse,
  PluginSearchResult,
} from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../../components/ui/input-group";
import { Spinner } from "../../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { notifyPluginError, pluginErrorText, pluginsApi } from "../../plugins/api";
import { PluginIcon, PluginTitle } from "../../plugins/PluginParts";
import { kindFilterLabel, PLUGIN_KINDS, registryLabel } from "../../plugins/presentation";
import { useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";
import { AddOwnPluginDialog } from "./AddOwnPluginDialog";
import { PluginReviewDialog } from "./PluginReviewDialog";

type KindFilter = PluginKind | "all";

const loadInstalled = () => pluginsApi.installed();
const resultKey = (result: PluginSearchResult) => `${result.source.registry}\u0000${result.id}`;

/** The search the page shows: re-run when the submitted words or the kind filter change. */
function useCatalogSearch(query: string, kind: KindFilter) {
  const key = `${kind}\u0000${query}`;
  const [state, setState] = useState<{
    /** Which search produced this answer; another key means a search is running. */
    readonly key: string | null;
    readonly data: PluginSearchResponse | null;
    readonly error: string | null;
  }>({ key: null, data: null, error: null });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel publication of the catalog HTTP response when its query or view changes.
  useEffect(() => {
    let cancelled = false;
    pluginsApi.search(query, kind === "all" ? undefined : kind).then(
      (data) => !cancelled && setState({ key: `${kind}\u0000${query}`, data, error: null }),
      (cause: unknown) =>
        !cancelled &&
        setState({
          key: `${kind}\u0000${query}`,
          data: null,
          error: pluginErrorText(cause, "The catalog could not be searched."),
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [query, kind]);
  return { data: state.data, error: state.error, loading: state.key !== key };
}

export function CatalogPage() {
  const t = useTranslation();
  const [draft, setDraft] = useState("");
  // Each search reaches outside registries (GitHub limits them per hour): search on submit,
  // not on every keystroke.
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const search = useCatalogSearch(query, kind);
  const installed = useApiResource(loadInstalled);
  const [adding, setAdding] = useState<string | null>(null);
  const [review, setReview] = useState<Plugin | null>(null);
  const [addingOwn, setAddingOwn] = useState(false);

  const installedFor = (result: PluginSearchResult) =>
    installed.data?.find(
      (plugin) =>
        plugin.source.type === "registry" &&
        plugin.source.registry === result.source.registry &&
        plugin.source.id === result.id,
    );

  const add = async (result: PluginSearchResult) => {
    setAdding(resultKey(result));
    return (async () => {
      const plugin = await pluginsApi.install({ source: result.source });
      setReview(plugin);
      void installed.reload();
    })()
      .catch((cause: unknown) => {
        notifyPluginError(t("Could not add {{name}}", { name: result.name }), cause);
      })
      .finally(() => {
        setAdding(null);
      });
  };

  const results = search.data?.results ?? [];
  const failed = search.data?.failures.map((failure) => registryLabel(failure.registry)) ?? [];

  return (
    <>
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        <form
          role="search"
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
          }}
        >
          <InputGroup className="flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={t("Search plugins")}
              placeholder={t("Search plugins…")}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </InputGroup>
          <Button type="submit" variant="outline">
            {t("Search")}
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup
            aria-label={t("Kind of plugin")}
            value={[kind]}
            onValueChange={(values) => {
              const next = values[0];
              if (next) setKind(next as KindFilter);
            }}
          >
            <Toggle value="all">{t("All")}</Toggle>
            {PLUGIN_KINDS.map((entry) => (
              <Toggle key={entry} value={entry}>
                {kindFilterLabel(entry)}
              </Toggle>
            ))}
          </ToggleGroup>
          <Button size="sm" variant="outline" onClick={() => setAddingOwn(true)}>
            <PlusIcon />
            {t("Add your own")}
          </Button>
        </div>
      </div>

      {failed.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("{{sources}} didn't answer, so its plugins are missing. Search again in a moment.", {
              sources: failed.join(", "),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      <PageSection
        title={
          query ? t("Results for “{{query}}”", { query }) : t("Everything the registries list")
        }
        description={t(
          "Nothing here is checked by Baskule. Adding a plugin shows what it contains; it stays off until you turn it on.",
        )}
        action={search.loading && results.length > 0 ? <Spinner size="sm" tone="muted" /> : null}
      >
        <ResourceState
          error={search.error}
          loading={search.loading}
          empty={results.length === 0}
          emptyText={
            query
              ? t("Nothing found for “{{query}}”. Try another word, or add your own plugin.", {
                  query,
                })
              : t("The registries listed nothing. Add your own plugin instead.")
          }
        />
        {results.map((result) => {
          const key = resultKey(result);
          const existing = installedFor(result);
          return (
            <PageRow
              key={key}
              leading={<PluginIcon kind={result.kind} />}
              trailing={
                existing ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("{{name}} is added: open it", { name: result.name })}
                    render={
                      <Link
                        to="/admin/$section/$page/$item"
                        params={{ section: "plugins", page: "installed", item: existing.id }}
                      />
                    }
                  >
                    <CheckIcon />
                    {t("Added")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={adding !== null}
                    aria-label={t("Add {{name}}", { name: result.name })}
                    onClick={() => void add(result)}
                  >
                    {adding === key ? <Spinner size="sm" /> : <PlusIcon />}
                    {t("Add")}
                  </Button>
                )
              }
            >
              <PluginTitle
                name={result.name}
                kind={result.kind}
                extra={registryLabel(result.source.registry)}
              />
              {result.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {result.description}
                </span>
              ) : null}
            </PageRow>
          );
        })}
      </PageSection>

      <AddOwnPluginDialog
        open={addingOwn}
        onOpenChange={setAddingOwn}
        onAdded={(plugin) => {
          setAddingOwn(false);
          setReview(plugin);
          void installed.reload();
        }}
      />
      <PluginReviewDialog
        plugin={review}
        onClose={() => setReview(null)}
        onRemoved={() => {
          setReview(null);
          void installed.reload();
        }}
      />
    </>
  );
}
