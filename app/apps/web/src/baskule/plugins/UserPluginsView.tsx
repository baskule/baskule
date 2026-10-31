// baskule: Settings → Plugins, for every person: the plugins their groups give them, what each
// needs before it works, and the accounts they connect. People never add plugins; the admin does.
import type { Account, MemberPlugin, PluginStatus } from "@t3tools/contracts/baskule-plugins";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  EllipsisIcon,
  LinkIcon,
  PlusIcon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { ResourceState } from "../admin/ResourceState";
import { confirmAction, useApiResource } from "../ui";
import { PageMessage, PageSection } from "../views/BaskulePage";
import { AccountDialog, type AccountDialogRequest } from "./AccountDialog";
import {
  accountConnectionUrl,
  notifyPluginError,
  pluginErrorCodeText,
  pluginsApi,
  type AccountConnection,
} from "./api";
import { PluginIcon } from "./PluginParts";
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
          <UserPluginRow key={plugin.id} plugin={plugin} onChanged={data.reload} />
        ))}
      </PageSection>
      {plugins.some(
        (plugin) =>
          plugin.status !== "unavailable" &&
          plugin.servers.some((server) => server.credential === "user-oauth"),
      ) ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {t(
            "Plugins that use your account act as you. In a team space, only your default account is used, and only if the space owner allows it. Everyone in that space can see the results.",
          )}
        </p>
      ) : null}
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

type Server = MemberPlugin["servers"][number];

