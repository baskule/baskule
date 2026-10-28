import { languageReady, refreshLanguage } from "./languagePreferences";
import { useLocale } from "./i18n";
import { installPermissionUpdateNotice } from "./features/connection/permissionUpdateNotice";
import { installComposerAttachmentUploads } from "./state/composer-attachment-uploads";
import { installThreadOutboxDelivery } from "./state/threadOutboxDelivery";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { AppState, Modal, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  createStaticNavigation,
  getActionFromState,
  getStateFromPath,
  type NavigationState,
} from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ProjectChipIconRasterizer } from "./native/ProjectChipIconImages";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import * as Dialog from "./components/ui/Dialog";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { subscribeComposerDraftModelReconciliation } from "./state/use-composer-drafts";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import { isConnectAppLink, shouldHandleAppLink, restoreDraftLinkState } from "./lib/appLinking";
import { hasCloudPublicConfig } from "./features/cloud/publicConfig";
import { takeScheduledTaskNewLink } from "./features/settings/scheduled-task-editor-state";
import {
  disposeOnFoundationReplace,
  type FoundationHotModule,
} from "./lib/foundation-fast-refresh";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { installUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import { restoreSettingsLinkState } from "./features/settings/settings-navigation";
import {
  hydrateWorkspaceSelections,
  launchWorkspaceURL,
  recordWorkspaceSelections,
  settingsLinkPage,
} from "./features/workspace/workspace-selection-store";
import { workspaceDetailLinkAction } from "./features/workspace/workspace-detail-selection";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";
import { attachRootNavigation, rootNavigationRef } from "./lib/rootNavigation";
import { pruneNewTaskBranchCheckouts } from "./features/threads/NewTaskDraftRouteScreen";
import { BaskuleLoginScreen } from "./baskule/BaskuleLoginScreen";
import {
  loadBaskuleSession,
  readBaskuleSession,
  subscribeBaskuleSession,
  useBaskuleSession,
} from "./baskule/session";
import {
  setBaskulePushSession,
  startBaskulePushRegistration,
} from "./features/agent-awareness/baskuleRegistration";
import "../global.css";
// baskule: sign-in gate (Better Auth bearer); the spaces become environments once signed in.

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {});
void hydrateWorkspaceSelections();
void loadBaskuleSession();

const appLinking = {
  prefixes: [
    Linking.createURL("/"),
    "baskule://",
    "baskule-dev://",
    "baskule-preview://",
    "t3code://",
    "t3code-dev://",
    "t3code-preview://",
  ],
  config: { initialRouteName: "Home" },
  filter: (url: string) => shouldHandleAppLink(url, hasCloudPublicConfig()),
  getInitialURL: async () => (await Linking.getInitialURL()) ?? (await launchWorkspaceURL()),
  getActionFromState: (
    state: Parameters<typeof getActionFromState>[0],
    options: Parameters<typeof getActionFromState>[1],
  ): ReturnType<typeof getActionFromState> =>
    // Our router handles the selection; React Navigation's type only lists its own actions.
    (workspaceDetailLinkAction(state) as ReturnType<typeof getActionFromState>) ??
    getActionFromState(state, options),
  getStateFromPath: (path: string, options: Parameters<typeof getStateFromPath>[1]) =>
    takeScheduledTaskNewLink(
      restoreSettingsLinkState(
        restoreDraftLinkState(getStateFromPath(path, options), path),
        settingsLinkPage(),
      ),
    ),
};

const Navigation = createStaticNavigation(RootStack);

function handleNavigationStateChange(state: NavigationState | undefined): void {
  recordWorkspaceSelections(state);
  if (state) pruneNewTaskBranchCheckouts(state);
}

function handleNavigationReady(): void {
  handleNavigationStateChange(rootNavigationRef.getRootState());
}

declare const module: { readonly hot?: FoundationHotModule } | undefined;

function installLanguageRefresh(): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") void refreshLanguage();
  });
  return () => subscription.remove();
}

const appServiceDisposers = [
  installUiRuntimeMemoryWarningGc(),
  subscribeComposerDraftModelReconciliation({
    registry: appAtomRegistry,
    threadShellAtom: environmentThreadShells.threadShellAtom,
    threadRefsAtom: environmentThreadShells.threadRefsAtom,
    shellStateAtom: environmentShell.stateAtom,
  }),
  installLanguageRefresh(),
  installPermissionUpdateNotice(),
  installThreadOutboxDelivery(),
  installComposerAttachmentUploads(),
];
disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () => {
  for (const dispose of appServiceDisposers) dispose();
});

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void languageReady.then(() => SplashScreen.hide());
  }, [isReady]);

  return null;
}

export default function App() {
  useLocale();

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <AppContent />
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const session = useBaskuleSession();
  useEffect(() => {
    const stop = startBaskulePushRegistration();
    const sync = () => {
      const current = readBaskuleSession();
      void setBaskulePushSession(
        current.status === "signed-in" && current.kind === "authenticated"
          ? { serverUrl: current.serverUrl, token: current.token, userId: current.me.user.id }
          : null,
      );
    };
    const unsubscribe = subscribeBaskuleSession(sync);
    sync();
    return () => {
      unsubscribe();
      stop();
    };
  }, []);
  const [connectionRequest, setConnectionRequest] = useState<{ url: string; id: number } | null>(
    null,
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- Connection URLs arrive from the native Linking subscription.
  useEffect(() => {
    let active = true;
    let received = false;
    let id = 0;
    const receive = (url: string) => {
      received = true;
      if (isConnectAppLink(url)) {
        id = id + 1;
        setConnectionRequest({ url, id });
      }
    };
    const subscription = Linking.addEventListener("url", ({ url }) => receive(url));
    void Linking.getInitialURL()
      .then((url) => {
        if (active && !received && url) receive(url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  const navigationTheme = useMobileNavigationTheme();

  const connectionScreen =
    session.status !== "loading" ? (
      <BaskuleLoginScreen
        key={connectionRequest?.id ?? "manual"}
        serverUrl={session.serverUrl}
        openedUrl={connectionRequest?.url ?? null}
        switching={session.status === "signed-in"}
        onCancel={() => setConnectionRequest(null)}
        onConnected={() => setConnectionRequest(null)}
        {...(session.status === "signed-out" && session.notice ? { notice: session.notice } : {})}
      />
    ) : null;

  return (
    <>
      <SplashScreenCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
            {/* native-stack needs the theme's dark flag to select dark native headers. */}
            <GlobalVoiceInputControl>
              <NativeLayoutMetricsProvider>
                {session.status === "signed-in" ? (
                  <IncomingShareProvider>
                    <Navigation
                      key={`${session.serverUrl} ${session.me.user.id}`}
                      ref={attachRootNavigation}
                      linking={appLinking}
                      onReady={handleNavigationReady}
                      theme={navigationTheme}
                      onStateChange={handleNavigationStateChange}
                    />
                  </IncomingShareProvider>
                ) : (
                  !connectionRequest && connectionScreen
                )}
                {session.status !== "loading" && connectionRequest ? (
                  <Modal visible onRequestClose={() => setConnectionRequest(null)}>
                    {connectionScreen}
                  </Modal>
                ) : null}
                <Dialog.Host />
                <ThreadArrangementHost />
                <ProjectChipIconRasterizer />
              </NativeLayoutMetricsProvider>
            </GlobalVoiceInputControl>
            <OverlayPortalHost />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
