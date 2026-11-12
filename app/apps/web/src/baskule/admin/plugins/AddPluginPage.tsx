// baskule: a plugin's page before it is added: a catalog entry, a GitHub repository or an MCP
// server by address. Baskule reads it first; the admin chooses who can use it, fills what it
// needs and adds it. Sign-in setup can be finished here or later.
import type {
  CatalogEntry,
  CustomServerInput,
  OAuthClientSetup,
  PluginAccess,
  PluginPreview,
  PluginRef,
  ServerPreview,
  ServerSetup,
} from "@t3tools/contracts/baskule-plugins";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Radio, RadioGroup } from "../../../components/ui/radio-group";
import { Spinner } from "../../../components/ui/spinner";
import { useTranslation } from "../../../i18n";
import { BaskuleApiError } from "../../api";
import { pluginErrorText, pluginsApi } from "../../plugins/api";
import { originHref, pluginSite } from "../../plugins/presentation";
import { FormField, notifySuccess, useApiResource } from "../../ui";
import { PageHeading, PageMessage } from "../../views/BaskulePage";
import { groupsApi } from "../people/groups";
import { ResourceState } from "../ResourceState";
import {
  AccessSection,
  AppsSection,
  NotAdded,
  PluginHeader,
  SkillsSection,
  VariableFields,
  type ServerView,
} from "./parts";
import { oauthClientFor, SignInSetup } from "./SignInSetup";

/** `/admin/plugins/browse/$item`: a catalog entry by id, or the GitHub and MCP server forms. */
export function AddPluginPage({ id }: { readonly id: string }) {
  if (id === "github") return <GithubImport />;
  if (id === "mcp") return <CustomServer />;
  return <CatalogPlugin entryId={id} />;
}

const loadCatalog = () => pluginsApi.catalog();

function CatalogPlugin({ entryId }: { readonly entryId: string }) {
  const t = useTranslation();
  const catalog = useApiResource(loadCatalog);
  if (!catalog.data) {
    return <ResourceState error={catalog.error} loading={catalog.loading} empty emptyText="" />;
  }
  const entry = catalog.data.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return <PageMessage>{t("The catalog no longer lists this plugin.")}</PageMessage>;
  if (entry.installedPluginId) {
    return (
      <Navigate
        to="/admin/$section/$page/$item"
        params={{
          section: "plugins",
          page: "installed",
          item: entry.installedPluginId,
        }}
        replace
      />
    );
  }
  return <PluginReview pluginRef={{ kind: "catalog", entryId }} entry={entry} />;
}

function GithubImport() {
  const t = useTranslation();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState<PluginRef | null>(null);
  if (ref) return <PluginReview pluginRef={ref} onBack={() => setRef(null)} />;
  return (
    <>
      <PageHeading
        title={t("Add a plugin from GitHub")}
        description={t(
          "Any public repository with a plugin in the Cursor, Grok or Agent Plugins format. A link to a folder or branch works too.",
        )}
      />
      <form
        className="flex flex-col gap-4 px-3 sm:px-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) setRef({ kind: "github", url: url.trim() });
        }}
      >
        <FormField
          label={t("Repository link")}
          type="url"
          inputMode="url"
          autoFocus
          spellCheck={false}
          maxLength={2048}
          placeholder="https://github.com/owner/plugin"
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
        />
        <div>
          <Button type="submit" disabled={!url.trim()}>
            {t("Review plugin")}
          </Button>
        </div>
      </form>
    </>
  );
}

type CustomAuth = CustomServerInput["auth"];