export function UserPluginRow({
  plugin,
  onChanged,
}: {
  readonly plugin: MemberPlugin;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AccountDialogRequest | null>(null);
  const blocked = plugin.status === "unavailable" || plugin.status === "needs_setup";
  const ownServers = plugin.servers.filter((server) => server.credential === "user-oauth");
  // With several servers, each account is named by its server.
  const accountName = (server: string) => (plugin.servers.length > 1 ? server : plugin.name);

  const connect = (server: string, target: AccountConnection) => {
    setBusy(target.type === "new" ? `connect:${server}` : `reconnect:${target.account}`);
    window.location.assign(accountConnectionUrl(plugin.id, server, "/settings/plugins", target));
  };

  /** Sends one account change and shows its outcome before the dialog closes. */
  const change = (key: string, failure: string, send: () => Promise<unknown>) => {
    setBusy(key);
    return (async () => {
      await send();
      await onChanged();
      setDialog(null);
    })()
      .catch((cause: unknown) => {
        notifyPluginError(failure, cause);
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const addAccount = (server: Server) =>
    setDialog({
      type: "name",
      title:
        server.accounts.length === 0
          ? statusText("connect", accountName(server.name))
          : t("Add another {{name}} account", { name: accountName(server.name) }),
      action: t("Connect account"),
      label: server.accounts.length === 0 ? plugin.name.slice(0, 100) : "",
      taken: server.accounts.map((account) => account.label),
      submit: (label) => connect(server.name, { type: "new", label }),
    });

  const rename = (server: Server, account: Account) =>
    setDialog({
      type: "name",
      title: t("Rename {{name}}", { name: account.label }),
      action: t("Save"),
      label: account.label,
      taken: server.accounts.filter((other) => other !== account).map((other) => other.label),
      submit: (label) =>
        void change(`rename:${account.id}`, t("Could not rename the account"), () =>
          pluginsApi.updateAccount(plugin.id, account.id, { label }),
        ),
    });

  const makeDefault = (account: Account) =>
    change(`default:${account.id}`, t("Could not change your default account"), () =>
      pluginsApi.updateAccount(plugin.id, account.id, { default: true }),
    );

  const disconnect = async (server: Server, account: Account) => {
    const others = server.accounts.filter((other) => other !== account);
    const send = (newDefault?: string) =>
      change(`disconnect:${account.id}`, t("Could not disconnect your account"), () =>
        pluginsApi.disconnectAccount(plugin.id, account.id, newDefault),
      );
    if (account.default && others.length > 0) {
      setDialog({
        type: "replace",
        account,
        others,
        submit: (newDefault) => void send(newDefault),
      });
      return;
    }
    const confirmed = await confirmAction(
      `${t("Disconnect {{name}}?", { name: account.label })}\n${
        others.length === 0
          ? t("{{name}} stops working for you until you connect an account again.", {
              name: accountName(server.name),
            })
          : t("The assistant can no longer use it. Your default account stays connected.")
      }`,
      "destructive",
    );
    if (confirmed) await send();
  };

  const connectActions = blocked
    ? []
    : ownServers
        .filter((server) => server.accounts.length === 0)
        .map((server) => (
          <Button
            key={server.name}
            size="xs"
            variant="outline"
            aria-label={statusText("connect", accountName(server.name))}
            disabled={busy !== null}
            onClick={() => addAccount(server)}
          >
            {busy === `connect:${server.name}` ? <Spinner size="sm" /> : null}
            {t("Connect")}
          </Button>
        ));
  const worst = plugin.servers.find((server) => server.status === plugin.status);

  return (
    <div className={cn("flex items-start gap-3 px-3 py-3 sm:px-4", blocked && "opacity-70")}>
      <PluginIcon contents={contentsKind(plugin)} icon={plugin.icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{plugin.name}</span>
          <StatusLine
            status={plugin.status}
            action={
              connectActions.length > 0 ? (
                <span className="flex gap-1.5">{connectActions}</span>
              ) : null
            }
          >
            {statusText(plugin.status, accountName(worst?.name ?? plugin.name))}
          </StatusLine>
        </div>
        {plugin.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{plugin.description}</span>
        ) : null}
        {ownServers
          .filter((server) => server.accounts.length > 0)
          .map((server) => (
            <div key={server.name} className="flex flex-col items-start pt-1">
              {plugin.servers.length > 1 ? (
                <span className="text-xs text-muted-foreground">{server.name}</span>
              ) : null}
              <ul
                aria-label={t("Your {{name}} accounts", { name: accountName(server.name) })}
                className="flex flex-col self-stretch"
              >
                {server.accounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0">
                      <UserRoundIcon aria-hidden className="text-muted-foreground" />
                      <span className="min-w-0 truncate text-foreground">{account.label}</span>
                      {account.default ? (
                        <Badge variant="outline" size="sm">
                          {t("Default")}
                        </Badge>
                      ) : null}
                      {account.status === "reconnect" ? (
                        <span className="shrink-0 text-warning-foreground">
                          {t("Needs reconnecting")}
                        </span>
                      ) : null}
                    </span>
                    <span className="ms-auto flex shrink-0 items-center gap-1">
                      {busy?.endsWith(`:${account.id}`) ? <Spinner size="sm" tone="muted" /> : null}
                      {account.status === "reconnect" && !blocked ? (
                        <Button
                          size="xs"
                          variant="outline"
                          aria-label={t("Reconnect {{name}}", { name: account.label })}
                          disabled={busy !== null}
                          onClick={() =>
                            connect(server.name, { type: "reconnect", account: account.id })
                          }
                        >
                          {t("Reconnect")}
                        </Button>
                      ) : null}
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={t("Options for {{name}}", { name: account.label })}
                              disabled={busy !== null}
                            />
                          }
                        >
                          <EllipsisIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          {account.default ? null : (
                            <MenuItem onClick={() => void makeDefault(account)}>
                              {t("Make default")}
                            </MenuItem>
                          )}
                          <MenuItem onClick={() => rename(server, account)}>
                            {t("Rename…")}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            variant="destructive"
                            onClick={() => void disconnect(server, account)}
                          >
                            {t("Disconnect…")}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </span>
                  </li>
                ))}
              </ul>
              {blocked ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={t("Add another {{name}} account", {
                    name: accountName(server.name),
                  })}
                  disabled={busy !== null}
                  onClick={() => addAccount(server)}
                >
                  <PlusIcon aria-hidden />
                  {t("Add another account")}
                </Button>
              )}
            </div>
          ))}
      </div>
      <AccountDialog request={dialog} busy={busy !== null} onClose={() => setDialog(null)} />
    </div>
  );
}
