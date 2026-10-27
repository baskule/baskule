import { useTranslation } from "../../i18n";
import { useId, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { nativeAssetImageSource } from "../../lib/assetImageSource";

import { FilePreviewLoading } from "./FilePreviewFeedback";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { useMediaActions } from "../../state/mediaActions";
import { type MediaActionsSource } from "../../lib/mediaActionsSource";
import { MediaActionsMenu } from "../../components/MediaActionsMenu";

function ResolvedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
  readonly actionsSource?: MediaActionsSource;
}) {
  const t = useTranslation();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const sourceIdentifier = useId();
  const mediaActions = useMediaActions(props.actionsSource);

  return (
    <View className="relative flex-1 bg-subtle">
      <MediaActionsMenu media={mediaActions} style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open full-screen preview of {{accessibilityLabel}}", {
            accessibilityLabel: props.accessibilityLabel,
          })}
          accessibilityHint={
            mediaActions.actions.length > 0 ? t("Touch and hold for media actions") : undefined
          }
          disabled={loadError !== null}
          className="flex-1 p-4 active:bg-subtle-strong"
          onPress={() =>
            setPreview({
              kind: "image",
              uri: props.uri,
              name: props.accessibilityLabel,
              sourceIdentifier,
              actionsSource: props.actionsSource,
            })
          }
        >
          <PresentationSource identifier={sourceIdentifier} style={{ flex: 1 }}>
            <Image
              accessible={false}
              source={nativeAssetImageSource(props.uri)}
              className="h-full w-full"
              resizeMode="contain"
              onLoadStart={() => setLoadError(null)}
              onError={(event) => {
                setLoadError(event.nativeEvent.error || "The image could not be rendered.");
              }}
            />
          </PresentationSource>
        </Pressable>
      </MediaActionsMenu>
      {loadError !== null ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 items-center justify-center bg-card px-6"
        >
          <EmptyState title={t("Image unavailable")} detail={loadError} />
        </View>
      ) : null}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}

export function WorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string | null;
  readonly actionsSource?: MediaActionsSource;
}) {
  const t = useTranslation();
  if (props.uri === null) {
    return <FilePreviewLoading message={t("Preparing image preview...")} background="card" />;
  }

  return (
    <ResolvedWorkspaceFileImagePreview
      accessibilityLabel={props.accessibilityLabel}
      uri={props.uri}
      actionsSource={props.actionsSource}
    />
  );
}
