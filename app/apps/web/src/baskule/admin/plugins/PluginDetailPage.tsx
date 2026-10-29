// baskule: one installed plugin: on or off, which groups may use it, how its connectors sign in
// (with the write-only organization key), what it contains, where it came from, and removal.
import type {
  CredentialMode,
  Group,
  Plugin,
  PluginServer,
} from "@t3tools/contracts/baskule-plugins";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { UsersRoundIcon } from "lucide-react";
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { notifyPluginError, pluginErrorText, pluginsApi } from "../../plugins/api";
import { PluginContents, PluginIcon } from "../../plugins/PluginParts";
import {
  CREDENTIAL_MODES,
  credentialDescription,
  credentialLabel,
  groupName,
  isPersonalCredential,
  kindLabel,
  serverHost,
  sourceLabel,
} from "../../plugins/presentation";
import { confirmAction, FormField, notifySuccess, RowIcon, useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { PageHeading } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

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
  const setCredential = (server: PluginServer, credential: CredentialMode) =>
    run(
      `server:${server.name}`,
      () =>
        pluginsApi.update(plugin.id, {
          servers: plugin.servers.map((entry) =>
            entry.name === server.name
              ? { name: entry.name, credential, personal: isPersonalCredential(credential) }
              : { name: entry.name, credential: entry.credential, personal: entry.personal },
          ),
        }),
      t("Could not change how {{name}} signs in", { name: server.name }),
    );

  return (
    <>
      <PageHeading
        leading={
          <PluginIcon kind={plugin.kind} icon={plugin.icon} className="size-10 [&_svg]:size-5" />
        }
        title={plugin.name}
        description={`${kindLabel(plugin.kind)} · ${sourceLabel(plugin.source)}`}
        trailing={
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {busy === "enabled" ? <Spinner size="sm" tone="muted" /> : null}
            {plugin.enabled ? t("On") : t("Off")}
            <Switch
              aria-label={t("{{name}} is on", { name: plugin.name })}
              checked={plugin.enabled}
              disabled={busy !== null}
              onCheckedChange={(enabled) =>
                void run(
                  "enabled",
                  () => pluginsApi.update(plugin.id, { enabled }),
                  enabled
                    ? t("Could not turn on {{name}}", { name: plugin.name })
                    : t("Could not turn off {{name}}", { name: plugin.name }),
                )
              }
            />
          </label>
        }
      >
        {plugin.description ? (
          <p className="pt-1 text-sm text-foreground/80">{plugin.description}</p>
        ) : null}
      </PageHeading>
      {plugin.enabled && granted.length === 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("It is on, but no group can use it yet. Choose who can use it below.")}
          </AlertDescription>
        </Alert>
      ) : null}

      <PageSection
        title={t("Who can use it")}
        description={t("Their people find it in Settings → Plugins and turn it on for themselves.")}
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
          description={t("How each connector signs in to its service.")}
        >
          {plugin.servers.map((server) => (
            <ServerSettings
              key={server.name}
              plugin={plugin}
              server={server}
              busy={busy === `server:${server.name}`}
              disabled={busy !== null}
              onCredential={(mode) => void setCredential(server, mode)}
            />
          ))}
        </PageSection>
      ) : null}

      <PageSection title={t("What it contains")}>
        <div className="px-3 py-4 sm:px-4">
          <PluginContents plugin={plugin} />
        </div>
      </PageSection>

      <PageSection title={t("Source")}>
        <PageRow>
          <span className="text-sm text-foreground [overflow-wrap:anywhere]">
            {sourceLabel(plugin.source)}
          </span>
          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {sourceDetail(plugin)}
          </span>
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
            {t("You can add it again later from the catalog.")}
          </span>
        </PageRow>
      </PageSection>
    </>
  );
}

function sourceDetail(plugin: Plugin): string {
  const concrete = plugin.resolvedSource ?? plugin.source;
  switch (concrete.type) {
    case "registry":
      return concrete.version ? `${concrete.id} · ${concrete.version}` : concrete.id;
    case "url":
      return concrete.url;
    case "git":
      return [concrete.repo, concrete.path, concrete.ref].filter(Boolean).join(" · ");
    case "archive":
      return `SHA-256 ${concrete.sha256}`;
  }
}

function ServerSettings({
  plugin,
  server,
  busy,
  disabled,
  onCredential,
}: {
  readonly plugin: Plugin;
  readonly server: PluginServer;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onCredential: (mode: CredentialMode) => void;
}) {
  const t = useTranslation();
  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm text-foreground">{server.name}</span>
          <span className="truncate text-xs text-muted-foreground">{serverHost(server)}</span>
        </div>
        {busy ? <Spinner size="sm" tone="muted" /> : null}
        <Select
          value={server.credential}
          disabled={disabled}
          onValueChange={(value) => {
            if (value && value !== server.credential) onCredential(value as CredentialMode);
          }}
        >
          <SelectTrigger
            className="w-full sm:w-72"
            aria-label={t("How {{name}} signs in", { name: server.name })}
          >
            <SelectValue>{(value: CredentialMode) => credentialLabel(value)}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {CREDENTIAL_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                <span className="flex min-w-0 flex-col">
                  <span>{credentialLabel(mode)}</span>
                  <span className="text-xs text-muted-foreground">
                    {credentialDescription(mode)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {credentialDescription(server.credential)}
        {isPersonalCredential(server.credential)
          ? ` ${t("In team spaces it works only where the space owner allows personal accounts.")}`
          : ""}
      </p>
      {server.credential === "organization" ? (
        <OrganizationKeyForm plugin={plugin} server={server} />
      ) : null}
    </div>
  );
}

/** Write-only: the key is sent once and never read back, like the AI key. */
function OrganizationKeyForm({
  plugin,
  server,
}: {
  readonly plugin: Plugin;
  readonly server: PluginServer;
}) {
  const t = useTranslation();
  const [header, setHeader] = useState("Authorization");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (headers: Record<string, string> | null) => {
    setSaving(headers ? "save" : "clear");
    setError(null);
    return (async () => {
      await pluginsApi.secret(plugin.id, { server: server.name, headers });
      setValue("");
      notifySuccess(headers ? t("Key saved") : t("Key removed"));
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
        if (header.trim() && value) void save({ [header.trim()]: value });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <FormField
          label={t("Sent as")}
          value={header}
          autoComplete="off"
          onChange={(event) => setHeader(event.currentTarget.value)}
        />
        <FormField
          label={t("Key")}
          type="password"
          autoComplete="new-password"
          placeholder={t("Bearer sk-…")}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Saved keys are never shown again; saving replaces the current one. Most services expect “Authorization” with “Bearer” followed by the key.",
        )}
      </p>
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
        <Button type="submit" size="sm" disabled={saving !== null || !header.trim() || !value}>
          {saving === "save" ? <Spinner size="sm" /> : null}
          {t("Save key")}
        </Button>
      </div>
    </form>
  );
}
