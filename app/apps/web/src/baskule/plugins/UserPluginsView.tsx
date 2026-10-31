// baskule: Settings → Plugins, for every person: the plugins their groups give them, what each
// needs before it works, and the accounts they connect. People never add plugins; the admin does.
import type { MemberPlugin, PluginStatus } from "@t3tools/contracts/baskule-plugins";
import { CircleAlertIcon, CircleCheckIcon, CircleMinusIcon, LinkIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { ResourceState } from "../admin/ResourceState";
import { confirmAction, useApiResource } from "../ui";
import { PageMessage, PageSection } from "../views/BaskulePage";
import { accountConnectionUrl, notifyPluginError, pluginErrorCodeText, pluginsApi } from "./api";
import { PluginIcon, PluginTitle } from "./PluginParts";
import { contentsKind, statusText } from "./presentation";

const loadMine = () => pluginsApi.mine();

/** The connect endpoint sends the person back here with the outcome in the query; any
 * `connectionError` means it failed. */
function useConnectionOutcome() {
  const t = useTranslation();
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("pluginConnection");
    const code = url.searchParams.get("connectionError");
    if (!outcome && !code) return;
    url.searchParams.delete("pluginConnection");
    url.searchParams.delete("connectionError");
    window.history.replaceState(window.history.state, "", url);
    if (outcome === "connected" && !code) {
      toastManager.add({ type: "success", title: t("Your account is connected.") });
    } else {
      toastManager.add({
        type: "error",
        title: t("Could not connect your account"),
        description: pluginErrorCodeText(
          code,
          t("Try again. If it keeps failing, ask your admin."),
        ),
      });
    }
  }, [t]);
}

export function UserPluginsView() {
  const t = useTranslation();
  const data = useApiResource(loadMine);
  const plugins = data.data ?? [];
  useConnectionOutcome();
  return (
    <SettingsPageContainer>
      <PageSection
        title={t("Your plugins")}
        description={t(
          "Your admin chooses which plugins you can use. Each one works in your chats once it is ready.",
        )}
      >
        {data.data && plugins.length === 0 ? (
          <PageMessage>{t("No plugins are available to you yet. Ask your admin.")}</PageMessage>
        ) : (
          <ResourceState
            error={data.error}
            loading={data.loading}
            empty={plugins.length === 0}
            emptyText=""
          />
        )}
        {plugins.map((plugin) => (
          <UserPluginRow key={plugin.id} plugin={plugin} onChanged={() => void data.reload()} />
        ))}
      </PageSection>
    </SettingsPageContainer>
  );
}

const STATUS_TONES = {
  unavailable: "off",
  needs_setup: "warning",
  connect: "connect",
  reconnect: "warning",
  ready: "success",
} as const satisfies Record<PluginStatus, string>;

function StatusLine({
  status,
  children,
  action,
}: {
  readonly status: PluginStatus;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  const tone = STATUS_TONES[status];
  const Icon = {
    off: CircleMinusIcon,
    connect: LinkIcon,
    warning: CircleAlertIcon,
    success: CircleCheckIcon,
  }[tone];
  return (
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
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
        <span className="min-w-0">{children}</span>
      </span>
      {action}
    </div>
  );
}

export function UserPluginRow({
  plugin,
  onChanged,
}: {
  readonly plugin: MemberPlugin;
  readonly onChanged: () => void;
}) {
  const t = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const blocked = plugin.status === "unavailable" || plugin.status === "needs_setup";
  const ownAccount = plugin.servers.some((server) => server.credential === "user-oauth");
  // With several servers, each account is named by its server.
  const accountName = (server: string) => (plugin.servers.length > 1 ? server : plugin.name);

  const connect = (server: string) => {
    setBusy(`connect:${server}`);
    window.location.assign(accountConnectionUrl(plugin.id, server, "/settings/plugins"));
  };

  const disconnect = async (server: string) => {
    const confirmed = await confirmAction(
      t(
        "Disconnect your account from {{name}}?\nIt stops working for you until you connect again.",
        {
          name: plugin.name,
        },
      ),
    );
    if (!confirmed) return;
    setBusy(`disconnect:${server}`);
    return (async () => {
      await pluginsApi.disconnect(plugin.id, server);
      onChanged();
    })()
      .catch((cause: unknown) => {
        notifyPluginError(t("Could not disconnect your account"), cause);
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const actions = plugin.servers.flatMap((server) => {
    const name = accountName(server.name);
    if (!blocked && (server.status === "connect" || server.status === "reconnect")) {
      return [
        <Button
          key={server.name}
          size="xs"
          variant="outline"
          aria-label={statusText(server.status, name)}
          disabled={busy !== null}
          onClick={() => connect(server.name)}
        >
          {busy === `connect:${server.name}` ? <Spinner size="sm" /> : null}
          {server.status === "connect" ? t("Connect") : t("Reconnect")}
        </Button>,
      ];
    }
    // Only an account the person connected themselves can be disconnected here.
    if (server.status === "ready" && server.credential === "user-oauth") {
      return [
        <Button
          key={server.name}
          size="xs"
          variant="ghost"
          aria-label={t("Disconnect your {{name}} account", { name })}
          disabled={busy !== null}
          onClick={() => void disconnect(server.name)}
        >
          {busy === `disconnect:${server.name}` ? <Spinner size="sm" /> : null}
          {t("Disconnect")}
        </Button>,
      ];
    }
    return [];
  });
  const worst = plugin.servers.find((server) => server.status === plugin.status);

  return (
    <div className={cn("flex flex-col gap-2 px-3 py-3 sm:px-4", blocked && "opacity-70")}>
      <div className="flex items-start gap-3">
        <PluginIcon contents={contentsKind(plugin)} icon={plugin.icon} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <PluginTitle name={plugin.name} contents={contentsKind(plugin)} />
          {plugin.description ? (
            <span className="line-clamp-2 text-xs text-muted-foreground">{plugin.description}</span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-1 ps-11">
        <StatusLine
          status={plugin.status}
          action={actions.length > 0 ? <span className="flex gap-1.5">{actions}</span> : null}
        >
          {statusText(plugin.status, accountName(worst?.name ?? plugin.name))}
        </StatusLine>
        {ownAccount && plugin.status !== "unavailable" ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "It acts as you. In team spaces it works only where the space owner allows personal accounts, and members can read its results.",
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
