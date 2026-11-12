// baskule: the account pages the app shows natively (password, usage, plugins). Connecting a
// plugin account needs the service's consent page, which only a browser can show.
import type { MemberPlugin } from "@t3tools/contracts/baskule-plugins";
import type { MyUsage, UsageWindowStatus } from "@t3tools/contracts/baskule-usage";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";

import { BaskuleApiError } from "../../baskule/api";
import { openBaskuleManagement } from "../../baskule/management";
import { changeBaskuleSessionPassword, useBaskuleSession } from "../../baskule/session";
import {
  disconnectPluginServer,
  fetchMemberPlugins,
  fetchMyUsage,
  setPluginOn,
  type SettingsSession,
} from "../../baskule/settings-api";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useLocale, useTranslation } from "../../i18n";
import { subscribeAppActive } from "../../lib/appState";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const errorText = (cause: unknown, fallback: string) =>
  cause instanceof BaskuleApiError ? cause.message : fallback;

function useSettingsSession(): SettingsSession | null {
  const session = useBaskuleSession();
  return session.status === "signed-in" && session.kind === "authenticated"
    ? { serverUrl: session.serverUrl, token: session.token }
    : null;
}

type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

/** Loads once per account and on `reload`; a reload keeps showing the last value. */
function useAccountData<T>(
  session: SettingsSession | null,
  load: (session: SettingsSession) => Promise<T>,
  fallback: string,
) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  // Only the latest request may publish; leaving the page or account invalidates it.
  const requestRef = useRef(0);
  const fetchFor = (target: SettingsSession) => {
    const request = ++requestRef.current;
    load(target).then(
      (value) => {
        if (requestRef.current === request) setState({ status: "ready", value });
      },
      (cause: unknown) => {
        if (requestRef.current === request)
          setState({ status: "error", message: errorText(cause, fallback) });
      },
    );
  };
  const startFetch = useEffectEvent(fetchFor);
  const serverUrl = session?.serverUrl;
  const token = session?.token;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches account data from the server for the signed-in session
  useEffect(() => {
    if (serverUrl === undefined || token === undefined) return;
    startFetch({ serverUrl, token });
    return () => {
      requestRef.current++;
    };
  }, [serverUrl, token]);
  return {
    state,
    reload: () => {
      if (!session) return;
      if (state.status === "error") setState({ status: "loading" });
      fetchFor(session);
    },
  };
}

function PageBody(props: { readonly children: React.ReactNode }) {
  return (
    <ScreenScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-6 px-5 pt-4"
    >
      {props.children}
    </ScreenScrollView>
  );
}

function Loading() {
  return (
    <View className="items-center py-10">
      <AppActivityIndicator colorClassName="accent-icon-muted" />
    </View>
  );
}

function LoadFailed(props: { readonly message: string; readonly onRetry: () => void }) {
  const t = useTranslation();
  return (
    <View className="gap-3">
      <ErrorBanner message={props.message} />
      <Button label={t("Try again")} onPress={props.onRetry} />
    </View>
  );
}

function SignedInOnly(props: { readonly title: string }) {
  const t = useTranslation();
  return (
    <SettingsScreen title={props.title}>
      <PageBody>
        <EmptyState
          variant="plain"
          title={t("Not available")}
          detail={t("Sign in with a personal account to use this page.")}
        />
      </PageBody>
    </SettingsScreen>
  );
}

