import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";

import type { BaskuleSpace } from "./api";
import { spaceConnectionId, spaceHttpBaseUrl, spaceWsBaseUrl } from "./config";

/**
 * One environment per space at `<server>/s/<id>/`, authenticated by the person's Baskule session
 * token ("front-session": `Authorization: Bearer` on every request and on the socket upgrade).
 * They are platform registrations: the server owns the list, so they can't be removed by hand and
 * sign-out removes them all.
 */
export function spaceRegistration(input: {
  readonly serverUrl: string;
  readonly token: string;
  readonly space: BaskuleSpace;
  readonly environmentId: string;
}): BearerConnectionRegistration {
  const connectionId = spaceConnectionId(input.serverUrl, input.space.id);
  const environmentId = EnvironmentId.make(input.environmentId);
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, label: input.space.name, connectionId }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label: input.space.name,
      httpBaseUrl: spaceHttpBaseUrl(input.serverUrl, input.space.base),
      wsBaseUrl: spaceWsBaseUrl(input.serverUrl, input.space.base),
      authorization: input.token ? "front-session" : "anonymous",
    }),
    credential: new BearerConnectionCredential({ token: input.token }),
  });
}

/** Reads a space's environment id from its descriptor (needs the session: the front checks it). */
export async function fetchSpaceEnvironmentId(
  serverUrl: string,
  token: string,
  space: BaskuleSpace,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchFn(
      `${spaceHttpBaseUrl(serverUrl, space.base)}.well-known/t3/environment`,
      { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "omit", signal },
    );
    if (!response.ok) return null;
    const descriptor = (await response.json()) as { environmentId?: unknown };
    return typeof descriptor.environmentId === "string" ? descriptor.environmentId : null;
  } catch {
    return null;
  }
}
