import { t, useTranslation } from "../../i18n";

import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/ui/AppSymbol";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

function noticeTitle(phase: EnvironmentConnectionPhase, environmentLabel: string): string {
  switch (phase) {
    case "offline":
      return t("You are offline");
    case "connecting":
      return t("Connecting to {{environmentLabel}}...", { environmentLabel: environmentLabel });
    case "reconnecting":
      return t("Reconnecting to {{environmentLabel}}...", { environmentLabel: environmentLabel });
    case "unsupported":
      return t("Client not supported");
    case "error":
      return `${environmentLabel} is unavailable`;
    case "available":
      return `${environmentLabel} is disconnected`;
    case "connected":
      return "";
  }
}

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
): string {
  if (error) {
    return phase === "reconnecting" ? `The app will keep retrying automatically. ${error}` : error;
  }

  switch (phase) {
    case "offline":
      return t(
        "Cached data remains available. The {{resourceName}} will load when your connection returns.",
        { resourceName: resourceName },
      );
    case "connecting":
    case "reconnecting":
      return t("The {{resourceName}} will load as soon as the environment is ready.", {
        resourceName: resourceName,
      });
    case "unsupported":
      return t("Use compatible versions of the app and server to connect.");
    case "available":
    case "error":
      return t("Reconnect the environment to load the {{resourceName}}.", {
        resourceName: resourceName,
      });
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const t = useTranslation();
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <AppActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(props.connection.phase, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection.phase, props.resourceName, props.connection.error)}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {props.connection.phase !== "offline" && props.connection.phase !== "unsupported" ? (
          <View className="mt-1">
            <Button label={t("Retry now")} tone="secondary" onPress={props.onRetry} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