export function SettingsPasswordRouteScreen() {
  const t = useTranslation();
  const session = useSettingsSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const savingRef = useRef(false);
  if (!session) return <SignedInOnly title={t("Change password")} />;

  const submit = () => {
    if (savingRef.current) return;
    if (current === "" || next === "") {
      setError(t("Enter your current and new password."));
      return;
    }
    if (next !== confirmation) {
      setError(t("The new passwords don't match."));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setDone(false);
    changeBaskuleSessionPassword({ currentPassword: current, newPassword: next })
      .then(() => {
        setCurrent("");
        setNext("");
        setConfirmation("");
        setDone(true);
      })
      .catch((cause: unknown) => setError(errorText(cause, t("Could not change the password."))))
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  };

  return (
    <SettingsScreen title={t("Change password")}>
      <PageBody>
        <Text className="text-sm text-foreground-muted">
          {t("Changing your password signs you out on your other devices.")}
        </Text>
        {error ? <ErrorBanner message={error} /> : null}
        {done ? (
          <Text className="text-sm font-t3-medium text-foreground">
            {t("Your password was changed.")}
          </Text>
        ) : null}
        <View className="gap-3">
          <ConnectionFormField
            label={t("Current password")}
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            editable={!saving}
          />
          <ConnectionFormField
            label={t("New password")}
            value={next}
            onChangeText={setNext}
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
            editable={!saving}
          />
          <ConnectionFormField
            label={t("Confirm new password")}
            value={confirmation}
            onChangeText={setConfirmation}
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={submit}
            editable={!saving}
          />
          <Button
            label={t("Change password")}
            tone="primary"
            fullWidth
            loading={saving}
            onPress={submit}
          />
        </View>
      </PageBody>
    </SettingsScreen>
  );
}

const WINDOW_NAMES = {
  daily: "Daily limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
} as const;

/** The share of the limit that runs out first: tokens and cost each block on their own. */
function windowShare(status: UsageWindowStatus): number {
  const shares = [
    status.limit.tokens === undefined
      ? null
      : status.limit.tokens === 0
        ? 1
        : status.used.tokens / status.limit.tokens,
    status.limit.costUsd === undefined
      ? null
      : status.limit.costUsd === 0
        ? 1
        : status.used.costUsd / status.limit.costUsd,
  ].filter((share): share is number => share !== null);
  return status.blocked ? Math.max(1, ...shares) : Math.max(0, ...shares);
}

function UsageLimit(props: { readonly status: UsageWindowStatus }) {
  const t = useTranslation();
  const locale = useLocale();
  const { status } = props;
  const share = windowShare(status);
  const amounts = [
    status.limit.tokens === undefined
      ? null
      : t("{{used}} of {{limit}} tokens", {
          used: formatTokens(status.used.tokens),
          limit: formatTokens(status.limit.tokens),
        }),
    status.limit.costUsd === undefined
      ? null
      : t("{{used}} of {{limit}}", {
          used: formatUsd(status.used.costUsd),
          limit: formatUsd(status.limit.costUsd),
        }),
  ].filter(Boolean);
  // Windows reset within a month, so month and day are never ambiguous without the year.
  const resets = new Date(status.resetsAt).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <View className="gap-2 px-4 py-3.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-base text-foreground">{t(WINDOW_NAMES[status.window])}</Text>
        <Text
          className={status.blocked ? "font-t3-bold text-danger" : "font-t3-medium text-foreground"}
        >
          {status.blocked
            ? t("Reached")
            : t("{{share}}% used", { share: Math.min(100, Math.floor(share * 100)) })}
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.min(100, Math.round(share * 100)) }}
        className="h-2 overflow-hidden rounded-full bg-subtle-strong"
      >
        <View
          className={status.blocked ? "h-full bg-danger" : "h-full bg-primary"}
          style={{ width: `${Math.min(100, share * 100)}%` }}
        />
      </View>
      <Text className="text-xs text-foreground-muted">
        {[...amounts, t("Resets {{time}}", { time: resets })].join(" · ")}
      </Text>
    </View>
  );
}

export function SettingsAccountUsageRouteScreen() {
  const t = useTranslation();
  const session = useSettingsSession();
  const { state, reload } = useAccountData<MyUsage>(
    session,
    fetchMyUsage,
    t("Could not load your usage."),
  );
  if (!session) return <SignedInOnly title={t("Usage and limits")} />;
  return (
    <SettingsScreen title={t("Usage and limits")}>
      <PageBody>
        {state.status === "loading" ? (
          <Loading />
        ) : state.status === "error" ? (
          <LoadFailed message={state.message} onRetry={reload} />
        ) : (
          <>
            <SettingsSection
              title={t("Limits")}
              footer={
                state.value.limits.length === 0
                  ? t("Your administrator has not set usage limits for you.")
                  : undefined
              }
            >
              {state.value.limits.map((status) => (
                <UsageLimit key={status.window} status={status} />
              ))}
            </SettingsSection>
            <SettingsSection title={t("Your usage")}>
              {(
                [
                  ["today", t("Today")],
                  ["week", t("This week")],
                  ["month", t("This month")],
                ] as const
              ).map(([key, label]) => (
                <SettingsRow
                  key={key}
                  icon="chart.bar.xaxis"
                  label={label}
                  valuePosition="trailing"
                  value={`${t("{{tokens}} tokens", { tokens: formatTokens(state.value.totals[key].tokens) })} · ${formatUsd(state.value.totals[key].costUsd)}`}
                />
              ))}
            </SettingsSection>
          </>
        )}
      </PageBody>
    </SettingsScreen>
  );
}

type MemberServer = MemberPlugin["servers"][number];

