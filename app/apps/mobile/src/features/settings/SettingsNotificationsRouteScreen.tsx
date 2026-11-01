import { useTranslation } from "../../i18n";
import * as Dialog from "../../components/ui/Dialog";
import { useState, useSyncExternalStore } from "react";
import * as Notifications from "expo-notifications";
import type { PushPreferences } from "@t3tools/contracts/baskulePush";
import { Linking } from "react-native";

import { useBaskuleSession } from "../../baskule/session";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import {
  getBaskulePushState,
  getBaskulePushPreferences,
  refreshBaskulePush,
  subscribeBaskulePush,
  updateBaskulePushPreferences,
} from "../agent-awareness/baskuleRegistration";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

async function savePushPreferences(
  update: (previous: PushPreferences) => PushPreferences,
  requestPermission: boolean,
) {
  if (requestPermission) await Notifications.requestPermissionsAsync();
  await updateBaskulePushPreferences(update);
}

export function SettingsNotificationsRouteScreen() {
  const t = useTranslation();
  const session = useBaskuleSession();
  const anonymous = session.status === "signed-in" && session.kind === "anonymous";
  const state = useSyncExternalStore(
    subscribeBaskulePush,
    getBaskulePushState,
    getBaskulePushState,
  );
  const preferences = getBaskulePushPreferences();
  const [busy, setBusy] = useState(false);
  const save = async (
    update: (previous: PushPreferences) => PushPreferences,
    requestPermission = false,
  ) => {
    setBusy(true);
    await savePushPreferences(update, requestPermission)
      .catch(() => {
        Dialog.alert(t("Notifications unavailable"), t("Could not update notification settings."));
      })
      .finally(() => setBusy(false));
  };
  const enable = () => save((previous) => ({ ...previous, notificationsEnabled: true }), true);
  return (
    <SettingsScreen title={t("Notifications")}>
      <ScreenScrollView contentContainerClassName="gap-6 px-5 pt-4">
        <Text className="text-base text-foreground-muted">
          {anonymous
            ? t(
                "Background notifications require a personal sign-in. Shared anonymous workspaces do not support them.",
              )
            : state.status === "registered"
              ? t("This device is registered for agent notifications.")
              : (state.reason ??
                t("Connect to your server and enable notifications to receive agent updates."))}
        </Text>
        <SettingsSection title={t("Agent notifications")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={t("Device Notifications")}
            value={state.status === "registered"}
            disabled={busy || state.status === "signed-out" || state.status === "checking"}
            onValueChange={(enabled) => {
              if (enabled) void enable();
              else void save((previous) => ({ ...previous, notificationsEnabled: false }));
            }}
          />
          {(
            [
              ["notifyOnApproval", "Approval requests"],
              ["notifyOnInput", "Input requests"],
              ["notifyOnCompletion", "Completed tasks"],
              ["notifyOnFailure", "Failed tasks"],
            ] as const
          ).map(([key, label]) => (
            <SettingsSwitchRow
              key={key}
              icon="bell.badge"
              label={t(label)}
              value={preferences[key]}
              disabled={busy || state.status === "signed-out"}
              onValueChange={(enabled) =>
                void save((previous) => ({ ...previous, [key]: enabled }))
              }
            />
          ))}
          <SettingsRow
            icon="bell.badge"
            disabled={busy || state.status === "signed-out" || state.status === "checking"}
            label={
              busy
                ? t("Checking notifications")
                : state.status === "registered"
                  ? t("Refresh registration")
                  : t("Enable notifications")
            }
            onPress={() => {
              if (!busy) {
                if (state.status === "registered") void refreshBaskulePush();
                else void enable();
              }
            }}
          />
          <SettingsRow
            icon="gearshape"
            label={t("System notification settings")}
            onPress={() => void Linking.openSettings()}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
