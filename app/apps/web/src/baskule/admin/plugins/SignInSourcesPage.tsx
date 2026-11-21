import { useMessages, msg } from "gt-react";
// baskule: Admin → Plugins → Sign-in and sources: the OAuth clients registered per service, the
// app platforms (Composio, Pipedream) connected with the organization's own account, and the
// plugin registries the catalog reads.
import {
  PLUGIN_REGISTRIES,
  type Catalog,
  type CatalogSource,
  type OAuthClientSetup,
  type ProviderId,
  type ProviderInput,
  type ProviderSettings,
  type RegistryId,
} from "@t3tools/contracts/baskule-plugins";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";

import { notifyPluginError, pluginErrorText, pluginsApi } from "../../plugins/api";
import { PluginLogo } from "../../plugins/PluginLogo";
import { providerName, sourceName } from "../../plugins/presentation";
import { confirmAction, FormField, notifySuccess, useApiResource } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";
import { SignInSetup } from "./SignInSetup";
import { signInGuide } from "./signInGuides";

const REGISTRY_SITES: Record<RegistryId, string> = {
  anthropic: "https://anthropic.com",
  "anthropic-work": "https://anthropic.com",
  cursor: "https://cursor.com",
  xai: "https://x.ai",
};
const REGISTRY_REPOS: Record<RegistryId, string> = {
  anthropic: "github.com/anthropics/claude-plugins-official",
  "anthropic-work": "github.com/anthropics/knowledge-work-plugins",
  cursor: "github.com/cursor/plugins",
  xai: "github.com/xai-org/plugin-marketplace",
};

const loadSources = () => Promise.all([pluginsApi.installed(), pluginsApi.catalog()]);

export function SignInSourcesPage() {
  const t = useMessages();
  const data = useApiResource(loadSources);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  if (!data.data) {
    return <ResourceState error={data.error} loading={data.loading} empty emptyText="" />;
  }
  const [list, loaded] = data.data;
  const current = catalog ?? loaded;
  const failure = (source: CatalogSource) =>
    current.unavailable.find((entry) => entry.source === source)?.message ?? null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      setCatalog(await pluginsApi.catalog(true));
    } catch (cause) {
      notifyPluginError(t(msg("Could not refresh the catalog")), cause);
    }
    setRefreshing(false);
  };

  return (
    <>
      <OAuthClients clients={list.oauthClients} onSaved={() => data.reload()} />
      <Platforms
        settings={list.providers}
        failure={failure}
        onChanged={async () => {
          setCatalog(null);
          await data.reload();
        }}
      />
      <PageSection
        title={t(msg("Plugin registries"))}
        description={
          current.refreshedAt
            ? t(msg("Checked {time}. Baskule checks them again every hour."), {
                time: new Date(current.refreshedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })
            : t(msg("Baskule checks them every hour."))
        }
        action={
          <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? <Spinner size="sm" /> : <RefreshCwIcon />}
            {t(msg("Refresh"))}
          </Button>
        }
      >
        {PLUGIN_REGISTRIES.map((registry) => {
          const message = failure(registry);
          return (
            <PageRow
              key={registry}
              leading={
                <PluginLogo
                  name={sourceName(registry)}
                  logo={null}
                  site={REGISTRY_SITES[registry]}
                />
              }
              trailing={
                message ? (
                  <Badge variant="error">{t(msg("Not loaded"))}</Badge>
                ) : (
                  <Badge variant="success">{t(msg("Up to date"))}</Badge>
                )
              }
            >
              <span className="truncate text-sm font-medium text-foreground">
                {sourceName(registry)}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {message ?? REGISTRY_REPOS[registry]}
              </span>
            </PageRow>
          );
        })}
      </PageSection>
    </>
  );
}

