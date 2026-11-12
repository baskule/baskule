// baskule: Settings → Plugins, for every person: the plugins an administrator lets them use, a
// switch for each, and signing in to the services that act as them. Only admins add plugins.
import type { MemberConnection, MemberPlugin } from "@t3tools/contracts/baskule-plugins";
import { CircleAlertIcon, CircleCheckIcon, CircleMinusIcon } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { ResourceState } from "../admin/ResourceState";
import { confirmAction, useApiResource } from "../ui";
import { PageMessage, PageSection } from "../views/BaskulePage";
import { connectUrl, notifyPluginError, pluginErrorCodeText, pluginsApi } from "./api";
import { PluginLogo } from "./PluginLogo";

const loadMine = () => pluginsApi.mine();

/** The connect endpoint sends the person back here with `plugin`, `connection` and `code`. */
function useConnectionOutcome() {
  const t = useTranslation();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- consumes the sign-in return URL once and reports its outcome in a toast.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("connection");
    if (!outcome) return;
    const code = url.searchParams.get("code");
    for (const key of ["plugin", "connection", "code"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
    if (outcome === "connected") {
      toastManager.add({ type: "success", title: t("Your account is connected.") });
    } else {
      toastManager.add({
        type: "error",
        title: t("Could not connect your account"),
        description: pluginErrorCodeText(
          code,
          t("Try again. If it keeps failing, ask an administrator."),
        ),
      });
    }
  }, [t]);
}