function CustomServer() {
  const t = useTranslation();
  const [form, setForm] = useState({
    displayName: "",
    description: "",
    url: "",
    auth: "oauth" as CustomAuth,
    headerName: "Authorization",
  });
  const [ref, setRef] = useState<PluginRef | null>(null);
  if (ref) return <PluginReview pluginRef={ref} onBack={() => setRef(null)} />;
  const field =
    (key: "displayName" | "description" | "url" | "headerName") =>
    (event: { readonly currentTarget: HTMLInputElement }) =>
      setForm({ ...form, [key]: event.currentTarget.value });
  const ready =
    form.displayName.trim() &&
    form.url.trim() &&
    (form.auth !== "header" || form.headerName.trim());
  return (
    <>
      <PageHeading
        title={t("Add an MCP server")}
        description={t(
          "A remote MCP server by its web address. Baskule checks how people sign in before you add it.",
        )}
      />
      <form
        className="flex flex-col gap-4 px-3 sm:px-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setRef({
            kind: "custom",
            server: {
              displayName: form.displayName.trim(),
              ...(form.description.trim() ? { description: form.description.trim() } : {}),
              url: form.url.trim(),
              auth: form.auth,
              ...(form.auth === "header" ? { headerName: form.headerName.trim() } : {}),
            },
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("Name")}
            autoFocus
            placeholder={t("Company wiki")}
            value={form.displayName}
            onChange={field("displayName")}
          />
          <FormField
            label={t("Server address")}
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="https://mcp.example.com/mcp"
            value={form.url}
            onChange={field("url")}
          />
        </div>
        <FormField
          label={t("Description (optional)")}
          placeholder={t("What people can do with it")}
          value={form.description}
          onChange={field("description")}
        />
        <div className="flex flex-col gap-2">
          <Label render={<span />}>{t("Sign-in")}</Label>
          <RadioGroup
            aria-label={t("Sign-in")}
            value={form.auth}
            onValueChange={(auth) => setForm({ ...form, auth: auth as CustomAuth })}
          >
            {(
              [
                ["oauth", t("Each person signs in with their own account")],
                ["header", t("One key for your organization, sent in a header")],
                ["none", t("No sign-in")],
              ] as const
            ).map(([value, text]) => (
              <label key={value} className="flex cursor-pointer items-center gap-3">
                <Radio value={value} />
                <span className="text-sm text-foreground">{text}</span>
              </label>
            ))}
          </RadioGroup>
        </div>
        {form.auth === "header" ? (
          <FormField
            className="sm:max-w-xs"
            label={t("Header name")}
            spellCheck={false}
            font="mono"
            placeholder="X-API-Key"
            value={form.headerName}
            onChange={field("headerName")}
          />
        ) : null}
        <div>
          <Button type="submit" disabled={!ready}>
            {t("Review server")}
          </Button>
        </div>
      </form>
    </>
  );
}

const loadAdmin = () => Promise.all([pluginsApi.installed(), groupsApi.list().catch(() => [])]);

/** Values typed for each server, by server name then variable. */
type Values = Readonly<Record<string, Readonly<Record<string, string>>>>;

