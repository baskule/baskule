import { t, useTranslation } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import previewStreamScript from "@t3tools/mobile-preview-stream";
import {
  previewStreamControlLabel,
  previewStreamHostSetupMessage,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamFileChooser,
  type PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type PreviewStreamHostSetup,
} from "@t3tools/contracts";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import * as Clipboard from "expo-clipboard";

import { AppText } from "../../components/ui/AppText";
import { PdfPreview } from "../../components/PdfPreview";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { useManagedAssetUri } from "../../state/assets";
import { usePreviewStreamAccess } from "../../state/preview";
import { previewPromptText } from "./previewPromptText";
import { appendPreviewFile } from "./preview-file-form";

import {
  previewStreamDocument,
  type PreviewStreamMessage,
  type PreviewStreamConfiguration,
} from "./preview-stream-document";

import {
  bindTransferLifetime,
  fetchNativeFile,
  isTransferOriginCurrent,
  type TransferOrigin,
} from "../../connection/native-transfer";
import { uuidv4 } from "../../lib/uuid";
import {
  createNativePreviewBridge,
  parseViewerBridgeMessage,
  type PreviewBridgeBinding,
} from "./preview-native-bridge";
import { createNativePreviewSocket } from "./native-preview-socket";

type NativePreviewConfiguration = {
  readonly access: DeviceHubAccess;
  readonly origin: TransferOrigin;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly interactive: boolean;
  readonly background: string;
};

export interface PreviewStreamRef {
  readonly command: (input: PreviewStreamInput) => void;
  readonly paste: () => void;
  readonly togglePictureInPicture: () => void;
}

export interface PreviewPictureInPictureState {
  readonly supported: boolean;
  readonly active: boolean;
}

type NativeStreamBridge = {
  readonly ref?: Ref<PreviewStreamRef>;
  readonly onUnauthorized: () => void;
  readonly onGone?: () => void;
  readonly onViewport?: (viewport: { readonly width: number; readonly height: number }) => void;
  readonly onControl?: (control: PreviewStreamControl | null) => void;
  readonly onPictureInPicture?: (state: PreviewPictureInPictureState, detail?: string) => void;
  /** True while frames show, so commands reach the page. Pass a stable function. */
  readonly onStreamingChange?: (streaming: boolean) => void;
  readonly compact?: boolean;
  readonly pdfUri?: string | null;
};

