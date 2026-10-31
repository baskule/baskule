// baskule: one installed plugin: paused or not, who may use it, and what is left to set up (a vendor app,
// organization keys) as numbered steps; then what the service needs, the tools it allows and its skills.
// Addresses, sign-in methods and its source wait under Technical details. A plugin an admin brought opens
// in the plugin editor and downloads as a package; skills from the catalog or GitHub change through a copy.
import { catalogService, catalogVendor } from "@t3tools/contracts/baskule-catalog";
import type {
  Group,
  Plugin,
  PluginInput,
  PluginServer,
  PluginTool,
  SkillHistory,
} from "@t3tools/contracts/baskule-plugins";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import {
  CopyIcon,
  DownloadIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { notifyPluginError, pluginErrorText, pluginsApi, toolsErrorText } from "../../plugins/api";
import { DocsLink, PluginContents, PluginIcon, ServiceNeedsList } from "../../plugins/PluginParts";
import {
  contentsKind,
  contentsLabel,
  credentialLabel,
  groupName,
  sourceLabel,
} from "../../plugins/presentation";
import { confirmAction, FormField, notifySuccess, RowIcon, useApiResource } from "../../ui";
import { CopyField } from "../../views/AddPersonDialog";
import { PageDisclosure, PageHeading, PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";
import { PluginEditor } from "./PluginEditor";
import { ServerTools } from "./ServerTools";
import {
  ClientMethodField,
  SetupStep,
  vendorCallback,
  VendorSetupSteps,
  type ClientMethod,
} from "./VendorSetup";

/** Saves a package under the plugin's name. */
function saveZip(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "plugin"}.zip`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** What the editor opens with: the saved plugin, or a copy of its skills only, made in Baskule. */
interface Opened {
  readonly copy: boolean;
  readonly input: PluginInput;
  readonly versions: SkillHistory["versions"];
}

export function PluginDetailPage({ id }: { readonly id: string }) {
  const t = useTranslation();
  const navigate = useNavigate();
  // The parent remounts this per item (`key`), so one loader per mount keeps its identity.
  const [load] = useState(
    () => () =>
      Promise.all([pluginsApi.installed(), pluginsApi.groups()]).then(([plugins, groups]) => ({
        plugin: plugins.find((entry) => entry.id === id) ?? null,
        groups,
      })),
  );
  const data = useApiResource(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Opened | null>(null);
  const [method, setMethod] = useState<ClientMethod>("client_secret_post");

  const run = async (key: string, action: () => Promise<unknown>, failure: string) => {
    setBusy(key);
    return (async () => {
      await action();
      await data.reload();
      return true;
    })()
      .catch((cause: unknown) => {
        notifyPluginError(failure, cause);
        return false;
      })
      .finally(() => {
        setBusy(null);
      });
  };

  if (!data.data) {
    return <ResourceState error={data.error} loading={data.loading} empty emptyText="" />;
  }
  const { plugin, groups } = data.data;
  if (!plugin) {
    return (
      <Navigate
        to="/admin/$section/$page"
        params={{ section: "plugins", page: "installed" }}
        replace
      />
    );
  }

  const granted = groups.filter((group) => group.plugins.includes(plugin.id));
  const unfinished = new Set(
    plugin.setup.filter((entry) => !entry.done).map((entry) => entry.server),
  );
  const ownAccounts = plugin.servers.filter((server) => server.credential === "user-oauth");
  const source = plugin.source;
  const fromCatalog = source.type === "catalog";
  const pinned = source.type === "catalog" || source.type === "github";
  const savedKeys = new Set(
    plugin.servers
      .filter((server) => server.credential === "organization" && !unfinished.has(server.name))
      .map((server) => server.name),
  );
  const vendor = fromCatalog ? catalogVendor(plugin.vendor) : undefined;
  const signIn = vendor?.signIn;
  const vendorApp = signIn?.type === "account" && signIn.client === "static" ? signIn : undefined;
  const setGrant = (group: Group, allowed: boolean) =>
    run(
      `group:${group.id}`,
      () =>
        pluginsApi.updateGroup(group.id, {
          plugins: allowed
            ? [...group.plugins, plugin.id]
            : group.plugins.filter((entry) => entry !== plugin.id),
        }),
      t("Could not change who can use {{name}}", { name: plugin.name }),
    );
  /** Skills come in full from the server; a copy takes nothing else that is tied to this plugin. */
  const open = (copy: boolean) => {
    setBusy(copy ? "copy" : "edit");
    pluginsApi
      .skills(plugin.id)
      .then(
        ({ skills, versions }) =>
          setEditing({
            copy,
            versions,
            input:
              copy || source.type === "catalog"
                ? {
                    name: t("Copy of {{name}}", { name: plugin.name }),
                    description: plugin.description,
                    ...(plugin.icon ? { icon: plugin.icon } : {}),
                    source: { type: "custom" },
                    servers: [],
                    skills,
                    omitted: [],
                  }
                : {
                    name: plugin.name,
                    description: plugin.description,
                    ...(plugin.icon ? { icon: plugin.icon } : {}),
                    source,
                    servers: plugin.servers,
                    skills,
                    omitted: plugin.omitted,
                  },
          }),
        (cause: unknown) =>
          notifyPluginError(t("Could not open {{name}}", { name: plugin.name }), cause),
      )
      .finally(() => setBusy(null));
  };
  const download = () => {
    setBusy("download");
    pluginsApi
      .exportZip(plugin.id)
      .then(
        (blob) => saveZip(blob, plugin.name),
        (cause: unknown) =>
          notifyPluginError(t("Could not download {{name}}", { name: plugin.name }), cause),
      )
      .finally(() => setBusy(null));
  };

  if (editing?.copy) {
    return (
      <>
        <PageHeading
          leading={
            <PluginIcon contents="skills" icon={plugin.icon} className="size-10 [&_svg]:size-5" />
          }
          title={t("Make your own copy of {{name}}", { name: plugin.name })}
          description={t(
            "Only its skills are copied, and they are yours to change. {{name}} stays as it is. Nothing is saved until you click Save plugin.",
            { name: plugin.name },
          )}
        />
        <PluginEditor
          initial={editing.input}
          fixes={[]}
          omitted={[]}
          target={{ type: "create", groups, groupsError: null }}
          onCancel={() => setEditing(null)}
          onSaved={({ id: copyId, name }) => {
            notifySuccess(t("{{name}} was added", { name }));
            void navigate({
              to: "/admin/$section/$page/$item",
              params: { section: "plugins", page: "installed", item: copyId },
            });
          }}
        />
      </>
    );
  }
  if (editing) {
    return (
      <>
        <PageHeading
          leading={
            <PluginIcon
              contents={contentsKind(plugin)}
              icon={plugin.icon}
              className="size-10 [&_svg]:size-5"
            />
          }
          title={t("Edit {{name}}", { name: plugin.name })}
          description={sourceLabel(plugin.source)}
        />
        <PluginEditor
          initial={editing.input}
          fixes={[]}
          omitted={plugin.omitted}
          target={{ type: "edit", id: plugin.id, savedKeys, versions: editing.versions }}
          onCancel={() => setEditing(null)}
          onSaved={({ name }) => {
            notifySuccess(t("{{name}} was saved", { name }));
            void data.reload().then(() => setEditing(null));
          }}
          onReverted={() => void data.reload()}
        />
      </>
    );
  }

  const appNeeded = fromCatalog ? vendorApp !== undefined : ownAccounts.length > 0;
  // A vendor app is a setup step once people need it or one is saved; otherwise it is optional.
  const appInSteps =
    appNeeded &&
    (plugin.vendorConfigured || ownAccounts.some((server) => unfinished.has(server.name)));
  const keyServers = plugin.servers.filter((server) => server.credential === "organization");
  const vendorName = vendor?.name ?? plugin.name;
  const service = fromCatalog ? catalogService(plugin.id) : undefined;
  const version = source.type === "github" ? source.sha.slice(0, 7) : null;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <PageHeading
            leading={
              <PluginIcon
                contents={contentsKind(plugin)}
                icon={plugin.icon}
                className="size-10 [&_svg]:size-5"
              />
            }
            title={plugin.name}
            description={contentsLabel(contentsKind(plugin))}
          >
            {plugin.description ? (
              <p className="pt-1 text-sm text-foreground/80">{plugin.description}</p>
            ) : null}
          </PageHeading>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-3 sm:px-4">
          {fromCatalog ? null : (
            <Button
              size="sm"
              variant="outline"
              aria-label={t("Edit {{name}}", { name: plugin.name })}
              disabled={busy !== null}
              onClick={() => open(false)}
            >
              {busy === "edit" ? <Spinner size="sm" /> : <PencilIcon />}
              {t("Edit")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            aria-label={
              plugin.enabled
                ? t("Pause {{name}}", { name: plugin.name })
                : t("Resume {{name}}", { name: plugin.name })
            }
            disabled={busy !== null}
            onClick={() =>
              void run(
                "enabled",
                () => pluginsApi.update(plugin.id, { enabled: !plugin.enabled }),
                plugin.enabled
                  ? t("Could not pause {{name}}", { name: plugin.name })
                  : t("Could not resume {{name}}", { name: plugin.name }),
              )
            }
          >
            {busy === "enabled" ? (
              <Spinner size="sm" />
            ) : plugin.enabled ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
            {plugin.enabled ? t("Pause") : t("Resume")}
          </Button>
        </div>
      </div>
      {!plugin.enabled ? (
        <Alert variant="warning">
          <AlertDescription>{t("Paused. No one can use it until you resume it.")}</AlertDescription>
        </Alert>
      ) : granted.length === 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("No group can use it yet. Choose who can use it below.")}
          </AlertDescription>
        </Alert>
      ) : unfinished.size > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("People can't use it until you finish setting it up below.")}
          </AlertDescription>
        </Alert>
      ) : null}

      <PageSection
        title={t("Who can use it")}
        description={
          ownAccounts.length > 0
            ? `${t("People in these groups can use it in their chats.")} ${t(
                "Each person connects their own account in Settings → Plugins. In team spaces, it works only where the space owner allows personal accounts.",
              )}`
            : t("People in these groups can use it in their chats.")
        }
        action={
          <Button
            size="sm"
            variant="ghost"
            render={
              <Link to="/admin/$section/$page" params={{ section: "people", page: "groups" }} />
            }
          >
            {t("Manage groups")}
          </Button>
        }
      >
        {groups.map((group) => {
          const allowed = group.plugins.includes(plugin.id);
          return (
            <PageRow
              key={group.id}
              leading={
                <RowIcon>
                  <UsersRoundIcon />
                </RowIcon>
              }
              trailing={
                <>
                  {busy === `group:${group.id}` ? <Spinner size="sm" tone="muted" /> : null}
                  <Switch
                    aria-label={t("{{group}} can use {{name}}", {
                      group: groupName(group),
                      name: plugin.name,
                    })}
                    checked={allowed}
                    disabled={busy !== null}
                    onCheckedChange={(checked) => void setGrant(group, checked)}
                  />
                </>
              }
            >
              <span className="truncate text-sm text-foreground">{groupName(group)}</span>
              <span className="truncate text-xs text-muted-foreground">
                {group.builtin
                  ? t("Every person in your organization")
                  : t("{{count}} person", {
                      count: group.members.length,
                      defaultValue_other: "{{count}} people",
                    })}
              </span>
            </PageRow>
          );
        })}
      </PageSection>

      {appInSteps || keyServers.length > 0 ? (
        <PageSection
          title={t("Setup")}
          description={
            unfinished.size > 0
              ? t("People can use it once these steps are done.")
              : t("Everything is set up.")
          }
        >
          <ol aria-label={t("Setup steps")} className="flex flex-col divide-y divide-border/50">
            {appInSteps ? (
              <VendorSetupSteps
                vendor={plugin.vendor}
                name={vendorName}
                configured={plugin.vendorConfigured}
                docs={vendorApp?.docs}
                method={method}
                first={1}
                onChanged={data.reload}
              />
            ) : null}
            {keyServers.map((server, index) => (
              <OrganizationKeyStep
                key={server.name}
                number={(appInSteps ? 3 : 1) + index}
                title={
                  keyServers.length > 1
                    ? t("Enter the key for {{server}}", { server: server.name })
                    : t("Enter the organization key")
                }
                done={!unfinished.has(server.name)}
                plugin={plugin}
                server={server}
                onChanged={data.reload}
              />
            ))}
          </ol>
        </PageSection>
      ) : null}

      {service && service.prerequisites.length > 0 ? (
        <PageSection title={t("What it needs")} action={<DocsLink service={service} />}>
          <div className="px-3 py-3 sm:px-4">
            <ServiceNeedsList service={service} />
          </div>
        </PageSection>
      ) : null}

      {plugin.servers.length > 0 ? (
        <PageSection
          title={t("Tools")}
          description={t("Switch off any tool the assistant shouldn't use. Changes apply at once.")}
        >
          {plugin.servers.map((server) => (
            <SavedServerTools
              key={server.name}
              title={plugin.servers.length > 1 ? server.name : plugin.name}
              pluginId={plugin.id}
              server={server}
              busy={busy}
              onAllowed={(tool, allowed) =>
                void run(
                  `tools:${server.name}`,
                  () =>
                    pluginsApi.update(plugin.id, {
                      disabledTools: {
                        [server.name]: allowed
                          ? server.disabledTools.filter((entry) => entry !== tool)
                          : [...server.disabledTools, tool],
                      },
                    }),
                  t("Could not change {{tool}}", { tool }),
                )
              }
            />
          ))}
        </PageSection>
      ) : null}

      {plugin.skills.length > 0 || plugin.omitted.length > 0 ? (
        <PageSection
          title={t("What it contains")}
          description={
            pinned && plugin.skills.length > 0
              ? t("Its skills stay as published. Make your own copy to change them.")
              : undefined
          }
          action={
            pinned && plugin.skills.length > 0 ? (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => open(true)}>
                {busy === "copy" ? <Spinner size="sm" /> : <CopyIcon />}
                {t("Make your own copy")}
              </Button>
            ) : undefined
          }
        >
          <div className="px-3 py-4 sm:px-4">
            <PluginContents plugin={plugin} />
          </div>
        </PageSection>
      ) : null}

      <PageDisclosure title={t("Technical details")}>
        {appNeeded ? (
          <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
            <CopyField label={t("Callback address")} value={vendorCallback()} />
            <ClientMethodField value={method} onChange={setMethod} />
            {appInSteps ? null : (
              <OptionalVendorApp
                vendor={plugin.vendor}
                name={vendorName}
                docs={vendorApp?.docs}
                method={method}
                onChanged={data.reload}
              />
            )}
          </div>
        ) : null}
        {plugin.servers.map((server) => (
          <PageRow key={server.name}>
            <span className="text-sm text-foreground [overflow-wrap:anywhere]">{server.name}</span>
            <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {server.url}
            </span>
            <span className="text-xs text-muted-foreground">
              {credentialLabel(server.credential)}
            </span>
          </PageRow>
        ))}
        <PageRow>
          <span className="text-sm text-foreground">{t("Source")}</span>
          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {sourceLabel(source)}
            {source.type === "github" && source.path ? ` · ${source.repo} · ${source.path}` : null}
            {source.type === "github" && !source.path ? ` · ${source.repo}` : null}
          </span>
          {version ? (
            <span className="text-xs text-muted-foreground">
              {t("Version {{version}}", { version })}
            </span>
          ) : null}
        </PageRow>
        <PageRow>
          <span className="text-sm text-foreground">{t("Added")}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(plugin.createdAt).toLocaleString()}
          </span>
        </PageRow>
      </PageDisclosure>

      <PageSection title={fromCatalog ? t("Remove") : t("Download or remove")}>
        {fromCatalog ? null : (
          <PageRow
            trailing={
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={download}>
                {busy === "download" ? <Spinner size="sm" /> : <DownloadIcon />}
                {t("Download as zip")}
              </Button>
            }
          >
            <span className="text-sm text-foreground">{t("Download a copy")}</span>
            <span className="text-xs text-muted-foreground">
              {t("In the standard plugin format, to keep it or add it elsewhere.")}
            </span>
          </PageRow>
        )}
        <PageRow
          trailing={
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void confirmAction(
                  t(
                    "Remove {{name}}?\nNo one can use it any more. Its keys and the choice of groups are deleted.",
                    { name: plugin.name },
                  ),
                  "destructive",
                ).then(async (confirmed) => {
                  if (!confirmed) return;
                  setBusy("remove");
                  try {
                    await pluginsApi.remove(plugin.id);
                    notifySuccess(t("{{name}} was removed", { name: plugin.name }));
                    void navigate({
                      to: "/admin/$section/$page",
                      params: { section: "plugins", page: "installed" },
                    });
                  } catch (cause) {
                    setBusy(null);
                    notifyPluginError(t("Could not remove {{name}}", { name: plugin.name }), cause);
                  }
                })
              }
            >
              {t("Remove plugin…")}
            </Button>
          }
        >
          <span className="text-sm text-foreground">{t("Remove this plugin")}</span>
          <span className="text-xs text-muted-foreground">
            {fromCatalog
              ? t("You can add it again later from the catalog.")
              : t("To keep a copy, download it first.")}
          </span>
        </PageRow>
      </PageSection>
    </>
  );
}

/** A vendor app nobody needs yet: offered for services that turn out not to register Baskule. */
function OptionalVendorApp({
  vendor,
  name,
  docs,
  method,
  onChanged,
}: {
  readonly vendor: string;
  readonly name: string;
  readonly docs: string | undefined;
  readonly method: ClientMethod;
  readonly onChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const [opened, setOpened] = useState(false);
  return opened ? (
    <ol
      aria-label={t("Your own app at {{name}}", { name })}
      className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/60"
    >
      <VendorSetupSteps
        vendor={vendor}
        name={name}
        configured={false}
        docs={docs}
        method={method}
        first={1}
        onChanged={onChanged}
      />
    </ol>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-foreground">{t("Your own app at {{name}}", { name })}</span>
        <span className="text-xs text-muted-foreground">
          {t("Only needed if {{name}} doesn't let Baskule register itself.", { name })}
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={() => setOpened(true)}>
        {t("Set up")}
      </Button>
    </div>
  );
}

/** Lists every tool of a saved server on request, with the switches saved for it. */
function SavedServerTools({
  title,
  pluginId,
  server,
  busy,
  onAllowed,
}: {
  /** The plugin's name when it has one server, otherwise the server's. */
  readonly title: string;
  readonly pluginId: string;
  readonly server: PluginServer;
  readonly busy: string | null;
  readonly onAllowed: (tool: string, allowed: boolean) => void;
}) {
  const t = useTranslation();
  const [listed, setListed] = useState<
    { readonly tools: ReadonlyArray<PluginTool> } | { readonly error: string } | "loading" | null
  >(null);
  const show = () => {
    setListed("loading");
    pluginsApi.tools(pluginId, server.name).then(
      (tools) => setListed({ tools }),
      (cause: unknown) => setListed({ error: toolsErrorText(cause) }),
    );
  };
  const off = server.disabledTools.length;
  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm text-foreground">{title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {off === 0
              ? t("Every tool is allowed")
              : t("{{count}} tool switched off", {
                  count: off,
                  defaultValue_other: "{{count}} tools switched off",
                })}
          </span>
        </div>
        {busy === `tools:${server.name}` ? <Spinner size="sm" tone="muted" /> : null}
        <Button
          size="sm"
          variant="outline"
          aria-label={t("Show tools of {{server}}", { server: server.name })}
          disabled={listed === "loading"}
          onClick={show}
        >
          {listed === "loading" ? <Spinner size="sm" /> : null}
          {t("Show tools")}
        </Button>
      </div>
      {listed === null || listed === "loading" ? null : "error" in listed ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {listed.error}
        </p>
      ) : (
        <ServerTools
          tools={listed.tools}
          disabledTools={server.disabledTools}
          disabled={busy !== null}
          onAllowed={onAllowed}
        />
      )}
    </div>
  );
}

/** One server's organization key as a setup step. Write-only: the key is sent once and never read
 * back. Its header names are changed in the editor. */
function OrganizationKeyStep({
  number,
  title,
  done,
  plugin,
  server,
  onChanged,
}: {
  readonly number: number;
  readonly title: string;
  readonly done: boolean;
  readonly plugin: Plugin;
  readonly server: PluginServer;
  readonly onChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const headers = server.keyHeaders?.length ? server.keyHeaders : ["Authorization"];
  const [values, setValues] = useState<ReadonlyArray<string>>(() => headers.map(() => ""));
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = headers.every((_, at) => values[at]);
  const editing = !done || replacing;

  const save = async (keys: Record<string, string> | null) => {
    setSaving(keys ? "save" : "clear");
    setError(null);
    return (async () => {
      await pluginsApi.secret(plugin.id, { server: server.name, headers: keys });
      setValues(headers.map(() => ""));
      setReplacing(false);
      notifySuccess(keys ? t("Key saved") : t("Key removed"));
      await onChanged();
    })()
      .catch((cause: unknown) => {
        setError(pluginErrorText(cause, t("The key could not be saved.")));
      })
      .finally(() => {
        setSaving(null);
      });
  };

  return (
    <SetupStep number={number} done={done} title={title}>
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready)
              void save(Object.fromEntries(headers.map((header, at) => [header, values[at]!])));
          }}
        >
          {headers.map((header, at) => (
            <FormField
              key={header}
              label={headers.length === 1 ? t("Key") : t("Key {{number}}", { number: at + 1 })}
              type="password"
              autoComplete="new-password"
              value={values[at] ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setValues((current) =>
                  current.map((entry, index) => (index === at ? value : entry)),
                );
              }}
            />
          ))}
          <p className="text-xs text-muted-foreground">
            {replacing
              ? t("Saving replaces the current key.")
              : t("Stored encrypted and never shown again. Everyone who uses it shares this key.")}
          </p>
          {error ? (
            <Alert variant="error" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            {replacing ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving !== null}
                onClick={() => setReplacing(false)}
              >
                {t("Cancel")}
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={saving !== null || !ready}>
              {saving === "save" ? <Spinner size="sm" /> : null}
              {t("Save key")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("Saved. Everyone who uses it shares this key.")}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving !== null}
                onClick={() => void save(null)}
              >
                {saving === "clear" ? <Spinner size="sm" /> : null}
                {t("Remove key")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving !== null}
                onClick={() => setReplacing(true)}
              >
                {t("Replace key")}
              </Button>
            </div>
          </div>
          {error ? (
            <Alert variant="error" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </>
      )}
    </SetupStep>
  );
}