function PluginReview({
  pluginRef,
  entry,
  onBack,
}: {
  readonly pluginRef: PluginRef;
  readonly entry?: CatalogEntry;
  readonly onBack?: () => void;
}) {
  const t = useTranslation();
  const navigate = useNavigate();
  // One loader per mount: the parent remounts this per plugin.
  const [loadPreview] = useState(
    () => () =>
      pluginsApi.preview({ ref: pluginRef }).catch((cause: unknown) => {
        throw new Error(
          pluginErrorText(
            cause,
            t("Baskule couldn't read this plugin. Check the address and try again."),
          ),
        );
      }),
  );
  const preview = useApiResource(loadPreview);
  const admin = useApiResource(loadAdmin);
  const [access, setAccess] = useState<PluginAccess>({ kind: "everyone" });
  const [values, setValues] = useState<Values>({});
  /** Servers the administrator turned off before adding; every server is kept by default. */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plugin = preview.data;
  const [installed, groups] = admin.data ?? [null, null];
  const name = plugin?.displayName ?? entry?.displayName ?? "";
  const back = onBack ? (
    <Button size="icon-sm" variant="ghost" aria-label={t("Back")} onClick={onBack}>
      <ChevronLeftIcon />
    </Button>
  ) : null;

  const add = async (current: PluginPreview) => {
    setAdding(true);
    setError(null);
    try {
      const added = await pluginsApi.install({
        ref: pluginRef,
        digest: current.digest,
        access,
        values: filledValues(values, dropped),
        ...(dropped.size > 0
          ? {
              servers: current.servers.map((s) => s.name).filter((n) => !dropped.has(n)),
            }
          : {}),
      });
      notifySuccess(t("{{name}} was added", { name: added.displayName }));
      void navigate({
        to: "/admin/$section/$page/$item",
        params: { section: "plugins", page: "installed", item: added.id },
      });
    } catch (cause) {
      setAdding(false);
      setError(pluginErrorText(cause, t("The plugin could not be added.")));
      if (cause instanceof BaskuleApiError && cause.code === "plugin_changed") {
        void preview.reload();
      }
    }
  };

  return (
    <>
      <PluginHeader
        leading={back}
        name={name || t("Reading the plugin…")}
        logo={plugin?.logo ?? entry?.logo ?? null}
        site={pluginSite({
          homepage: plugin?.homepage ?? entry?.homepage ?? null,
          domains: entry?.domains ?? [],
        })}
        sourceHref={plugin ? originHref(plugin.origin) : null}
        description={plugin?.description ?? entry?.description ?? ""}
        actions={
          plugin ? (
            <Button
              size="lg"
              disabled={
                adding ||
                preview.loading ||
                (plugin.skills.length === 0 && plugin.servers.every((s) => dropped.has(s.name)))
              }
              onClick={() => void add(plugin)}
            >
              {adding ? <Spinner size="sm" /> : null}
              {t("Add plugin")}
            </Button>
          ) : null
        }
      />
      {error ? (
        <div className="px-3 sm:px-4">
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {plugin ? (
        <>
          <AccessSection value={access} groups={groups} onChange={setAccess} />
          <AppsSection
            servers={plugin.servers.map((server) =>
              previewServer(t, server, installed?.oauthClients ?? [], plugin.servers, {
                values: values[server.name] ?? {},
                onValue: (variable, value) =>
                  setValues({
                    ...values,
                    [server.name]: {
                      ...values[server.name],
                      [variable]: value,
                    },
                  }),
                onClientSaved: () => admin.reload(),
                ...(plugin.servers.length > 1
                  ? {
                      include: {
                        checked: !dropped.has(server.name),
                        onChange: (checked: boolean) => {
                          const next = new Set(dropped);
                          if (checked) next.delete(server.name);
                          else next.add(server.name);
                          setDropped(next);
                        },
                      },
                    }
                  : {}),
              }),
            )}
          />
          <SkillsSection skills={plugin.skills} />
          <NotAdded skipped={plugin.skipped} />
        </>
      ) : preview.error ? (
        <div className="px-3 sm:px-4">
          <Alert variant="error">
            <AlertDescription>{preview.error}</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => void preview.reload()}>
                {t("Retry")}
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : (
        <PageMessage>
          <span className="inline-flex items-center gap-2">
            <Spinner size="sm" tone="muted" />
            {t("Reading the plugin…")}
          </span>
        </PageMessage>
      )}
    </>
  );
}

function filledValues(values: Values, dropped: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([server]) => !dropped.has(server))
      .map(
        ([server, entries]) =>
          [
            server,
            Object.fromEntries(Object.entries(entries).filter(([, value]) => value.trim() !== "")),
          ] as const,
      )
      .filter(([, entries]) => Object.keys(entries).length > 0),
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** What a server will need once added, as the server will judge it. */
function previewSetup(
  server: ServerPreview,
  clients: ReadonlyArray<OAuthClientSetup>,
  values: Readonly<Record<string, string>>,
): ServerSetup {
  const missing = server.variables.filter((variable) => !values[variable.name]?.trim());
  if (missing.length > 0)
    return {
      state: "needs_values",
      variables: missing.map((variable) => variable.name),
    };
  const { auth } = server;
  if (
    auth.kind === "oauth" &&
    auth.registration === "client" &&
    auth.issuer &&
    !clients.some((client) => client.issuer === auth.issuer && client.configured)
  )
    return { state: "needs_oauth_client", issuer: auth.issuer };
  return { state: "ready" };
}

function previewServer(
  t: ReturnType<typeof useTranslation>,
  server: ServerPreview,
  clients: ReadonlyArray<OAuthClientSetup>,
  all: ReadonlyArray<ServerPreview>,
  edit: {
    readonly values: Readonly<Record<string, string>>;
    readonly onValue: (variable: string, value: string) => void;
    readonly onClientSaved: () => Promise<void>;
    readonly include?: ServerView["include"];
  },
): ServerView {
  const setup = previewSetup(server, clients, edit.values);
  const { auth } = server;
  const issuer = auth.kind === "oauth" && auth.registration === "client" ? auth.issuer : null;
  const configured = clients.some((client) => client.issuer === issuer && client.configured);
  const hosts = issuer
    ? all
        .filter((other) => other.auth.kind === "oauth" && other.auth.issuer === issuer)
        .map((other) => hostOf(other.url))
    : [];
  const unknownIssuer = auth.kind === "oauth" && auth.registration === "client" && !auth.issuer;
  const panel = server.variables.length > 0 || (issuer && !configured) || unknownIssuer;
  return {
    key: server.name,
    name: server.name,
    url: server.url,
    auth,
    setup,
    ...(edit.include ? { include: edit.include } : {}),
    children: panel ? (
      <div className="flex flex-col gap-3">
        {server.variables.length > 0 ? (
          <VariableFields
            variables={server.variables}
            values={edit.values}
            onChange={edit.onValue}
          />
        ) : null}
        {issuer && !configured ? (
          <SignInSetup
            client={oauthClientFor(clients, issuer, hosts)}
            onSaved={edit.onClientSaved}
          />
        ) : null}
        {unknownIssuer ? (
          <p className="text-xs text-muted-foreground">
            {t("Baskule couldn't find where people sign in. It tries again when someone connects.")}
          </p>
        ) : null}
      </div>
    ) : undefined,
  };
}