export function SettingsPluginsRouteScreen() {
  const t = useTranslation();
  const session = useSettingsSession();
  const { state, reload } = useAccountData<MemberPlugin[]>(
    session,
    fetchMemberPlugins,
    t("Could not load your plugins."),
  );
  const [busy, setBusy] = useState(false);
  // Android's browser call resolves once the tab opens, so returning to the app is what
  // reveals a new connection. While busy, the pending action reloads when it settles.
  const reloadOnReturn = useEffectEvent(() => {
    if (!busy) reload();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes sign-ins when the app returns from the browser consent page
  useEffect(() => subscribeAppActive(() => reloadOnReturn()), []);
  if (!session) return <SignedInOnly title={t("Plugins")} />;

  const mutate = (failure: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    work()
      .then(reload)
      .catch((cause: unknown) => Dialog.alert(failure, errorText(cause, t("Try again."))))
      .finally(() => setBusy(false));
  };
  // The service's consent page needs a browser; Settings → Plugins on the web starts it.
  const signInInBrowser = () =>
    Dialog.confirm({
      title: t("Sign in in the browser?"),
      message: t(
        "Sign in from Settings → Plugins in the browser, then close the browser to return here.",
      ),
      confirmText: t("Open browser"),
      onConfirm: () => {
        setBusy(true);
        void openBaskuleManagement("/settings/plugins")
          .catch((cause: unknown) =>
            Dialog.alert(
              t("Could not open the browser"),
              cause instanceof Error ? cause.message : t("Try again."),
            ),
          )
          .finally(() => {
            setBusy(false);
            reload();
          });
      },
    });
  const serverName = (plugin: MemberPlugin, server: MemberServer) =>
    plugin.servers.length === 1 ? plugin.displayName : server.name;
  const disconnect = (plugin: MemberPlugin, server: MemberServer) =>
    Dialog.confirm({
      title: t("Disconnect {{name}}?", { name: serverName(plugin, server) }),
      message: t("The assistant can no longer act as you there until you sign in again."),
      confirmText: t("Disconnect"),
      destructive: true,
      onConfirm: () =>
        mutate(t("Could not disconnect"), () =>
          disconnectPluginServer(session, { pluginId: plugin.id, serverId: server.id }),
        ),
    });
  const serverRow = (plugin: MemberPlugin, server: MemberServer) => {
    const name = serverName(plugin, server);
    switch (server.connection.state) {
      case "unavailable":
        return (
          <SettingsRow
            key={server.id}
            icon="exclamationmark.circle"
            label={name}
            value={t("Not ready yet, ask an administrator")}
            valuePosition="below"
          />
        );
      case "not_connected":
        return (
          <SettingsRow
            key={server.id}
            icon="link"
            label={t("Sign in to {{name}}", { name })}
            value={t("In the browser")}
            disabled={busy}
            onPress={signInInBrowser}
          />
        );
      case "expired":
        return (
          <SettingsRow
            key={server.id}
            icon="exclamationmark.triangle"
            label={t("Reconnect {{name}}", { name })}
            value={t("Your sign-in expired")}
            valuePosition="below"
            disabled={busy}
            onPress={signInInBrowser}
          />
        );
      case "connected":
        return (
          <SettingsRow
            key={server.id}
            icon="person.crop.circle"
            label={server.connection.account ?? name}
            value={t("Connected")}
            disabled={busy}
            onPress={() => disconnect(plugin, server)}
          />
        );
      case "not_required":
        return null;
    }
  };

  return (
    <SettingsScreen title={t("Plugins")}>
      <PageBody>
        {state.status === "loading" ? (
          <Loading />
        ) : state.status === "error" ? (
          <LoadFailed message={state.message} onRetry={reload} />
        ) : state.value.length === 0 ? (
          <EmptyState
            variant="plain"
            title={t("No plugins yet")}
            detail={t("Plugins an administrator lets you use appear here.")}
          />
        ) : (
          <>
            {state.value.map((plugin) => (
              <SettingsSection
                key={plugin.id}
                title={plugin.displayName}
                footer={
                  plugin.enabled ? plugin.description || undefined : t("Paused by an administrator")
                }
              >
                <SettingsSwitchRow
                  icon="bolt.circle"
                  label={t("Use {{name}}", { name: plugin.displayName })}
                  value={plugin.on}
                  disabled={busy || !plugin.enabled}
                  onValueChange={(on) =>
                    mutate(t("Could not change the plugin"), () =>
                      setPluginOn(session, { pluginId: plugin.id, on }),
                    )
                  }
                />
                {plugin.enabled ? plugin.servers.map((server) => serverRow(plugin, server)) : null}
              </SettingsSection>
            ))}
            {state.value.some((plugin) =>
              plugin.servers.some((server) => server.connection.state !== "not_required"),
            ) ? (
              <Text textRole="footnote" className="px-4 text-foreground-muted">
                {t(
                  "Plugins you sign in to act as you, also in team spaces: each person's chats use their own sign-in.",
                )}
              </Text>
            ) : null}
          </>
        )}
      </PageBody>
    </SettingsScreen>
  );
}
