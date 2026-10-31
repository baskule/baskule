// baskule: Plugins → Catalog: the services Baskule offers, by area, or add your own plugin.
// Adding asks who can use it first; the review dialog then shows what it contains.
import {
  CATALOG,
  catalogVendor,
  type CatalogArea,
  type CatalogService,
} from "@t3tools/contracts/baskule-catalog";
import type { AdminPlugin, Group, Plugin } from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { msg, useTranslation } from "../../../i18n";
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
import { Spinner } from "../../../components/ui/spinner";
import { notifyPluginError, pluginsApi } from "../../plugins/api";
import { PluginGroupsField, PluginIcon, useGroupChoice } from "../../plugins/PluginParts";
import { useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { AddOwnPluginDialog } from "./AddOwnPluginDialog";
import { PluginReviewDialog, type AddedPlugin } from "./PluginReviewDialog";

/** Shown in this order. */
const AREAS: Record<CatalogArea, string> = {
  mail_calendar_files: msg("Mail, calendar and files"),
  communication: msg("Communication"),
  knowledge: msg("Knowledge and files"),
  work: msg("Work management"),
  crm: msg("CRM"),
  support: msg("Support"),
  finance: msg("Finance"),
  design: msg("Design"),
  engineering: msg("Engineering"),
};

const loadInstalled = () => pluginsApi.installed();
const loadGroups = () => pluginsApi.groups();

export function CatalogPage() {
  const t = useTranslation();
  const installed = useApiResource(loadInstalled);
  const groups = useApiResource(loadGroups);
  const [choosing, setChoosing] = useState<CatalogService | null>(null);
  const [review, setReview] = useState<AddedPlugin | null>(null);
  const [addingOwn, setAddingOwn] = useState(false);

  const added = (plugin: Plugin, chosen: ReadonlyArray<string>) => {
    setReview({
      plugin,
      groups: (groups.data ?? []).filter((group) => chosen.includes(group.id)),
    });
    void installed.reload();
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {t(
            "Each service's own server, reviewed by Baskule. When you add one, you choose who can use it.",
          )}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAddingOwn(true)}>
          <PlusIcon />
          {t("Add your own")}
        </Button>
      </div>

      {installed.error && !installed.data ? (
        <Alert variant="error">
          <AlertDescription>{installed.error}</AlertDescription>
        </Alert>
      ) : null}

      {(Object.keys(AREAS) as CatalogArea[]).map((area) => {
        const services = CATALOG.filter((service) => service.area === area);
        return services.length > 0 ? (
          <PageSection key={area} title={t(AREAS[area])}>
            {services.map((service) => (
              <CatalogRow
                key={service.id}
                service={service}
                installed={installed.data?.find((plugin) => plugin.id === service.id)}
                loading={!installed.data}
                onAdd={() => setChoosing(service)}
              />
            ))}
          </PageSection>
        ) : null;
      })}

      <AddServiceDialog
        service={choosing}
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

function CatalogRow({
  service,
  installed,
  loading,
  onAdd,
}: {
  readonly service: CatalogService;
  readonly installed: AdminPlugin | undefined;
  /** Whether it is added is not known yet. */
  readonly loading: boolean;
  readonly onAdd: () => void;
}) {
  const t = useTranslation();
  const detail = { section: "plugins", page: "installed", item: service.id };
  const vendor = catalogVendor(service.vendor)?.name ?? service.name;
  const action = service.notYet ? null : installed ? (
    installed.setup.some((entry) => !entry.done) ? (
      <Button
        size="sm"
        variant="warning-outline"
        aria-label={t("Set up {{vendor}} for {{name}}", { vendor, name: service.name })}
        render={<Link to="/admin/$section/$page/$item" params={detail} />}
      >
        {t("Set up {{name}}", { name: vendor })}
      </Button>
    ) : (
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("{{name}} is added: open it", { name: service.name })}
        render={<Link to="/admin/$section/$page/$item" params={detail} />}
      >
        <CheckIcon />
        {t("Added")}
      </Button>
    )
  ) : loading ? null : (
    <Button
      size="sm"
      variant="outline"
      aria-label={t("Add {{name}}", { name: service.name })}
      onClick={onAdd}
    >
      <PlusIcon />
      {t("Add")}
    </Button>
  );

  return (
    <PageRow
      muted={service.notYet !== undefined}
      leading={<PluginIcon contents="tools" icon={service.icon} />}
      trailing={action}
    >
      <span className="truncate text-sm text-foreground">{service.name}</span>
      <span className="text-xs text-muted-foreground">{t(service.description)}</span>
      {service.notYet ? (
        <span className="text-xs text-foreground/80">{t(service.notYet)}</span>
      ) : service.prerequisites.length > 0 ? (
        <ul className="list-disc ps-4 text-xs text-muted-foreground">
          {service.prerequisites.map((prerequisite) => (
            <li key={prerequisite}>{t(prerequisite)}</li>
          ))}
        </ul>
      ) : null}
      <a
        href={service.docs}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={t("{{name}} documentation", { name: service.name })}
        className="inline-flex w-fit items-center gap-1 rounded-sm text-xs text-foreground/80 underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3"
      >
        {t("Documentation")}
        <ExternalLinkIcon aria-hidden />
      </a>
    </PageRow>
  );
}

/** Who can use a catalog service, chosen before it is added. */
function AddServiceDialog({
  service,
  groups,
  groupsError,
  onClose,
  onAdded,
}: {
  readonly service: CatalogService | null;
  readonly groups: ReadonlyArray<Group> | null;
  readonly groupsError: string | null;
  readonly onClose: () => void;
  readonly onAdded: (plugin: Plugin, groups: ReadonlyArray<string>) => void;
}) {
  const t = useTranslation();
  // Keep the last service while the dialog animates out.
  const [shown, setShown] = useState(service);
  if (service && service !== shown) setShown(service);
  const chosen = useGroupChoice(groups);
  const [adding, setAdding] = useState(false);

  const close = () => {
    chosen.reset();
    onClose();
  };

  const add = async (entry: CatalogService) => {
    setAdding(true);
    return (async () => {
      const groupIds = [...chosen.value];
      const plugin = await pluginsApi.install({ catalog: entry.id, groups: groupIds });
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
    <Dialog open={service !== null} onOpenChange={(open) => !open && !adding && close()}>
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
                <PluginIcon contents="tools" icon={shown.icon} />
                <DialogTitle>{t("Add {{name}}", { name: shown.name })}</DialogTitle>
              </div>
              <DialogDescription>{t(shown.description)}</DialogDescription>
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
