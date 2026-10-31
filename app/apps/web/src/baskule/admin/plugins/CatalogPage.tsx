// baskule: Plugins → Catalog: search the registries live, add a result, or add your own plugin.
// Adding asks who can use it first; the review dialog then shows what it contains.
import type {
  Group,
  Plugin,
  PluginSearchResponse,
  PluginSearchResult,
} from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../../components/ui/input-group";
import { Spinner } from "../../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { notifyPluginError, pluginErrorText, pluginsApi } from "../../plugins/api";
import {
  PluginGroupsField,
  PluginIcon,
  PluginTitle,
  useGroupChoice,
} from "../../plugins/PluginParts";
import { contentsLabel, registryLabel, type PluginContentsKind } from "../../plugins/presentation";
import { useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";
import { AddOwnPluginDialog } from "./AddOwnPluginDialog";
import { PluginReviewDialog, type AddedPlugin } from "./PluginReviewDialog";

type SearchKind = PluginSearchResult["kind"];
type KindFilter = SearchKind | "all";

/** Registry results name their kind; installed plugins derive it from what they contain. */
const SEARCH_CONTENTS: Record<SearchKind, PluginContentsKind> = {
  mcp: "tools",
  skill: "skills",
  bundle: "both",
};
const SEARCH_KINDS = Object.keys(SEARCH_CONTENTS) as SearchKind[];

const loadInstalled = () => pluginsApi.installed();
const loadGroups = () => pluginsApi.groups();
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
  const groups = useApiResource(loadGroups);
  const [choosing, setChoosing] = useState<PluginSearchResult | null>(null);
  const [review, setReview] = useState<AddedPlugin | null>(null);
  const [addingOwn, setAddingOwn] = useState(false);

  const added = (plugin: Plugin, chosen: ReadonlyArray<string>) => {
    setReview({
      plugin,
      groups: (groups.data ?? []).filter((group) => chosen.includes(group.id)),
    });
    void installed.reload();
  };

  const installedFor = (result: PluginSearchResult) =>
    installed.data?.find(
      (plugin) =>
        plugin.source.type === "registry" &&
        plugin.source.registry === result.source.registry &&
        plugin.source.id === result.id,
    );

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
            {SEARCH_KINDS.map((entry) => (
              <Toggle key={entry} value={entry}>
                {contentsLabel(SEARCH_CONTENTS[entry])}
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
          "Nothing here is checked by Baskule. When you add a plugin, you choose who can use it.",
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
              leading={<PluginIcon contents={SEARCH_CONTENTS[result.kind]} />}
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
                    aria-label={t("Add {{name}}", { name: result.name })}
                    onClick={() => setChoosing(result)}
                  >
                    <PlusIcon />
                    {t("Add")}
                  </Button>
                )
              }
            >
              <PluginTitle
                name={result.name}
                contents={SEARCH_CONTENTS[result.kind]}
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

      <AddResultDialog
        result={choosing}
        groups={groups.data}
        groupsError={groups.error}
        onClose={() => setChoosing(null)}
        onAdded={(plugin, chosen) => {
          setChoosing(null);
          added(plugin, chosen);
        }}
      />
      <AddOwnPluginDialog
        open={addingOwn}
        onOpenChange={setAddingOwn}
        groups={groups.data}
        groupsError={groups.error}
        onAdded={(plugin, chosen) => {
          setAddingOwn(false);
          added(plugin, chosen);
        }}
      />
      <PluginReviewDialog
        added={review}
        onClose={() => setReview(null)}
        onRemoved={() => {
          setReview(null);
          void installed.reload();
        }}
      />
    </>
  );
}

/** Who can use a registry result, chosen before it is added. */
function AddResultDialog({
  result,
  groups,
  groupsError,
  onClose,
  onAdded,
}: {
  readonly result: PluginSearchResult | null;
  readonly groups: ReadonlyArray<Group> | null;
  readonly groupsError: string | null;
  readonly onClose: () => void;
  readonly onAdded: (plugin: Plugin, groups: ReadonlyArray<string>) => void;
}) {
  const t = useTranslation();
  // Keep the last result while the dialog animates out.
  const [shown, setShown] = useState(result);
  if (result && result !== shown) setShown(result);
  const chosen = useGroupChoice(groups);
  const [adding, setAdding] = useState(false);

  const close = () => {
    chosen.reset();
    onClose();
  };

  const add = async (entry: PluginSearchResult) => {
    setAdding(true);
    return (async () => {
      const groupIds = [...chosen.value];
      const plugin = await pluginsApi.install({ source: entry.source, groups: groupIds });
      chosen.reset();
      onAdded(plugin, groupIds);
    })()
      .catch((cause: unknown) => {
        notifyPluginError(t("Could not add {{name}}", { name: entry.name }), cause);
      })
      .finally(() => {
        setAdding(false);
      });
  };

  return (
    <Dialog open={result !== null} onOpenChange={(open) => !open && !adding && close()}>
      <DialogPopup className="sm:max-w-md">
        {shown ? (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (groups && !adding) void add(shown);
            }}
          >
            <DialogHeader>
              <div className="flex items-center gap-3">
                <PluginIcon contents={SEARCH_CONTENTS[shown.kind]} />
                <DialogTitle>{t("Add {{name}}", { name: shown.name })}</DialogTitle>
              </div>
              {shown.description ? (
                <DialogDescription>{shown.description}</DialogDescription>
              ) : null}
            </DialogHeader>
            <DialogPanel>
              <PluginGroupsField
                groups={groups}
                error={groupsError}
                value={chosen.value}
                onChange={chosen.onChange}
                disabled={adding}
              />
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={adding} onClick={close}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={!groups || adding}>
                {adding ? <Spinner size="sm" /> : null}
                {t("Add plugin")}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
