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
  disconnectPluginAccount,
  fetchMemberPlugins,
  fetchMyUsage,
  updatePluginAccount,
  type SettingsSession,
} from "../../baskule/settings-api";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { t, useLocale, useTranslation } from "../../i18n";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsRow } from "./components/SettingsRow";
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
  const resets = new Date(status.resetsAt).toLocaleString(locale, {
    weekday: "short",
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

function pluginStatusText(status: MemberPlugin["status"], name: string) {
  switch (status) {
    case "unavailable":
      return t("Not available to you");
    case "needs_setup":
      return t("Your administrator needs to finish setting it up");
    case "connect":
      return t("Connect your {{name}} account", { name });
    case "reconnect":
      return t("Reconnect your {{name}} account", { name });
    case "ready":
      return t("Ready");
  }
}

export function SettingsPluginsRouteScreen() {
  const t = useTranslation();
  const session = useSettingsSession();
  const { state, reload } = useAccountData<MemberPlugin[]>(
    session,
    fetchMemberPlugins,
    t("Could not load your plugins."),
  );
  const [busy, setBusy] = useState(false);
  if (!session) return <SignedInOnly title={t("Plugins and accounts")} />;

  const mutate = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    work()
      .then(reload)
      .catch((cause: unknown) =>
        Dialog.alert(t("Could not update the account"), errorText(cause, t("Try again."))),
      )
      .finally(() => setBusy(false));
  };
  const connectInBrowser = () =>
    Dialog.confirm({
      title: t("Connect in the browser?"),
      message: t(
        "The service asks for your consent in the browser. Connect the account there, then close the browser to return here.",
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
  const accountActions = (
    plugin: MemberPlugin,
    account: MemberPlugin["servers"][number]["accounts"][number],
    others: number,
  ) => {
    const rename = () =>
      Dialog.prompt({
        title: t("Rename account"),
        initialValue: account.label,
        confirmText: t("Save"),
        onConfirm: (value) => {
          const label = value.trim();
          if (label === "" || label === account.label) return;
          mutate(() =>
            updatePluginAccount(session, {
              pluginId: plugin.id,
              accountId: account.id,
              patch: { label },
            }),
          );
        },
      });
    const disconnect = () => {
      if (account.default && others > 0) {
        Dialog.alert(
          t("Choose another default first"),
          t("Make another account your default before you disconnect this one."),
        );
        return;
      }
      Dialog.confirm({
        title: t("Disconnect {{label}}?", { label: account.label }),
        message: t("The assistant can no longer use this account."),
        confirmText: t("Disconnect"),
        destructive: true,
        onConfirm: () =>
          mutate(() =>
            disconnectPluginAccount(session, { pluginId: plugin.id, accountId: account.id }),
          ),
      });
    };
    Dialog.alert(account.label, undefined, [
      ...(account.default || others === 0
        ? []
        : [
            {
              text: t("Make default"),
              onPress: () =>
                mutate(() =>
                  updatePluginAccount(session, {
                    pluginId: plugin.id,
                    accountId: account.id,
                    patch: { default: true },
                  }),
                ),
            },
          ]),
      { text: t("Rename"), onPress: rename },
      { text: t("Disconnect"), style: "destructive" as const, onPress: disconnect },
      { text: t("Cancel"), style: "cancel" as const },
    ]);
  };

  return (
    <SettingsScreen title={t("Plugins and accounts")}>
      <PageBody>
        {state.status === "loading" ? (
          <Loading />
        ) : state.status === "error" ? (
          <LoadFailed message={state.message} onRetry={reload} />
        ) : state.value.length === 0 ? (
          <EmptyState
            variant="plain"
            title={t("No plugins yet")}
            detail={t("Plugins your administrator adds to your spaces appear here.")}
          />
        ) : (
          state.value.map((plugin) => {
            const oauthServers = plugin.servers.filter(
              (server) => server.credential === "user-oauth",
            );
            const needsConnection = oauthServers.some(
              (server) => server.status === "connect" || server.status === "reconnect",
            );
            return (
              <SettingsSection
                key={plugin.id}
                title={plugin.name}
                footer={pluginStatusText(plugin.status, plugin.name)}
              >
                {plugin.description ? (
                  <Text className="px-4 py-3 text-sm text-foreground-muted">
                    {plugin.description}
                  </Text>
                ) : null}
                {oauthServers.flatMap((server) =>
                  server.accounts.map((account) => (
                    <SettingsRow
                      key={`${server.name}:${account.id}`}
                      icon="person.crop.circle"
                      label={account.label}
                      disabled={busy}
                      value={[
                        account.default ? t("Default") : null,
                        account.status === "reconnect" ? t("Needs reconnecting") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      onPress={() => accountActions(plugin, account, server.accounts.length - 1)}
                    />
                  )),
                )}
                {oauthServers.length > 0 ? (
                  <SettingsRow
                    icon="link"
                    label={
                      needsConnection
                        ? t("Connect in browser")
                        : t("Connect another account in browser")
                    }
                    disabled={busy}
                    onPress={connectInBrowser}
                  />
                ) : null}
              </SettingsSection>
            );
          })
        )}
      </PageBody>
    </SettingsScreen>
  );
}
