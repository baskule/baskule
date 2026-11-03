import { DesktopSshEnvironmentTargetSchema, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
    learned: Schema.optionalKey(Schema.Literal(true)),
    /**
     * "t3-connect": DPoP through T3 Connect.
     * "front-session" (baskule): the credential is a session token of an authenticating front
     * (Baskule's Better Auth bearer). It is sent as `Authorization: Bearer` on every HTTP request,
     * the descriptor and the WebSocket upgrade; there is no T3 token exchange and no socket ticket.
     */
    authorization: Schema.optionalKey(
      Schema.Literals(["t3-connect", "front-session", "anonymous"]),
    ),
    /**
     * "tailscale" on a learned route the server found on its Tailscale
     * interface. A bare 100.64.0.0/10 address could belong to any VPN.
     */
    network: Schema.optionalKey(Schema.Literal("tailscale")),
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

export const ConnectionProfile = Schema.Union([BearerConnectionProfile, SshConnectionProfile]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionRoute {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
}

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  readonly alternateRoutes?: ReadonlyArray<ConnectionRoute>;
  readonly enabled: boolean;
  readonly unsupportedReason?: string;
  readonly serverUpdateRequired?: boolean;
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
  },
) {}

export const ConnectionCredential = Schema.Union([BearerConnectionCredential]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
    /** The token from pairing over SSH, which later connects reuse. */
    credential: BearerConnectionCredential,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * The primary stays on same-origin cookie auth
 * (`PrimaryConnectionRegistration`); secondary local backends live on a
 * separate loopback origin and authenticate with a bearer token minted from
 * their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
        enabled: true,
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
        enabled: true,
      };
  }
}

/**
 * Trust belongs to the saved endpoints, never to an environment id advertised
 * by a server alone. With several routes the key covers all of them, sorted so
 * reordering keeps trust but adding or changing an address revokes it.
 */
export function connectionEndpointKey(entry: ConnectionCatalogEntry): string | null {
  const routes = [
    { target: entry.target, profile: entry.profile },
    ...(entry.alternateRoutes ?? []),
  ].filter((route) => {
    const profile = Option.getOrNull(route.profile);
    return !(profile?._tag === "BearerConnectionProfile" && profile.learned === true);
  });
  if (routes.length === 1) return routeConnectionKey(routes[0]!.target, routes[0]!.profile);
  const keys = routes.map((route) => routeConnectionKey(route.target, route.profile));
  return keys.every((key) => key !== null) ? JSON.stringify([...keys].sort()) : null;
}

function routeConnectionKey(
  target: ConnectionCatalogEntry["target"],
  routeProfile: ConnectionCatalogEntry["profile"],
): string | null {
  const entry = { profile: routeProfile };
  if (target._tag === "RelayConnectionTarget")
    return JSON.stringify([target._tag, target.environmentId]);
  const profile = Option.getOrNull(entry.profile);
  if (target._tag === "SshConnectionTarget") {
    if (profile?._tag !== "SshConnectionProfile") return null;
    const { alias, hostname, username, port } = profile.target;
    return JSON.stringify([target._tag, target.environmentId, alias, hostname, username, port]);
  }
  const baseUrls =
    target._tag === "PrimaryConnectionTarget"
      ? [target.httpBaseUrl, target.wsBaseUrl]
      : profile?._tag === "BearerConnectionProfile"
        ? [profile.httpBaseUrl, profile.wsBaseUrl]
        : null;
  if (baseUrls === null) return null;
  try {
    const urls = baseUrls.map((baseUrl) => new URL(baseUrl));
    if (
      !["http:", "https:"].includes(urls[0]!.protocol) ||
      !["ws:", "wss:"].includes(urls[1]!.protocol) ||
      urls.some((url) => url.username || url.password)
    )
      return null;
    return JSON.stringify([
      target._tag,
      target.environmentId,
      ...urls.map((url) => url.href.replace(/\/+$/, "")),
    ]);
  } catch {
    return null;
  }
}
