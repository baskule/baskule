import { useTranslation } from "../../i18n";
import { Toolbar } from "../../components/ui/Toolbar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
// baskule: settings are reduced to the server connection plus a few app pages (scope: no settings).
import { BASKULE_FLAGS } from "../../baskule/flags";
import { signOutOfBaskule, useBaskuleSession } from "../../baskule/session";
import * as Dialog from "../../components/ui/Dialog";
import { useState } from "react";
import type { BaskuleManagementDestination } from "@t3tools/contracts/baskule";
import { openBaskuleManagement } from "../../baskule/management";

export function SettingsRouteScreen() {
  const t = useTranslation();
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions options={{ headerBackVisible: !layout.usesSplitView }} />
      ) : null}
      {Platform.OS === "ios" && layout.usesSplitView ? (
        <>
          <Toolbar placement="left">
            <Toolbar.Button
              accessibilityLabel={t("Go back")}
              icon="chevron.left"
              onPress={() => navigation.goBack()}
            />
          </Toolbar>
        </>
      ) : null}
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen title={t("Settings")} trailing={<AndroidSettingsEnvironmentFilter />}>
          {content}
        </SettingsScreen>
      ) : (
        content
      )}
    </>
  );
}

function ConfiguredSettingsRouteScreen() {
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountLabel = !isLoaded
    ? "Checking"
    : !isSignedIn
      ? "Sign in"
      : (user?.primaryEmailAddress?.emailAddress ?? "Signed in");

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={t("Connections")}>
          <SettingsRow
            icon="person.crop.circle"
            label={t("T3 Account")}
            value={accountLabel}
            disabled={!isLoaded}
            onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
          />
          <SettingsRow
            icon="desktopcomputer"
            label={t("Environments")}
            value={`${Object.keys(savedConnectionsById).length}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
          <SettingsRow
            icon="bell.badge"
            label={t("Notifications")}
            target="SettingsNotifications"
          />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <BaskuleAccountSection spaceCount={environmentCount} />

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function SettingsIndexSections() {
  return BASKULE_FLAGS.extendedSettings ? (
    <UpstreamSettingsIndexSections />
  ) : (
    <BaskuleSettingsIndexSections />
  );
}

// baskule: the account (server, person, spaces) and sign-out. The server address is chosen on the
// sign-in screen: a session belongs to one server, so changing it means signing out first.
function BaskuleAccountSection(props: { readonly spaceCount: number }) {
  const t = useTranslation();
  const session = useBaskuleSession();
  if (session.status !== "signed-in") return null;
  const me = session.me;
  const anonymous = me?.authentication.mode === "anonymous";
  return (
    <SettingsSection title={t("Account")}>
      <SettingsRow
        icon="person.crop.circle"
        label={me?.user.name ?? t("Signed in")}
        value={
          anonymous
            ? t("Shared test workspace")
            : me
              ? `${me.user.email}${me.user.role === "admin" ? ` · ${t("admin")}` : ""}`
              : undefined
        }
      />
      <SettingsRow
        icon="server.rack"
        label={me?.organization.name ?? t("Server")}
        value={session.serverUrl}
      />
      <SettingsRow
        icon="desktopcomputer"
        label={t("Spaces")}
        value={`${props.spaceCount}`}
        valuePosition="trailing"
        target="SettingsEnvironments"
      />
      <SettingsRow
        icon="arrow.right"
        label={anonymous ? t("Disconnect") : t("Sign out")}
        onPress={() =>
          Dialog.confirm({
            title: anonymous ? t("Disconnect?") : t("Sign out?"),
            message: anonymous
              ? t("Return to server selection. The shared workspace stays on the server.")
              : t("This phone forgets your session. Your chats stay on the server."),
            confirmText: anonymous ? t("Disconnect") : t("Sign out"),
            destructive: true,
            onConfirm: () => void signOutOfBaskule(),
          })
        }
      />
    </SettingsSection>
  );
}

function BaskuleSettingsIndexSections() {
  const t = useTranslation();
  const session = useBaskuleSession();
  const [opening, setOpening] = useState(false);
  const open = (destination: BaskuleManagementDestination) =>
    Dialog.confirm({
      title: t("Open in browser?"),
      message: t(
        "Manage your Baskule account in the browser. It signs in independently and stays signed in when you sign out of this phone.",
      ),
      confirmText: t("Open browser"),
      onConfirm: () => {
        setOpening(true);
        void openBaskuleManagement(destination)
          .catch((error: unknown) =>
            Dialog.alert(
              t("Could not open settings"),
              error instanceof Error ? error.message : t("Try again."),
            ),
          )
          .finally(() => setOpening(false));
      },
    });
  return (
    <>
      <SettingsSection title={t("Manage in browser")}>
        <SettingsRow
          icon="person.crop.circle"
          label={t("Account and password")}
          disabled={opening}
          onPress={() => open("/settings/account")}
        />
        <SettingsRow
          icon="desktopcomputer"
          label={t("Manage spaces")}
          disabled={opening}
          onPress={() => open("/settings/spaces")}
        />
        <SettingsRow
          icon="link"
          label={t("Plugins and connected accounts")}
          disabled={opening}
          onPress={() => open("/settings/plugins")}
        />
        <SettingsRow
          icon="chart.bar.xaxis"
          label={t("Usage and limits")}
          disabled={opening}
          onPress={() => open("/settings/usage")}
        />
        {session.status === "signed-in" && session.me?.user.role === "admin" ? (
          <SettingsRow
            icon="gearshape"
            label={t("Administration")}
            disabled={opening}
            onPress={() => open("/admin")}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title={t("Chats")}>
        <SettingsRow icon="archivebox" label={t("Archived chats")} target="SettingsArchive" />
        <SettingsRow icon="clock" label={t("Scheduled tasks")} target="SettingsScheduledTasks" />
        <SettingsRow icon="bell.badge" label={t("Notifications")} target="SettingsNotifications" />
      </SettingsSection>
      <SettingsSection title={t("App")}>
        <SettingsRow icon="gearshape" label={t("General")} target="SettingsAppearance" />
        <SettingsRow icon="info.circle" label={t("About")} target="SettingsAbout" />
      </SettingsSection>
    </>
  );
}

function UpstreamSettingsIndexSections() {
  const t = useTranslation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  return (
    <>
      <SettingsSection title={t("Interface")}>
        <SettingsRow icon="paintbrush" label={t("Appearance")} target="SettingsAppearance" />
        {Platform.OS === "ios" ? (
          <>
            <SettingsRow icon="keyboard" label={t("Keyboard")} target="SettingsKeyboard" />
            <SettingsRow icon="mic" label={t("Microphone")} target="SettingsMicrophone" />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("Automations")}>
        <SettingsRow icon="clock" label={t("Scheduled tasks")} target="SettingsScheduledTasks" />
      </SettingsSection>

      <SettingsSection title={t("Projects & threads")}>
        {selectedProjectKey !== null ? (
          <SettingsRow
            icon="folder"
            label={t("Overview")}
            value={projectLabel}
            target="SettingsProjectOverview"
          />
        ) : null}
        <SettingsRow icon="folder" label={t("Organization")} target="SettingsOrganization" />
        <SettingsRow icon="text.bubble" label={t("Thread behavior")} target="SettingsThreads" />
        <SettingsRow icon="arrow.turn.left.up" label={t("Follow-ups")} target="SettingsFollowUp" />
        <SettingsRow icon="archivebox" label={t("Archived Threads")} target="SettingsArchive" />
      </SettingsSection>

      <SettingsSection title={t("Server settings")}>
        <SettingsRow
          icon="person.crop.circle"
          label={t("Provider accounts")}
          target="SettingsProviderAccounts"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.bubble"
          label={t("New threads")}
          target="SettingsEnvironmentNewThreads"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.triangle.branch"
          label={t("Source control")}
          target="SettingsEnvironmentSourceControl"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.alignleft"
          label={t("Agent behavior")}
          target="SettingsEnvironmentAgentBehavior"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.clockwise"
          label={t("Maintenance")}
          target="SettingsEnvironmentMaintenance"
          disabled={noServerTargets}
        />
      </SettingsSection>

      <SettingsSection title={t("App")}>
        <SettingsRow icon="chart.bar.xaxis" label={t("Usage")} target="SettingsUsage" />
        <SettingsRow icon="info.circle" label={t("About Baskule")} target="SettingsAbout" />
      </SettingsSection>
    </>
  );
}
