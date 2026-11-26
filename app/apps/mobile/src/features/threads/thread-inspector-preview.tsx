import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { View } from "react-native";

import { DevicePreviewScreen } from "../devices/DevicePreviewRouteScreen";
import {
  WorkspaceContentWidthContext,
  WorkspaceSettledContentWidthContext,
} from "../layout/workspace-content-width";
import {
  ThreadInspectorNavigationContext,
  type ThreadInspectorTarget,
} from "./thread-inspector-navigation";
import type { ThreadInspectorPresentation } from "./thread-inspector-header";
import { ThreadPreviewRoute } from "./thread-preview-route";

/** A thread shown beside or over the workspace does not take the workspace's content width. */
export function InspectorContentScope({ children }: { readonly children: ReactNode }) {
  return (
    <WorkspaceContentWidthContext value={null}>
      <WorkspaceSettledContentWidthContext value={null}>
        {children}
      </WorkspaceSettledContentWidthContext>
    </WorkspaceContentWidthContext>
  );
}

export function ThreadInspectorPreview(props: {
  readonly target: ThreadInspectorTarget;
  readonly onClose: () => void;
  readonly onOpen: (target: ThreadInspectorTarget) => void;
  readonly renderThread: (
    props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }> & {
      readonly inspectorPresentation: ThreadInspectorPresentation;
    },
  ) => ReactNode;
}) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const { target } = props;
  const maximizeDevice = (deviceKey: string | null) => {
    props.onOpen({ ...target, deviceKey: deviceKey ?? undefined });
    navigation.navigate("ThreadDevicePreview", {
      environmentId: target.environmentId,
      threadId: target.threadId,
      deviceKey: deviceKey ?? undefined,
    });
  };
  if (!focused) return null;
  return (
    <ThreadInspectorNavigationContext value={props.onOpen}>
      <InspectorContentScope>
        {target.type === "device" ? (
          <DevicePreviewScreen
            key={`${target.environmentId}:${target.threadId}`}
            environmentId={EnvironmentId.make(target.environmentId)}
            threadId={ThreadId.make(target.threadId)}
            initialDeviceKey={target.deviceKey}
            onClose={props.onClose}
            onMaximize={maximizeDevice}
          />
        ) : (
          <View className="flex-1 bg-screen">
            <ThreadPreviewRoute environmentId={target.environmentId} threadId={target.threadId}>
              {(route) =>
                props.renderThread({
                  route,
                  inspectorPresentation: {
                    onMaximize: () =>
                      navigation.navigate("ThreadInspectorFullscreen", {
                        environmentId: route.params.environmentId,
                        threadId: route.params.threadId,
                      }),
                  },
                })
              }
            </ThreadPreviewRoute>
          </View>
        )}
      </InspectorContentScope>
    </ThreadInspectorNavigationContext>
  );
}

/** A linked environment's read-only thread in the inspector; Maximize gives it the whole screen. */