async function sendFilesToPage(
  chooser: PreviewStreamFileChooser,
  pick: boolean,
  transfer: { environmentId: EnvironmentId; origin: TransferOrigin },
  signal: AbortSignal,
) {
  const body = new FormData();
  if (pick) {
    const { getDocumentAsync } = await import("expo-document-picker");
    const endHandoff = beginForegroundHandoff();
    let result: Awaited<ReturnType<typeof getDocumentAsync>>;
    try {
      result = await getDocumentAsync({ multiple: chooser.multiple, copyToCacheDirectory: true });
    } finally {
      endHandoff();
    }
    const { File } = await import("expo-file-system");
    for (const asset of result.canceled ? [] : result.assets) {
      if (signal.aborted || !isTransferOriginCurrent(transfer.origin)) return;
      appendPreviewFile(body, {
        file: new File(asset.uri),
        name: asset.name,
        mimeType: asset.mimeType,
      });
    }
  }
  if (signal.aborted || !isTransferOriginCurrent(transfer.origin)) return;
  const response = await fetchNativeFile({
    url: chooser.uploadUrl,
    method: "POST",
    body,
    transfer,
    signal,
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

function offerDownload(
  download: PreviewStreamDownload,
  transfer: { environmentId: EnvironmentId; origin: TransferOrigin },
  signal: AbortSignal,
) {
  Dialog.alert(`Downloaded ${download.fileName}`, undefined, [
    { text: t("Not now"), style: "cancel" },
    {
      text: t("Save or share"),
      onPress: () =>
        void downloadAndShareAttachment({
          url: download.url,
          attachment: { name: download.fileName, mimeType: "application/octet-stream" },
          signal,
          transfer,
        }).catch((cause: unknown) =>
          Dialog.alert(
            "Could not save the download",
            cause instanceof Error ? cause.message : undefined,
          ),
        ),
    },
  ]);
}

const MAX_REFUSALS = 3;

export function PreviewStreamWebView(
  props: Omit<NativePreviewConfiguration, "access" | "origin"> &
    Omit<NativeStreamBridge, "onUnauthorized"> & {
      readonly environmentId: EnvironmentId;
      readonly paused?: boolean;
    },
) {
  const t = useTranslation();
  const { access, origin, error, refresh } = usePreviewStreamAccess(props.environmentId);
  if (access && origin && !props.paused) {
    return (
      <AuthorizedPreviewStream
        {...props}
        access={access}
        origin={origin}
        onUnauthorized={refresh}
      />
    );
  }
  return (
    <View
      className={
        props.compact
          ? "flex-1 items-center justify-center"
          : "flex-1 items-center justify-center gap-4 px-6"
      }
    >
      {props.compact || !error ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
      {!props.compact && (
        <>
          <AppText
            selectable={!!error}
            className={
              error ? "text-center text-sm text-foreground-muted" : "text-sm text-foreground-muted"
            }
          >
            {error || t("Connecting to browser...")}
          </AppText>
          {error && (
            <View className="items-center">
              <Button label={t("Retry")} tone="secondary" onPress={refresh} />
            </View>
          )}
        </>
      )}
    </View>
  );
}

function AuthorizedPreviewStream({
  ref,
  ...props
}: NativePreviewConfiguration & NativeStreamBridge) {
  const [attempt, setAttempt] = useState(0);
  const [previousAccess, setPreviousAccess] = useState(props.access);
  // Wait for refreshed access, including cookie credentials with unchanged JSON.
  if (props.access !== previousAccess) {
    setPreviousAccess(props.access);
    setAttempt((current) => current + 1);
  }
  const processRetried = useRef(false);
  const unauthorized = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const binding = useMemo(
    () => ({
      environmentId: String(props.environmentId),
      connectionId: `${attempt}:${props.origin.connection.environmentId}:${uuidv4()}`,
      threadId: props.threadId,
      tabId: props.tabId,
      transportGeneration: 0,
    }),
    [props.environmentId, props.threadId, props.tabId, props.origin, attempt],
  );
  const configuration = JSON.stringify({
    binding,
    interactive: props.interactive,
    background: props.background,
  } satisfies PreviewStreamConfiguration);
  return (
    <PreviewStreamDocumentView
      key={`${attempt}:${configuration}`}
      {...props}
      ref={ref}
      configuration={configuration}
      binding={binding}
      onUnauthorized={() => {
        const refusals = ++unauthorized.current;
        if (refusals >= MAX_REFUSALS) return false;
        if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(
          () => {
            refreshTimer.current = null;
            props.onUnauthorized();
          },
          refusals === 1 ? 0 : 1_000 * 2 ** (refusals - 1),
        );
        return true;
      }}
      onRetry={() => {
        processRetried.current = false;
        unauthorized.current = 0;
        props.onUnauthorized();
      }}
      onStreaming={() => {
        processRetried.current = false;
        unauthorized.current = 0;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((current) => current + 1);
        return true;
      }}
    />
  );
}

function PreviewStreamDocumentView({
  ref,
  configuration,
  binding,
  access,
  origin,
  environmentId,
  threadId,
  tabId,
  interactive,
  background,
  compact,
  pdfUri,
  onUnauthorized,
  onGone,
  onViewport,
  onControl,
  onPictureInPicture,
  onStreamingChange,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: NativePreviewConfiguration &
  Omit<NativeStreamBridge, "onUnauthorized"> & {
    readonly configuration: string;
    readonly binding: PreviewBridgeBinding;
    readonly background: string;
    readonly onUnauthorized: () => boolean;
    readonly onRetry: () => void;
    readonly onStreaming: () => void;
    readonly onRecoverProcess: () => boolean;
  }) {
  const t = useTranslation();
  const managedPdf = useManagedAssetUri({
    environmentId,
    url: pdfUri ?? null,
    name: "browser.pdf",
  });
  const webView = useRef<WebView<object>>(null);
  const active = useRef(true);
  const nativeBridge = useRef<ReturnType<typeof createNativePreviewBridge> | null>(null);
  const transferController = useRef(new AbortController());
  const transfer = { environmentId, origin };
  const failed = useRef(false);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [hostSetup, setHostSetup] = useState<PreviewStreamHostSetup | null>(null);
  const [started, setStarted] = useState(false);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const dialogRef = useRef<PreviewStreamControl["dialog"]>(null);
  const [promptText, setPromptText] = useState("");
  const [fileChooser, setFileChooser] = useState<PreviewStreamFileChooser | null>(null);
  const answerFileChooser = (pick: boolean) => {
    const chooser = fileChooser;
    if (!chooser) return;
    setFileChooser(null);
    void sendFilesToPage(chooser, pick, transfer, transferController.current.signal).catch(
      (cause: unknown) =>
        Dialog.alert(
          "Could not send the files to the page",
          cause instanceof Error ? cause.message : undefined,
        ),
    );
  };
  const controlChanged = useEffectEvent((next: PreviewStreamControl | null) => onControl?.(next));
  const command = (input: PreviewStreamInput) => {
    nativeBridge.current?.command(input);
  };
  // Reads here rather than in the screen: a tab switch during the iOS paste prompt unmounts
  // this view and nulls its WebView ref, so the text can never type into another tab.
  const paste = () =>
    void Clipboard.getStringAsync().then(
      (text) => {
        if (text) command({ type: "text", text });
      },
      () => Dialog.alert("Could not read the clipboard"),
    );
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    nativeBridge.current?.stop();
    transferController.current.abort();
    webView.current?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    onStreamingChange?.(false);
    setControl(null);
    setFileChooser(null);
    onControl?.(null);
    setError(message);
    setStatus("error");
  };
  const handleNativeMessage = (message: PreviewStreamMessage) => {
    if (!active.current || failed.current) return;
    switch (message.type) {
      case "control": {
        setControl(message);
        const previousDialog = dialogRef.current;
        dialogRef.current = message.dialog;
        setPromptText((draft) => previewPromptText(previousDialog, message.dialog, draft));
        onControl?.(message);
        return;
      }
      case "unauthorized":
        if (!onUnauthorized()) {
          fail("This session can't open the browser stream. Reconnect to try again.");
        }
        return;
      case "gone":
        setGone(true);
        fail("This tab was closed.");
        onGone?.();
        return;
      case "hostSetup":
        setHostSetup({ need: message.need, command: message.command });
        fail(previewStreamHostSetupMessage(message));
        return;
      case "viewport":
        onViewport?.(message);
        return;
      case "clipboard":
        void Clipboard.setStringAsync(message.text).catch(() => undefined);
        return;
      case "download":
        offerDownload(message, transfer, transferController.current.signal);
        return;
      case "fileChooser":
        setFileChooser(message.chooser);
        return;
      case "pictureInPicture":
        onPictureInPicture?.(message, message.detail);
        return;
      case "status":
        setStarted(true);
        if (message.status === "error") {
          fail(message.detail ?? "Browser stream failed.");
          return;
        }
        setStatus(message.status);
        if (message.status === "connecting") {
          // Dialogs may have closed and reopened while this viewer was disconnected.
          dialogRef.current = null;
          setControl(null);
          onControl?.(null);
        }
        onStreamingChange?.(message.status === "streaming");
        if (message.status === "streaming") onStreaming();
    }
  };
  const observeNativeMessage = useEffectEvent(handleNativeMessage);
  useLayoutEffect(() => {
    const controller = new AbortController();
    transferController.current = controller;
    const bridge = createNativePreviewBridge({
      binding,
      target: { access, threadId, tabId, interactive },
      isCurrent: () =>
        active.current && !controller.signal.aborted && isTransferOriginCurrent(origin),
      createSocket: (url) => {
        return createNativePreviewSocket({ url, environmentId, origin });
      },
      post: (message) =>
        webView.current?.injectJavaScript(
          `window.T3PreviewStream?.receive(${JSON.stringify(message)}); true;`,
        ),
      events: {
        onControl: (control) => observeNativeMessage({ type: "control", ...control }),
        onViewport: (viewport) => observeNativeMessage({ type: "viewport", ...viewport }),
        onConnectedChange: (connected) => {
          if (!connected) observeNativeMessage({ type: "status", status: "connecting" });
        },
        onUnauthorized: () => observeNativeMessage({ type: "unauthorized" }),
        onGone: () => observeNativeMessage({ type: "gone" }),
        onHostSetup: (setup) => observeNativeMessage({ type: "hostSetup", ...setup }),
        onClipboard: (text) => observeNativeMessage({ type: "clipboard", text }),
        onDownload: (download) => observeNativeMessage({ type: "download", ...download }),
        onFileChooser: (chooser) => observeNativeMessage({ type: "fileChooser", chooser }),
        onFailure: (detail) => observeNativeMessage({ type: "status", status: "error", detail }),
      },
    });
    nativeBridge.current = bridge;
    const lifetime = bindTransferLifetime({
      environmentId,
      origin,
      signal: controller.signal,
      scope: AuthOrchestrationReadScope,
      invalidate: () => {
        bridge.stop();
        controller.abort();
      },
    });
    return () => {
      bridge.stop();
      controller.abort();
      lifetime.dispose();
      nativeBridge.current = null;
    };
  }, [binding, access, origin, environmentId, threadId, tabId, interactive]);
  const bootstrapTimedOut = useEffectEvent(() =>
    fail("Browser viewer could not start. Reconnect to try again."),
  );
  useEffect(() => {
    if (started) return;
    const timer = setTimeout(bootstrapTimedOut, 15_000);
    return () => clearTimeout(timer);
  }, [started]);
  const source = useMemo(
    () => ({
      html: previewStreamDocument(configuration, previewStreamScript),
      baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
    }),
    [configuration],
  );
  useImperativeHandle(ref, () => ({
    command,
    paste,
    togglePictureInPicture: () =>
      webView.current?.injectJavaScript("window.T3PreviewStream?.pictureInPicture(); true;"),
  }));
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    return () => {
      active.current = false;
      view?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    };
  }, []);
  useEffect(() => () => onStreamingChange?.(false), [onStreamingChange]);
  useEffect(() => () => controlChanged(null), []);
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    if (!onRecoverProcess()) fail("Browser viewer stopped. Reconnect to try again.");
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      {!compact ? (
        <View className="flex-row items-center justify-between gap-2 border-b border-secondary-border px-3 py-2">
          <AppText className="text-xs text-foreground-muted">
            {previewStreamControlLabel(control)}
          </AppText>
          {control?.canOperate ? (
            <Button
              label={control.controller === "you" ? t("Release control") : t("Take control")}
              tone="secondary"
              disabled={control.controller === "another-viewer"}
              onPress={() =>
                command({ type: control.controller === "you" ? "releaseControl" : "takeControl" })
              }
            />
          ) : null}
        </View>
      ) : null}
      <View className="relative flex-1">
        <WebView<object>
          ref={webView}
          source={source}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          mixedContentMode="never"
          contentInsetAdjustmentBehavior="never"
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          allowsPictureInPictureMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          style={{ flex: 1, backgroundColor: background }}
          onError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onHttpError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onContentProcessDidTerminate={processTerminated}
          onRenderProcessGone={processTerminated}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === source.baseUrl
          }
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          onMessage={(event) => {
            if (!active.current || failed.current) return;
            const message = parseViewerBridgeMessage(event.nativeEvent.data);
            if (!message) return;
            nativeBridge.current?.receive(message);
            if (!nativeBridge.current?.accepts(message)) return;
            if (message.type === "status" || message.type === "pictureInPicture")
              handleNativeMessage(message);
          }}
        />
        {managedPdf.uri ? (
          <View className="absolute inset-0">
            <PdfPreview key={managedPdf.uri} uri={managedPdf.uri} />
          </View>
        ) : null}
      </View>
      {!compact && fileChooser && control?.controller === "you" ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">
            {t("The page asks for")} {fileChooser.multiple ? t("files") : t("a file")}.
          </AppText>
          <View className="flex-row justify-end gap-3">
            <Button label={t("Cancel")} tone="text" onPress={() => answerFileChooser(false)} />
            <Button
              label={t("Choose {{value1}}", {
                value1: fileChooser.multiple ? t("files") : t("file"),
              })}
              tone="secondary"
              onPress={() => answerFileChooser(true)}
            />
          </View>
        </View>
      ) : null}
      {!compact && control?.dialog ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">{control.dialog.message}</AppText>
          {control.controller === "you" ? (
            <>
              {control.dialog.type === "prompt" ? (
                <TextInput
                  accessibilityLabel={t("Dialog response")}
                  className="rounded-lg border border-input-border bg-input px-3 py-2 text-foreground"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  value={promptText}
                  onChangeText={setPromptText}
                />
              ) : null}
              <View className="flex-row justify-end gap-3">
                <Button
                  label={t("Dismiss")}
                  tone="text"
                  onPress={() => command({ type: "dialog", accept: false })}
                />
                <Button
                  label={t("Accept")}
                  tone="secondary"
                  onPress={() =>
                    command({
                      type: "dialog",
                      accept: true,
                      ...(control.dialog?.type === "prompt" ? { promptText } : {}),
                    })
                  }
                />
              </View>
            </>
          ) : (
            <AppText className="text-xs text-foreground-muted">
              {t("Take control to respond.")}
            </AppText>
          )}
        </View>
      ) : null}
      {status !== "streaming" ? (
        <View
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          {status === "connecting" ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
          {compact ? null : (
            <AppText
              accessibilityLiveRegion="polite"
              className="text-center text-sm text-foreground-muted"
            >
              {status === "error" ? error : t("Connecting to browser...")}
            </AppText>
          )}
          {status === "error" && hostSetup && !compact ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Copy {{command}}", { command: hostSetup.command })}
              className="w-full flex-row items-center gap-2 rounded-xl border border-secondary-border bg-secondary px-4 py-3"
              onPress={() => {
                void Clipboard.setStringAsync(hostSetup.command).catch(() => undefined);
              }}
            >
              <AppText selectable className="flex-1 font-mono text-sm text-secondary-foreground">
                {hostSetup.command}
              </AppText>
              <AppText className="text-xs text-foreground-muted">{t("Copy")}</AppText>
            </Pressable>
          ) : null}
          {status === "error" && !gone && !compact ? (
            <View className="items-center">
              <Button
                label={hostSetup ? t("Try again") : t("Reconnect")}
                tone="secondary"
                onPress={onRetry}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
