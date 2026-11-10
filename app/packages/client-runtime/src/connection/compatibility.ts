import {
  CLIENT_CAPABILITIES_QUERY_PARAM,
  BASKULE_RELEASE,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { compareReleaseVersions } from "@t3tools/shared/releaseCompatibility";

import { ConnectionBlockedError } from "./model.ts";

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  if (compareReleaseVersions(BASKULE_RELEASE.version, descriptor.minClient) < 0) {
    return new ConnectionBlockedError({
      reason: "unsupported",
      detail: `You must update Baskule to ${descriptor.minClient} or newer to connect to ${descriptor.label}.`,
    });
  }
  if (compareReleaseVersions(descriptor.serverVersion, BASKULE_RELEASE.minServer) < 0) {
    return new ConnectionBlockedError({
      reason: "unsupported",
      detail: "This installation needs an update to work with this version of Baskule.",
    });
  }
  // Servers shipped before negotiation use the original wire protocol.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  return serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
    ? new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client is not supported by this server. Update your app or use a compatible release to connect to ${descriptor.label}.`,
      })
    : new ConnectionBlockedError({
        reason: "unsupported",
        detail: "This installation needs an update to work with this version of Baskule.",
      });
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(CLIENT_CAPABILITIES_QUERY_PARAM, SETTINGS_SECRET_REFERENCES_CAPABILITY);
  return url.toString();
}
