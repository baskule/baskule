import { languageReady, refreshLanguage } from "./languagePreferences";
import { useLocale } from "./i18n";
import { PermissionUpdateNotice } from "./features/connection/PermissionUpdateNotice";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { AppState, Modal, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation } from "@react-navigation/native";
import { RegistryContext } from "@effect/atom-react";
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
import { isConnectAppLink, shouldHandleAppLink } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { useUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { VoiceInputProvider } from "./features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";
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
  filter: shouldHandleAppLink,
};

const Navigation = createStaticNavigation(RootStack);

function SplashScreenCoordinator() {
  const [languageLoaded, setLanguageLoaded] = useState(false);
  useEffect(() => {
    void languageReady.then(() => setLanguageLoaded(true));
  }, []);
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady && languageLoaded) void SplashScreen.hide();
  }, [isReady, languageLoaded]);

  return null;
}

export default function App() {
  useLocale();
  useUiRuntimeMemoryWarningGc();
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshLanguage();
    });
    return () => subscription.remove();
  }, []);
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );

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
  useEffect(() => {
    let active = true;
    let received = false;
    let id = 0;
    const receive = (url: string) => {
      received = true;
      if (isConnectAppLink(url)) setConnectionRequest({ url, id: ++id });
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
  useEffect(() => {
    void loadBaskuleSession();
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

      <PermissionUpdateNotice />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <VoiceInputProvider>
              <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
              {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
              <GlobalVoiceInputControl>
                <NativeLayoutMetricsProvider>
                  {session.status === "signed-in" ? (
                    <IncomingShareProvider>
                      <Navigation
                        key={`${session.serverUrl} ${session.me.user.id}`}
                        linking={appLinking}
                        theme={navigationTheme}
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
                </NativeLayoutMetricsProvider>
              </GlobalVoiceInputControl>
              {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
              <OverlayPortalHost />
            </VoiceInputProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
