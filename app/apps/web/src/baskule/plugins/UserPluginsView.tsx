import { useTranslation } from "../../i18n";
// baskule: Settings → Plugins, for every person: the plugins their groups allow, turned on or off
// for themselves, and the accounts they connect. People never add plugins; the admin does.
import type { UserPlugin } from "@t3tools/contracts/baskule-plugins";
import { CircleAlertIcon, CircleCheckIcon, CircleMinusIcon, LinkIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { ResourceState } from "../admin/ResourceState";
import { confirmAction, useApiResource } from "../ui";
import { PageMessage, PageSection } from "../views/BaskulePage";
import { notifyPluginError, pluginsApi, accountConnectionUrl } from "./api";
import { PluginIcon, PluginTitle } from "./PluginParts";

const loadMine = () => pluginsApi.mine();

/** The connect endpoint sends the person back here with the outcome in the query. */
function useConnectionOutcome() {
  const t = useTranslation();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Consume the OAuth redirect URL and publish its result to the toast service.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("pluginConnection");
    if (!outcome) return;
    const code = url.searchParams.get("connectionError");
    url.searchParams.delete("pluginConnection");
    url.searchParams.delete("connectionError");
    window.history.replaceState(window.history.state, "", url);
    if (outcome === "connected") {
      toastManager.add({ type: "success", title: t("Your account is connected.") });
    } else {
      toastManager.add({
        type: "error",
        title: t("Could not connect your account"),
        description:
          code === "consent_denied"
            ? t("The sign-in was cancelled or permission was not granted.")
            : t("Try again. If it keeps failing, ask your admin."),
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
          "Your admin chooses which plugins you can use. Turn on the ones you want: they work in your chats.",
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

function StatusLine({
  tone,
  children,
  action,
}: {
  readonly tone: "off" | "connect" | "warning" | "success";
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
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
  readonly plugin: UserPlugin;
  readonly onChanged: () => void;
}) {
  const t = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const offByAdmin = !plugin.enabled;
  const personal = plugin.servers.some((server) => server.personal);

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

  const connectionLines = plugin.connections.flatMap((connection) => {
    const server = plugin.servers.find((entry) => entry.name === connection.server);
    const label = plugin.servers.length > 1 ? connection.server : null;
    switch (connection.state) {
      case "not_required":
        return [];
      case "needs_configuration":
        return [
          <StatusLine key={connection.server} tone="warning">
            {label
              ? t("{{server}}: waiting for your admin to add its key.", { server: label })
              : t("Waiting for your admin to add its key.")}
          </StatusLine>,
        ];
      case "needs_connection":
        return [
          <StatusLine
            key={connection.server}
            tone="connect"
            action={
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null || offByAdmin}
                onClick={() => connect(connection.server)}
              >
                {busy === `connect:${connection.server}` ? <Spinner size="sm" /> : null}
                {t("Connect your account")}
              </Button>
            }
          >
            {label
              ? t("{{server}} needs your own account.", { server: label })
              : t("It needs your own account.")}
          </StatusLine>,
        ];
      case "configured":
        // Organization keys are the admin's business.
        return [];
      case "connected":
        return server?.personal
          ? [
              <StatusLine
                key={connection.server}
                tone="success"
                action={
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void disconnect(connection.server)}
                  >
                    {busy === `disconnect:${connection.server}` ? <Spinner size="sm" /> : null}
                    {t("Disconnect")}
                  </Button>
                }
              >
                {label
                  ? t("{{server}}: your account is connected.", { server: label })
                  : t("Your account is connected.")}
              </StatusLine>,
            ]
          : [];
    }
  });

  return (
    <div className={cn("flex flex-col gap-2 px-3 py-3 sm:px-4", offByAdmin && "opacity-70")}>
      <div className="flex items-start gap-3">
        <PluginIcon kind={plugin.kind} icon={plugin.icon} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <PluginTitle name={plugin.name} kind={plugin.kind} />
          {plugin.description ? (
            <span className="line-clamp-2 text-xs text-muted-foreground">{plugin.description}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          {busy === "enabled" ? <Spinner size="sm" tone="muted" /> : null}
          <Switch
            aria-label={t("Use {{name}}", { name: plugin.name })}
            checked={plugin.userEnabled && !offByAdmin}
            disabled={busy !== null || offByAdmin}
            onCheckedChange={(enabled) => {
              setBusy("enabled");
              pluginsApi.enable(plugin.id, enabled).then(
                () => {
                  setBusy(null);
                  onChanged();
                },
                (cause: unknown) => {
                  setBusy(null);
                  notifyPluginError(
                    enabled
                      ? t("Could not turn on {{name}}", { name: plugin.name })
                      : t("Could not turn off {{name}}", { name: plugin.name }),
                    cause,
                  );
                },
              );
            }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1 ps-11">
        {offByAdmin ? (
          <StatusLine tone="off">{t("Your admin turned it off for now.")}</StatusLine>
        ) : plugin.userEnabled ? (
          connectionLines
        ) : null}
        {personal && plugin.userEnabled && !offByAdmin ? (
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