function OAuthClients({
  clients,
  onSaved,
}: {
  readonly clients: ReadonlyArray<OAuthClientSetup>;
  readonly onSaved: () => Promise<void>;
}) {
  const t = useMessages();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (issuer: string, vendor: string) => {
    const confirmed = await confirmAction(
      t(
        msg(
          "Remove the OAuth client for {vendor}?\nPeople signed in through it must sign in again once you add a new one.",
        ),
        { vendor },
      ),
      "destructive",
    );
    if (!confirmed) return;
    setBusy(issuer);
    try {
      await pluginsApi.removeOAuthClient(issuer);
      setOpen(null);
      await onSaved();
    } catch (cause) {
      notifyPluginError(
        t(msg("Could not remove the OAuth client for {vendor}"), { vendor }),
        cause,
      );
    }
    setBusy(null);
  };

  return (
    <PageSection
      title={t(msg("Sign-in to services"))}
      description={t(
        msg(
          "Some services don't let Baskule register itself. Register one OAuth client per service; every plugin that signs in there uses it.",
        ),
      )}
    >
      {clients.length === 0 ? (
        <PageMessage>{t(msg("No plugin needs its own OAuth client yet."))}</PageMessage>
      ) : null}
      {clients.map((client) => {
        const guide = signInGuide(client.issuer);
        const expanded = open === client.issuer;
        return (
          <div key={client.issuer} className="flex flex-col">
            <PageRow
              leading={<PluginLogo name={guide.vendor} logo={null} site={client.issuer} />}
              trailing={
                <>
                  {client.configured ? null : (
                    <span className="hidden sm:inline-flex">
                      <Badge variant="warning">{t(msg("Needs a client"))}</Badge>
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={expanded}
                    aria-label={
                      client.configured
                        ? t(msg("Edit sign-in to {vendor}"), { vendor: guide.vendor })
                        : t(msg("Set up sign-in to {vendor}"), { vendor: guide.vendor })
                    }
                    onClick={() => setOpen(expanded ? null : client.issuer)}
                  >
                    {expanded
                      ? t(msg("Close"))
                      : client.configured
                        ? t(msg("Edit"))
                        : t(msg("Set up"))}
                  </Button>
                  {client.configured ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === client.issuer}
                      aria-label={t(msg("Remove sign-in to {vendor}"), { vendor: guide.vendor })}
                      onClick={() => void remove(client.issuer, guide.vendor)}
                    >
                      {t(msg("Remove"))}
                    </Button>
                  ) : null}
                </>
              }
            >
              <span className="truncate text-sm font-medium text-foreground">{guide.vendor}</span>
              <span className="truncate text-xs text-muted-foreground">
                {client.usedBy.length > 0
                  ? t(msg("Used by {plugins}"), {
                      plugins: client.usedBy.map((entry) => entry.displayName).join(", "),
                    })
                  : client.issuer}
              </span>
              {client.configured ? null : (
                <span className="mt-1 sm:hidden">
                  <Badge variant="warning">{t(msg("Needs a client"))}</Badge>
                </span>
              )}
            </PageRow>
            {expanded ? (
              <div className="px-3 pb-3 sm:px-4 sm:pb-4">
                <SignInSetup
                  client={client}
                  onSaved={async () => {
                    setOpen(null);
                    await onSaved();
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </PageSection>
  );
}

const PLATFORM_SITES: Record<ProviderId, string> = {
  composio: "https://composio.dev",
  pipedream: "https://pipedream.com",
};

function Platforms({
  settings,
  failure,
  onChanged,
}: {
  readonly settings: ProviderSettings;
  readonly failure: (source: CatalogSource) => string | null;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useMessages();
  const [open, setOpen] = useState<ProviderId | null>(null);
  const [busy, setBusy] = useState<ProviderId | null>(null);

  const remove = async (provider: ProviderId) => {
    const confirmed = await confirmAction(
      t(
        msg(
          "Disconnect {provider}?\nIts apps leave the catalog, and plugins added from it stop working until you connect it again.",
        ),
        { provider: providerName(provider) },
      ),
      "destructive",
    );
    if (!confirmed) return;
    setBusy(provider);
    try {
      await pluginsApi.removeProvider(provider);
      await onChanged();
    } catch (cause) {
      notifyPluginError(
        t(msg("Could not disconnect {provider}"), { provider: providerName(provider) }),
        cause,
      );
    }
    setBusy(null);
  };

  return (
    <PageSection
      title={t(msg("App platforms"))}
      description={t(
        msg(
          "Optional. Connect your organization's Composio or Pipedream account to list their apps; each person then connects their own account on the platform's page.",
        ),
      )}
    >
      {(["composio", "pipedream"] as const).map((provider) => {
        const configured = settings[provider].configured;
        const pipedream = settings.pipedream;
        const message = configured ? failure(provider) : null;
        const expanded = open === provider;
        return (
          <div key={provider} className="flex flex-col">
            <PageRow
              leading={
                <PluginLogo
                  name={providerName(provider)}
                  logo={null}
                  site={PLATFORM_SITES[provider]}
                />
              }
              trailing={
                <>
                  {configured ? (
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      disabled={busy !== null}
                      onClick={() => void remove(provider)}
                    >
                      {busy === provider ? <Spinner size="sm" /> : null}
                      {t(msg("Disconnect"))}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : provider)}
                    >
                      {expanded ? t(msg("Close")) : t(msg("Connect"))}
                    </Button>
                  )}
                </>
              }
            >
              <span className="truncate text-sm font-medium text-foreground">
                {providerName(provider)}
              </span>
              {message ? (
                <span className="text-xs text-destructive-foreground">
                  {t(msg("Its apps could not be loaded: {message}"), { message })}
                </span>
              ) : configured ? (
                <span className="truncate text-xs text-success-foreground">
                  {provider === "pipedream"
                    ? t(msg("Connected · project {project}, {environment}"), {
                        project: pipedream.projectId ?? "",
                        environment:
                          pipedream.environment === "development"
                            ? t(msg("development"))
                            : t(msg("production")),
                      })
                    : t(msg("Connected"))}
                </span>
              ) : (
                <span className="truncate text-xs text-muted-foreground">
                  {provider === "composio"
                    ? t(msg("Hosted apps with Composio's sign-in"))
                    : t(msg("Hosted apps with Pipedream Connect"))}
                </span>
              )}
            </PageRow>
            {expanded && !configured ? (
              <div className="px-3 pb-3 sm:px-4 sm:pb-4">
                <PlatformForm
                  provider={provider}
                  onSaved={async () => {
                    setOpen(null);
                    await onChanged();
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </PageSection>
  );
}

function PlatformForm({
  provider,
  onSaved,
}: {
  readonly provider: ProviderId;
  readonly onSaved: () => Promise<void>;
}) {
  const t = useMessages();
  const [fields, setFields] = useState({
    apiKey: "",
    clientId: "",
    clientSecret: "",
    projectId: "",
    environment: "production" as "production" | "development",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input: ProviderInput | null =
    provider === "composio"
      ? fields.apiKey.trim()
        ? { provider, apiKey: fields.apiKey.trim() }
        : null
      : fields.clientId.trim() && fields.clientSecret.trim() && fields.projectId.trim()
        ? {
            provider,
            clientId: fields.clientId.trim(),
            clientSecret: fields.clientSecret.trim(),
            projectId: fields.projectId.trim(),
            environment: fields.environment,
          }
        : null;
  const field =
    (key: "apiKey" | "clientId" | "clientSecret" | "projectId") =>
    (event: { readonly currentTarget: HTMLInputElement }) =>
      setFields({ ...fields, [key]: event.currentTarget.value });

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-border/60 bg-background p-3 sm:p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!input || saving) return;
        setSaving(true);
        setError(null);
        pluginsApi.saveProvider(input).then(
          async () => {
            notifySuccess(t(msg("{provider} is connected"), { provider: providerName(provider) }));
            await onSaved();
          },
          (cause: unknown) => {
            setSaving(false);
            setError(pluginErrorText(cause, t(msg("Baskule couldn't connect to the platform."))));
          },
        );
      }}
    >
      {provider === "composio" ? (
        <FormField
          label={t(msg("API key"))}
          type="password"
          autoComplete="new-password"
          hint={t(msg("In Composio, open your project's settings and create an API key."))}
          value={fields.apiKey}
          onChange={field("apiKey")}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t(msg("Client ID"))}
            autoComplete="off"
            value={fields.clientId}
            onChange={field("clientId")}
          />
          <FormField
            label={t(msg("Client secret"))}
            type="password"
            autoComplete="new-password"
            value={fields.clientSecret}
            onChange={field("clientSecret")}
          />
          <FormField
            label={t(msg("Project ID"))}
            autoComplete="off"
            placeholder="proj_…"
            value={fields.projectId}
            onChange={field("projectId")}
          />
          <div className="flex flex-col gap-1.5">
            <Label render={<span />}>{t(msg("Environment"))}</Label>
            <Select
              value={fields.environment}
              onValueChange={(environment) =>
                setFields({ ...fields, environment: environment as "production" | "development" })
              }
            >
              <SelectTrigger aria-label={t(msg("Environment"))}>
                <SelectValue>
                  {(value: string) =>
                    value === "development" ? t(msg("Development")) : t(msg("Production"))
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="production">{t(msg("Production"))}</SelectItem>
                <SelectItem value="development">{t(msg("Development"))}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={!input || saving}>
          {saving ? <Spinner size="sm" /> : null}
          {t(msg("Connect {provider}"), { provider: providerName(provider) })}
        </Button>
      </div>
    </form>
  );
}
