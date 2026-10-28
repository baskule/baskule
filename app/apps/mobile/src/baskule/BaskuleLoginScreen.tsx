import type { BaskuleAuthConfig } from "@t3tools/contracts/baskule";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTranslation } from "../i18n";
import { LanguageSetting } from "../features/settings/LanguageSetting";

import { BaskuleWordmark } from "../components/BaskuleBrand";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { ConnectionFormField } from "../features/connection/ConnectionFormField";
import { fetchInstance, BaskuleApiError, pollBrowserLogin, requestBrowserLogin } from "./api";
import { parseConnectTarget, type ConnectTarget } from "./config";
import {
  cancelBaskuleSignIn,
  completeBaskuleSignIn,
  connectAnonymously,
  connectToBaskule,
  signInToBaskule,
} from "./session";

type Confirm = {
  readonly target: ConnectTarget;
  readonly config: BaskuleAuthConfig;
  readonly name: string;
};
type Methods = { readonly serverUrl: string; readonly config: BaskuleAuthConfig };
type Pending = { readonly id: string; readonly secret: string; readonly serverUrl: string };

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof BaskuleApiError ? cause.message : fallback;

export function BaskuleLoginScreen(props: {
  readonly serverUrl: string | null;
  readonly notice?: string;
  readonly openedUrl: string | null;
  readonly switching?: boolean;
  readonly onCancel?: () => void;
  readonly onConnected?: () => void;
}) {
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const [server, setServer] = useState(props.serverUrl ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(props.notice ?? null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [methods, setMethods] = useState<Methods | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanHandled = useRef(false);
  const requestRevision = useRef(0);
  // oxlint-disable-next-line t3code/react-effect-budget -- Unmount cancels the in-flight native sign-in operation.
  useEffect(
    () => () => {
      requestRevision.current++;
      cancelBaskuleSignIn();
    },
    [],
  );

  const run = (work: () => Promise<void>, fallback: string) => {
    const expected = requestRevision.current;
    setBusy(true);
    setError(null);
    setInfo(null);
    work()
      .catch((cause: unknown) => {
        if (requestRevision.current === expected) setError(errorMessage(cause, fallback));
      })
      .finally(() => {
        if (requestRevision.current === expected) setBusy(false);
      });
  };

  const handleLink = (value: string) => {
    const target = parseConnectTarget(value);
    if (target === null) {
      setError(t("This is not a Baskule connection link or server address."));
      return;
    }
    requestRevision.current++;
    cancelBaskuleSignIn();
    setConfirm(null);
    setMethods(null);
    setPending(null);
    setServer(target.serverUrl);
    if (target.kind === "invitation") {
      setInfo(
        t(
          "Invitations are completed in the browser. Create your account there, then connect this phone from Apps → Connect a device.",
        ),
      );
      void Linking.openURL(target.url);
      return;
    }
    const expected = requestRevision.current;
    run(async () => {
      const instance = await fetchInstance(target.serverUrl);
      if (requestRevision.current !== expected) return;
      setConfirm({ target, name: instance.name, config: instance.authentication });
    }, t("Cannot reach this server."));
  };

  const receiveOpenedLink = useEffectEvent(handleLink);
  // oxlint-disable-next-line t3code/react-effect-budget -- The parent forwards native connection links after the screen mounts.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A native link starts a new server lookup and confirmation on this already-mounted screen.
    if (props.openedUrl) receiveOpenedLink(props.openedUrl);
  }, [props.openedUrl]);

  const connected = useEffectEvent(() => props.onConnected?.());
  // oxlint-disable-next-line t3code/react-effect-budget -- Browser sign-in completes asynchronously through the server polling endpoint.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void pollBrowserLogin(pending.serverUrl, pending)
        .then(async (token) => {
          if (cancelled || !token) return;
          clearInterval(timer);
          await completeBaskuleSignIn(pending.serverUrl, token);
          if (!cancelled) connected();
          if (!cancelled) setPending(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(errorMessage(cause, t("Sign-in failed.")));
          setPending(null);
        })
        .finally(() => {
          polling = false;
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pending, t]);

  const startScan = async () => {
    setError(null);
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    if (!permission.granted) {
      setError(t("Allow camera access to scan a connection QR code, or paste the link instead."));
      return;
    }
    scanHandled.current = false;
    setScanning(true);
  };

  const onScan = ({ data }: { readonly data: string }) => {
    if (scanHandled.current) return;
    scanHandled.current = true;
    setScanning(false);
    handleLink(data);
  };

  const signIn = () => {
    if (busy || !methods) return;
    if (email.trim() === "" || password === "") {
      setError(t("Enter your email and password."));
      return;
    }
    const expected = requestRevision.current;
    run(async () => {
      await signInToBaskule({ serverUrl: methods.serverUrl, email, password });
      if (requestRevision.current === expected) props.onConnected?.();
    }, t("Sign-in failed."));
  };

  const signInInBrowser = (serverUrl: string) => {
    const expected = requestRevision.current;
    run(async () => {
      const login = await requestBrowserLogin(serverUrl);
      if (requestRevision.current !== expected) return;
      setPending({ id: login.id, secret: login.secret, serverUrl });
      await Linking.openURL(login.url);
    }, t("Could not open the browser."));
  };

  const cancel = () => {
    requestRevision.current++;
    cancelBaskuleSignIn();
    setConfirm(null);
    setPending(null);
    setMethods(null);
    setBusy(false);
    props.onCancel?.();
  };

  const connect = ({ target, config }: Confirm) => {
    const expected = requestRevision.current;
    run(async () => {
      if (target.kind === "code") {
        await connectToBaskule(target);
        if (requestRevision.current === expected) props.onConnected?.();
      } else if (config.mode === "anonymous") {
        await connectAnonymously(target.serverUrl);
        if (requestRevision.current === expected) props.onConnected?.();
      } else {
        setConfirm(null);
        setMethods({ serverUrl: target.serverUrl, config });
      }
    }, t("Connection failed."));
  };

  const back = () => {
    requestRevision.current++;
    cancelBaskuleSignIn();
    setBusy(false);
    setMethods(null);
    setPending(null);
    setError(null);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-screen"
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="flex-grow justify-center gap-6 px-6"
        contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
      >
        <View className="gap-2">
          <BaskuleWordmark />
          <AppText className="text-3xl font-t3-bold">
            {confirm
              ? t("Connect to {{name}}?", { name: confirm.name })
              : methods
                ? t("Sign in")
                : t("Connect")}
          </AppText>
          <AppText className="text-base text-foreground-muted">
            {confirm
              ? t(
                  props.switching
                    ? "Replace this phone’s current connection with {{server}}?"
                    : "This phone will connect to {{server}}.",
                  { server: confirm.target.serverUrl },
                )
              : methods
                ? methods.serverUrl
                : t(
                    "Scan the QR code from Baskule on your computer (Apps → Connect a device), or enter the server address.",
                  )}
          </AppText>
        </View>
        {props.switching && !confirm ? (
          <Button label={t("Cancel")} tone="text" fullWidth onPress={cancel} />
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        {info ? <AppText className="text-sm text-foreground-muted">{info}</AppText> : null}
        {confirm ? (
          <View className="gap-3">
            <Button
              label={t("Connect")}
              tone="primary"
              fullWidth
              loading={busy}
              onPress={() => connect(confirm)}
            />
            <Button label={t("Cancel")} tone="text" fullWidth onPress={cancel} />
          </View>
        ) : scanning ? (
          <View className="gap-3">
            <View className="overflow-hidden rounded-[26px]" style={{ aspectRatio: 1 }}>
              <CameraView
                active
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={onScan}
                style={StyleSheet.absoluteFill}
              />
            </View>
            <Button label={t("Cancel")} tone="text" fullWidth onPress={() => setScanning(false)} />
          </View>
        ) : pending ? (
          <View className="gap-3">
            <AppText>
              {t("Finish signing in and approve the connection in your browser, then return here.")}
            </AppText>
            <Button label={t("Cancel browser sign-in")} tone="text" fullWidth onPress={cancel} />
          </View>
        ) : methods ? (
          <>
            {methods.config.password ? (
              <View className="gap-4">
                <ConnectionFormField
                  label={t("Email")}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="username"
                  returnKeyType="next"
                  editable={!busy}
                />
                <ConnectionFormField
                  label={t("Password")}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="current-password"
                  textContentType="password"
                  returnKeyType="go"
                  onSubmitEditing={signIn}
                  editable={!busy}
                />
                <Button
                  label={t("Sign in")}
                  tone="primary"
                  fullWidth
                  loading={busy}
                  onPress={signIn}
                />
              </View>
            ) : null}
            {methods.config.providers.length > 0 ? (
              <Button
                label={t("Sign in in browser")}
                tone={methods.config.password ? "secondary" : "primary"}
                fullWidth
                loading={busy}
                onPress={() => signInInBrowser(methods.serverUrl)}
              />
            ) : null}
            <Button label={t("Use another server")} tone="text" fullWidth onPress={back} />
            <AppText className="text-sm text-foreground-muted">
              {t("No account yet? Ask your administrator for an invitation link.")}
            </AppText>
          </>
        ) : (
          <>
            <Button
              label={t("Scan a QR code")}
              tone="primary"
              fullWidth
              disabled={busy}
              onPress={() => void startScan()}
            />
            <ConnectionFormField
              label={t("Server or connection link")}
              value={server}
              onChangeText={setServer}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://baskule.example.com"
              returnKeyType="go"
              onSubmitEditing={() => handleLink(server)}
              editable={!busy}
            />
            <Button
              label={t("Continue")}
              tone="secondary"
              fullWidth
              loading={busy}
              onPress={() => handleLink(server)}
            />
            <LanguageSetting compact />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
