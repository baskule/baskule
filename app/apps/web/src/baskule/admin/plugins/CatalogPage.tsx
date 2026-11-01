// baskule: Plugins → Catalog: the services Baskule offers, by area, as a directory to scan. Each entry
// shows what it does and one state; what a service needs and its documentation open with the entry.
import {
  CATALOG,
  catalogVendor,
  type CatalogArea,
  type CatalogService,
} from "@t3tools/contracts/baskule-catalog";
import type { AdminPlugin, Group } from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  ClockIcon,
  PlusIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { msg, useTranslation } from "../../../i18n";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
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
import { cn } from "../../../lib/utils";
import { notifyPluginError, pluginsApi } from "../../plugins/api";
import {
  DocsLink,
  PluginGroupsField,
  PluginIcon,
  ServiceNeeds,
  useGroupChoice,
} from "../../plugins/PluginParts";
import { notifySuccess, useApiResource } from "../../ui";

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

/** A service before it is added: whether the admin has anything to set up once it is. A vendor's app is
 * shared by its services, so one saved for another of them counts. */
function needsVendorSetup(service: CatalogService, configured: ReadonlySet<string>): boolean {
  const signIn = catalogVendor(service.vendor)?.signIn;
  if (signIn?.type === "key") return true;
  return (
    signIn?.type === "account" && signIn.client === "static" && !configured.has(service.vendor)
  );
}

type ServiceState = "ready" | "setup" | "unavailable" | "added" | "paused" | "unfinished";

function serviceState(
  service: CatalogService,
  installed: AdminPlugin | undefined,
  configured: ReadonlySet<string>,
): ServiceState {
  if (service.notYet) return "unavailable";
  if (!installed) return needsVendorSetup(service, configured) ? "setup" : "ready";
  if (!installed.enabled) return "paused";
  return installed.setup.some((entry) => !entry.done) ? "unfinished" : "added";
}

const STATES = {
  ready: { text: msg("Ready in one click"), icon: ZapIcon, tone: "text-muted-foreground" },
  setup: { text: msg("Needs setup"), icon: WrenchIcon, tone: "text-muted-foreground" },
  unavailable: { text: msg("Not available yet"), icon: ClockIcon, tone: "text-muted-foreground" },
  added: { text: msg("Added"), icon: CircleCheckIcon, tone: "text-success-foreground" },
  paused: { text: msg("Paused"), icon: CirclePauseIcon, tone: "text-muted-foreground" },
  unfinished: { text: msg("Needs setup"), icon: CircleAlertIcon, tone: "text-warning-foreground" },
} as const satisfies Record<ServiceState, unknown>;

const loadInstalled = () => pluginsApi.installed();
const loadGroups = () => pluginsApi.groups();

export function CatalogPage() {
  const t = useTranslation();
  const installed = useApiResource(loadInstalled);
  const groups = useApiResource(loadGroups);
  const [opened, setOpened] = useState<CatalogService | null>(null);
  const configured = new Set(
    installed.data?.filter((plugin) => plugin.vendorConfigured).map((plugin) => plugin.vendor),
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
        <p className="min-w-48 flex-1 text-sm text-muted-foreground">
          {t("Every plugin here is run by its service and checked by Baskule.")}
        </p>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/admin/$section/$page" params={{ section: "plugins", page: "add" }} />}
        >
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
          <CatalogAreaSection key={area} title={t(AREAS[area])}>
            {services.map((service) => (
              <CatalogEntry
                key={service.id}
                service={service}
                installed={installed.data?.find((plugin) => plugin.id === service.id)}
                configured={configured}
                loading={!installed.data}
                onOpen={() => setOpened(service)}
              />
            ))}
          </CatalogAreaSection>
        ) : null;
      })}

      <ServiceDialog
        service={opened}
        configured={configured}
        groups={groups.data}
        groupsError={groups.error}
        onClose={() => setOpened(null)}
        onAdded={(name) => {
          setOpened(null);
          notifySuccess(t("{{name}} was added", { name }));
          void installed.reload();
        }}
      />
    </>
  );
}

/** One list on a phone; a grid of cards once there is room for two. */
function CatalogAreaSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="@container flex flex-col gap-2.5">
      <h2 id={id} className="px-3 text-sm font-normal text-foreground/70 sm:px-4">
        {title}
      </h2>
      <ul className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 @2xl:grid @2xl:grid-cols-2 @2xl:gap-2 @2xl:divide-y-0 @2xl:overflow-visible @2xl:rounded-none @2xl:border-0 @2xl:bg-transparent @2xl:shadow-none">
        {children}
      </ul>
    </section>
  );
}

/** The whole entry opens it: an added service's page, otherwise what it needs and Add. */
const OPENER =
  "flex min-w-0 rounded-sm text-start text-sm text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset @2xl:after:rounded-xl";

