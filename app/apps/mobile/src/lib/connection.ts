import { EnvironmentId } from "@t3tools/contracts";
import type {
  EnvironmentConnectionPhase,
  PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";

export function baskulePreviewStreamAccess(
  connection: PreparedConnection,
): DeviceHubAccess | null {
  if (
    !connection.socketHeaders &&
    !/^\/s\/[^/]+\/?$/.test(new URL(connection.httpBaseUrl).pathname)
  )
    return null;
  const httpBase = connection.httpBaseUrl.replace(/\/$/, "") + "/api/preview-stream";
  return { httpBase, wsBase: httpBase.replace(/^http/, "ws"), query: {}, credentials: false };
}

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
  readonly authenticationMethod?: "bearer" | "dpop";
  readonly dpopAccessToken?: string;
  readonly relayManaged?: true;
}

export type RemoteClientConnectionState = EnvironmentConnectionPhase;

export function isRelayManagedConnection(
  connection: Pick<SavedRemoteConnection, "authenticationMethod" | "relayManaged">,
): boolean {
  return connection.relayManaged === true || connection.authenticationMethod === "dpop";
}

export function toStableSavedRemoteConnection(
  connection: SavedRemoteConnection,
): SavedRemoteConnection {
  if (!isRelayManagedConnection(connection) || !connection.dpopAccessToken) {
    return connection;
  }

  const { dpopAccessToken: _, ...stableConnection } = connection;
  return stableConnection;
}
