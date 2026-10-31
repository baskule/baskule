// baskule: one installed plugin: paused or not, which groups may use it, how its servers sign in
// (with the write-only organization key or vendor app), what it contains, where it came from, and removal.
// A plugin an admin brought opens in the plugin editor and downloads as a package.
import { catalogService, catalogVendor } from "@t3tools/contracts/baskule-catalog";
import type {
  AdminPlugin,
  Group,
  Plugin,
  PluginInput,
  PluginServer,
} from "@t3tools/contracts/baskule-plugins";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { DownloadIcon, PauseIcon, PencilIcon, PlayIcon, UsersRoundIcon } from "lucide-react";
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { notifyPluginError, pluginErrorText, pluginsApi } from "../../plugins/api";
import { PluginContents, PluginIcon } from "../../plugins/PluginParts";
import {
  contentsKind,
  contentsLabel,
  credentialDescription,
  credentialLabel,
  groupName,
  serverHost,
  sourceLabel,
} from "../../plugins/presentation";
import { confirmAction, FormField, notifySuccess, RowIcon, useApiResource } from "../../ui";
import { PageHeading, PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";
import { PluginEditor } from "./PluginEditor";
import { VendorSetup } from "./VendorSetup";

/** Saves a package under the plugin's name. */
function saveZip(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "plugin"}.zip`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The saved plugin as the one shape the editor works on; skills come in full from the server. */
async function editorInput(plugin: AdminPlugin): Promise<PluginInput | null> {
  const source = plugin.source;
  if (source.type === "catalog") return null;
  const { skills } = await pluginsApi.skills(plugin.id);
  return {
    name: plugin.name,
    description: plugin.description,
    ...(plugin.icon ? { icon: plugin.icon } : {}),
    source,
    servers: plugin.servers,
    skills,
    omitted: plugin.omitted,
  };
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
  const [editing, setEditing] = useState<PluginInput | null>(null);

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
  const fromCatalog = plugin.source.type === "catalog";
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
  const edit = () => {
    setBusy("edit");
    editorInput(plugin)
      .then(setEditing, (cause: unknown) =>
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
          initial={editing}
          fixes={[]}
          omitted={plugin.omitted}
          target={{ type: "edit", id: plugin.id, savedKeys }}
          onCancel={() => setEditing(null)}
          onSaved={({ name }) => {
            notifySuccess(t("{{name}} was saved", { name }));
            void data.reload().then(() => setEditing(null));
          }}
        />
      </>
    );
  }

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
        title={plugin.name}
        description={`${contentsLabel(contentsKind(plugin))} · ${sourceLabel(plugin.source)}`}
        trailing={
          <>
            {fromCatalog ? null : (
              <Button
                size="sm"
                variant="outline"
                aria-label={t("Edit {{name}}", { name: plugin.name })}
                disabled={busy !== null}
                onClick={edit}
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
          </>
        }
      >
        {plugin.description ? (
          <p className="pt-1 text-sm text-foreground/80">{plugin.description}</p>
        ) : null}
      </PageHeading>
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
        description={t(
          "Their people can use it in their chats, and connect their own account in Settings → Plugins if it needs one.",
        )}
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

      {plugin.servers.length > 0 ? (
        <PageSection
          title={t("Accounts")}
          description={t("How each server signs in to its service.")}
        >
          {plugin.servers.map((server) => (
            <ServerSettings
              key={server.name}
              plugin={plugin}
              server={server}
              onKeyChanged={data.reload}
            />
          ))}
        </PageSection>
      ) : null}

      {(fromCatalog ? vendorApp : ownAccounts.length > 0) ? (
        <VendorSetup
          vendor={plugin.vendor}
          name={vendor?.name ?? plugin.name}
          configured={plugin.vendorConfigured}
          required={ownAccounts.some((server) => unfinished.has(server.name))}
          docs={vendorApp?.docs}
          onChanged={data.reload}
        />
      ) : null}

      <PageSection title={t("What it contains")}>
        <div className="px-3 py-4 sm:px-4">
          <PluginContents plugin={plugin} />
        </div>
      </PageSection>

      <PageSection title={t("Source")}>
        <PageRow
          trailing={
            fromCatalog ? null : (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={download}>
                {busy === "download" ? <Spinner size="sm" /> : <DownloadIcon />}
                {t("Download as zip")}
              </Button>
            )
          }
        >
          <span className="text-sm text-foreground [overflow-wrap:anywhere]">
            {sourceLabel(plugin.source)}
          </span>
          {sourceDetail(plugin) ? (
            <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {sourceDetail(plugin)}
            </span>
          ) : null}
        </PageRow>
        <PageRow>
          <span className="text-sm text-foreground">{t("Added")}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(plugin.createdAt).toLocaleString()}
          </span>
        </PageRow>
      </PageSection>

      <PageSection title={t("Remove")}>
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
              : t("To keep a copy, download it as a zip first.")}
          </span>
        </PageRow>
      </PageSection>
    </>
  );
}

function sourceDetail(plugin: Plugin): string | null {
  const source = plugin.source;
  switch (source.type) {
    case "catalog":
      return catalogService(plugin.id)?.docs ?? null;
    case "github":
      return source.path ? `${source.repo} · ${source.path}` : source.repo;
    case "upload":
    case "custom":
      return null;
  }
}

function ServerSettings({
  plugin,
  server,
  onKeyChanged,
}: {
  readonly plugin: Plugin;
  readonly server: PluginServer;
  readonly onKeyChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm text-foreground">{server.name}</span>
          <span className="truncate text-xs text-muted-foreground">{serverHost(server)}</span>
        </div>
        <span className="text-sm text-foreground sm:text-end">
          {credentialLabel(server.credential)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {credentialDescription(server.credential)}
        {server.credential === "user-oauth"
          ? ` ${t("In team spaces it works only where the space owner allows personal accounts.")}`
          : ""}
      </p>
      {server.credential === "organization" ? (
        <OrganizationKeyForm plugin={plugin} server={server} onChanged={onKeyChanged} />
      ) : null}
    </div>
  );
}

/** Write-only: the key is sent once and never read back, like the AI key. */
function OrganizationKeyForm({
  plugin,
  server,
  onChanged,
}: {
  readonly plugin: Plugin;
  readonly server: PluginServer;
  readonly onChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const [entries, setEntries] = useState(() =>
    (server.keyHeaders?.length ? server.keyHeaders : ["Authorization"]).map((header) => ({
      header,
      value: "",
    })),
  );
  const ready = entries.every((entry) => entry.header.trim() && entry.value);
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (headers: Record<string, string> | null) => {
    setSaving(headers ? "save" : "clear");
    setError(null);
    return (async () => {
      await pluginsApi.secret(plugin.id, { server: server.name, headers });
      setEntries((current) => current.map((entry) => ({ ...entry, value: "" })));
      notifySuccess(headers ? t("Key saved") : t("Key removed"));
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
    <form
      className="flex flex-col gap-3 rounded-lg border border-border/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready)
          void save(Object.fromEntries(entries.map((entry) => [entry.header.trim(), entry.value])));
      }}
    >
      {entries.map((entry, index) => (
        <FormField
          key={index}
          label={entries.length === 1 ? t("Key") : t("Key {{number}}", { number: index + 1 })}
          type="password"
          autoComplete="new-password"
          value={entry.value}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setEntries((current) =>
              current.map((item, at) => (at === index ? { ...item, value } : item)),
            );
          }}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        {t("Saved keys are never shown again. Saving replaces the current keys.")}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("Technical details")}</summary>
        <div className="flex flex-col gap-3 pt-3">
          {entries.map((entry, index) => (
            <FormField
              key={index}
              label={
                entries.length === 1
                  ? t("Sent as")
                  : t("Key {{number}} header", { number: index + 1 })
              }
              value={entry.header}
              autoComplete="off"
              onChange={(event) => {
                const header = event.currentTarget.value;
                setEntries((current) =>
                  current.map((item, at) => (at === index ? { ...item, header } : item)),
                );
              }}
            />
          ))}
        </div>
      </details>
      {error ? (
        <Alert variant="error" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
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
        <Button type="submit" size="sm" disabled={saving !== null || !ready}>
          {saving === "save" ? <Spinner size="sm" /> : null}
          {t("Save key")}
        </Button>
      </div>
    </form>
  );
}
