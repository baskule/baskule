import { SafeAreaView } from "react-native-safe-area-context";
import { ControlPill } from "../../components/ui/ControlPill";
import { useTranslation } from "../../i18n";

import { useState } from "react";
import { Platform, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import { LoadingStrip } from "../../components/ui/LoadingStrip";
import { PdfPreview } from "../../components/PdfPreview";
import { useLocalHtmlDocument } from "../../lib/useLocalHtmlDocument";
import { isPdfPreviewUri } from "../../lib/pdfPreview";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";

export function WorkspaceFileWebPreview(props: { readonly uri: string | null }) {
  const t = useTranslation();
  if (props.uri === null) {
    return <FilePreviewLoading message={t("Preparing preview...")} background="card" />;
  }
  return <DocumentWebPreview key={props.uri} uri={props.uri} />;
}

function DocumentWebPreview(props: { readonly uri: string }) {
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  // iOS headers float over this column, so content starts below them.
  const headerInset = Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkedPdf, setLinkedPdf] = useState<string | null>(null);
  const html = useLocalHtmlDocument(isPdfPreviewUri(props.uri) ? null : props.uri);
  if (isPdfPreviewUri(props.uri)) {
    return (
      <View className="flex-1" style={{ paddingTop: headerInset }}>
        <PdfPreview uri={props.uri} />
      </View>
    );
  }

  if (html.document === null) {
    return html.failed ? (
      <View className="flex-1 items-center justify-center">
        <Text>{t("Preview failed")}</Text>
      </View>
    ) : (
      <FilePreviewLoading message={t("Preparing preview...")} background="card" />
    );
  }

  return (
    <View className="relative flex-1 bg-card">
      {linkedPdf ? (
        <View className="flex-1" style={{ paddingTop: headerInset }}>
          <PdfPreview key={linkedPdf} uri={linkedPdf} />
          <SafeAreaView edges={["bottom"]} className="border-t border-border px-4 py-2">
            <ControlPill
              label={t("Back to document")}
              variant="pill"
              onPress={() => setLinkedPdf(null)}
            />
          </SafeAreaView>
        </View>
      ) : null}
      <View className="flex-1" style={linkedPdf ? { display: "none" } : undefined}>
        <WebView
          source={{ uri: html.document }}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          incognito
          cacheEnabled={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          contentInsetAdjustmentBehavior="automatic"
          originWhitelist={["*"]}
          allowsBackForwardNavigationGestures
          allowsFullscreenVideo
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) => request.url.split("#", 1)[0] === html.document}
          startInLoadingState
          onLoadProgress={(event) => {
            setLoadProgress(event.nativeEvent.progress);
          }}
          onLoadStart={() => {
            setLoadProgress(0.05);
            setLoadError(null);
          }}
          onLoadEnd={() => {
            setLoadProgress(0);
          }}
          onError={(event) => {
            setLoadProgress(0);
            setLoadError(event.nativeEvent.description || "The file could not be rendered.");
          }}
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center bg-card">
              <AppActivityIndicator />
            </View>
          )}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
        <View pointerEvents="box-none" className="absolute inset-x-0" style={{ top: headerInset }}>
          {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
          {loadError ? (
            <View className="border-b border-border bg-card px-4 py-2">
              <Text className="text-xs font-t3-bold text-foreground">{t("Preview failed")}</Text>
              <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{loadError}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