function CatalogEntry({
  service,
  installed,
  configured,
  loading,
  onOpen,
}: {
  readonly service: CatalogService;
  readonly installed: AdminPlugin | undefined;
  /** Vendors whose shared app is saved. */
  readonly configured: ReadonlySet<string>;
  /** Whether it is added is not known yet. */
  readonly loading: boolean;
  readonly onOpen: () => void;
}) {
  const t = useTranslation();
  const stateId = useId();
  const state = serviceState(service, installed, configured);
  const known = state === "unavailable" || !loading;
  const shown = STATES[state];
  const StateIcon = shown.icon;
  const name = <span className="truncate">{service.name}</span>;

  return (
    <li
      className={cn(
        "relative flex items-start gap-3 px-3 py-3 transition-colors hover:bg-accent/40 sm:px-4 @2xl:rounded-xl @2xl:border @2xl:border-border/60 @2xl:bg-card/40 @2xl:shadow-xs/5",
        state === "unavailable" && "opacity-70",
      )}
    >
      <PluginIcon contents="tools" icon={service.icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {installed ? (
          <Link
            to="/admin/$section/$page/$item"
            params={{ section: "plugins", page: "installed", item: service.id }}
            aria-describedby={stateId}
            className={OPENER}
          >
            {name}
          </Link>
        ) : (
          <button
            type="button"
            aria-describedby={stateId}
            className={OPENER}
            disabled={!known}
            onClick={onOpen}
          >
            {name}
          </button>
        )}
        <span className="line-clamp-2 text-xs text-muted-foreground">{t(service.description)}</span>
        <span
          id={stateId}
          className={cn(
            "flex min-h-5 items-center gap-1.5 pt-0.5 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0",
            shown.tone,
          )}
        >
          {known ? (
            <>
              <StateIcon aria-hidden />
              {t(shown.text)}
            </>
          ) : null}
        </span>
      </div>
      {!known || state === "unavailable" ? null : installed ? (
        <ChevronRightIcon aria-hidden className="mt-2 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <div className="relative z-10 shrink-0">
          <Button
            size="sm"
            variant="outline"
            aria-label={t("Add {{name}}", { name: service.name })}
            onClick={onOpen}
          >
            <PlusIcon />
            {t("Add")}
          </Button>
        </div>
      )}
    </li>
  );
}

/** A service that isn't added yet: what it needs, its documentation, and who can use it once added. */
function ServiceDialog({
  service,
  configured,
  groups,
  groupsError,
  onClose,
  onAdded,
}: {
  readonly service: CatalogService | null;
  readonly configured: ReadonlySet<string>;
  readonly groups: ReadonlyArray<Group> | null;
  readonly groupsError: string | null;
  readonly onClose: () => void;
  readonly onAdded: (name: string) => void;
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
      const plugin = await pluginsApi.create({ catalog: entry.id, groups: [...chosen.value] });
      chosen.reset();
      onAdded(plugin.name);
    })()
      .catch((cause: unknown) => {
        notifyPluginError(t("Could not add {{name}}", { name: entry.name }), cause);
      })
      .finally(() => {
        setAdding(false);
      });
  };

  const addable = shown !== null && !shown.notYet;
  return (
    <Dialog open={service !== null} onOpenChange={(open) => !open && !adding && close()}>
      <DialogPopup className="sm:max-w-md">
        {shown ? (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (addable && groups && !adding) void add(shown);
            }}
          >
            <DialogHeader>
              <div className="flex items-center gap-3">
                <PluginIcon contents="tools" icon={shown.icon} />
                <DialogTitle>
                  {addable ? t("Add {{name}}", { name: shown.name }) : shown.name}
                </DialogTitle>
              </div>
              <DialogDescription>{t(shown.description)}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {shown.notYet ? (
                <Alert variant="info">
                  <AlertTitle>{t("Not available yet")}</AlertTitle>
                  <AlertDescription>{t(shown.notYet)}</AlertDescription>
                </Alert>
              ) : (
                <>
                  {needsVendorSetup(shown, configured) ? (
                    <p className="text-sm text-muted-foreground">
                      {t("After you add it, finish setting it up on its page.")}
                    </p>
                  ) : null}
                  <ServiceNeeds service={shown} />
                </>
              )}
              <DocsLink service={shown} />
              {addable ? (
                <PluginGroupsField
                  groups={groups}
                  error={groupsError}
                  value={chosen.value}
                  onChange={chosen.onChange}
                  disabled={adding}
                />
              ) : null}
            </DialogPanel>
            <DialogFooter>
              {addable ? (
                <>
                  <Button type="button" variant="outline" disabled={adding} onClick={close}>
                    {t("Cancel")}
                  </Button>
                  <Button type="submit" disabled={!groups || adding}>
                    {adding ? <Spinner size="sm" /> : null}
                    {t("Add plugin")}
                  </Button>
                </>
              ) : (
                <Button type="button" variant="outline" onClick={close}>
                  {t("Close")}
                </Button>
              )}
            </DialogFooter>
          </form>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