export function MemberPluginsView() {
  const t = useTranslation();
  const data = useApiResource(loadMine);
  const plugins = data.data ?? [];
  useConnectionOutcome();
  return (
    <SettingsPageContainer>
      <PageSection
        title={t("Your plugins")}
        description={t(
          "An administrator chooses which plugins you can use. Switch one off to keep the assistant from using it for you.",
        )}
      >
        {data.data && plugins.length === 0 ? (
          <PageMessage>{t("No plugins are available to you yet.")}</PageMessage>
        ) : (
          <ResourceState
            error={data.error}
            loading={data.loading}
            empty={plugins.length === 0}
            emptyText=""
          />
        )}
        {plugins.map((plugin) => (
          <MemberPluginRow key={plugin.id} plugin={plugin} onChanged={data.reload} />
        ))}
      </PageSection>
      {plugins.some((plugin) =>
        plugin.servers.some((server) => server.connection.state !== "not_required"),
      ) ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {t(
            "Plugins you sign in to act as you, also in team spaces: each person's chats use their own sign-in.",
          )}
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}

function MemberPluginRow({
  plugin,
  onChanged,
}: {
  readonly plugin: MemberPlugin;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useTranslation();
  const [pendingOn, setPendingOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const on = pendingOn ?? plugin.on;
  const single = plugin.servers.length === 1;
  const serverName = (server: MemberPlugin["servers"][number]) =>
    single ? plugin.displayName : server.name;

  const toggle = async (next: boolean) => {
    setPendingOn(next);
    try {
      await pluginsApi.switch(plugin.id, { on: next });
      await onChanged();
    } catch (cause) {
      notifyPluginError(
        next
          ? t("Could not switch {{name}} on", { name: plugin.displayName })
          : t("Could not switch {{name}} off", { name: plugin.displayName }),
        cause,
      );
    } finally {
      setPendingOn(null);
    }
  };

  const disconnect = async (server: MemberPlugin["servers"][number]) => {
    const name = serverName(server);
    const confirmed = await confirmAction(
      t(
        "Disconnect {{name}}?\nThe assistant can no longer act as you there until you sign in again.",
        {
          name,
        },
      ),
      "destructive",
    );
    if (!confirmed) return;
    setBusy(server.id);
    try {
      await pluginsApi.disconnect(plugin.id, server.id);
      await onChanged();
    } catch (cause) {
      notifyPluginError(t("Could not disconnect {{name}}", { name }), cause);
    } finally {
      setBusy(null);
    }
  };

  const nameId = useId();
  const lines = plugin.enabled
    ? plugin.servers.filter((server) => server.connection.state !== "not_required")
    : [];

  return (
    <div role="group" aria-labelledby={nameId} className="flex items-start gap-3 px-3 py-3 sm:px-4">
      <PluginLogo name={plugin.displayName} logo={plugin.logo} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
            <span id={nameId} className="truncate text-sm font-medium text-foreground">
              {plugin.displayName}
            </span>
            {plugin.enabled ? (
              plugin.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {plugin.description}
                </span>
              ) : null
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("Paused by an administrator")}
              </span>
            )}
          </div>
          <Switch
            aria-label={t("Use {{name}}", { name: plugin.displayName })}
            checked={on}
            disabled={!plugin.enabled || pendingOn !== null}
            onCheckedChange={(next) => void toggle(next)}
          />
        </div>
        {lines.length > 0 ? (
          <ul className={cn("flex flex-col", !on && "opacity-70")}>
            {lines.map((server) => (
              <li
                key={server.id}
                className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1"
              >
                <ConnectionText
                  connection={server.connection}
                  server={single ? null : server.name}
                />
                <span className="ms-auto flex shrink-0 items-center gap-1">
                  {busy === server.id ? <Spinner size="sm" tone="muted" /> : null}
                  <ConnectionActions
                    pluginId={plugin.id}
                    serverId={server.id}
                    name={serverName(server)}
                    connection={server.connection}
                    disabled={busy !== null}
                    onDisconnect={() => void disconnect(server)}
                  />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionText({
  connection,
  server,
}: {
  readonly connection: MemberConnection;
  readonly server: string | null;
}) {
  const t = useTranslation();
  let tone: "success" | "warning" | "muted" = "muted";
  let text: ReactNode;
  switch (connection.state) {
    case "connected":
      tone = "success";
      text = connection.account
        ? t("Connected as {{account}}", { account: connection.account })
        : t("Connected");
      break;
    case "expired":
      tone = "warning";
      text = t("Your sign-in expired");
      break;
    case "not_connected":
      text = t("Not connected");
      break;
    case "unavailable":
      tone = "warning";
      text = t("Not ready yet, ask an administrator");
      break;
    case "not_required":
      return null;
  }
  const Icon =
    tone === "success" ? CircleCheckIcon : tone === "warning" ? CircleAlertIcon : CircleMinusIcon;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0",
        tone === "success"
          ? "text-success-foreground"
          : tone === "warning"
            ? "text-warning-foreground"
            : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden />
      <span className="min-w-0 truncate">
        {server ? <span className="text-foreground">{server}: </span> : null}
        {text}
      </span>
    </span>
  );
}

function ConnectionActions({
  pluginId,
  serverId,
  name,
  connection,
  disabled,
  onDisconnect,
}: {
  readonly pluginId: string;
  readonly serverId: string;
  readonly name: string;
  readonly connection: MemberConnection;
  readonly disabled: boolean;
  readonly onDisconnect: () => void;
}) {
  const t = useTranslation();
  const signIn = (label: string, ariaLabel: string) => (
    <Button
      size="xs"
      variant="outline"
      aria-label={ariaLabel}
      render={<a href={connectUrl(pluginId, serverId)} />}
    >
      {label}
    </Button>
  );
  const disconnect = (
    <Button
      size="xs"
      variant="ghost-muted"
      aria-label={t("Disconnect {{name}}", { name })}
      disabled={disabled}
      onClick={onDisconnect}
    >
      {t("Disconnect")}
    </Button>
  );
  switch (connection.state) {
    case "not_connected":
      return signIn(t("Sign in"), t("Sign in to {{name}}", { name }));
    case "expired":
      return (
        <>
          {signIn(t("Reconnect"), t("Reconnect {{name}}", { name }))}
          {disconnect}
        </>
      );
    case "connected":
      return disconnect;
    default:
      return null;
  }
}
