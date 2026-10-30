// baskule: no-auth mode uses a fixed persisted owner session for requests without usable credentials.
// Persistence keeps WebSocket tickets valid. Pairing accepts dummy credentials so desktop and
// mobile can register a private-network environment. Modeled on ReusableDevAuth.
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as PairingGrantStore from "./PairingGrantStore.ts";

export const BASKULE_AUTH_MODE_ENV = "BASKULE_AUTH_MODE";
export const BASKULE_NO_AUTH_SESSION_ID = AuthSessionId.make("baskule-no-auth-owner");
export const BASKULE_NO_AUTH_SUBJECT = "baskule-no-auth";
export const BASKULE_NO_AUTH_EXPIRES_AT = DateTime.makeUnsafe("9999-12-31T23:59:59.999Z");
// Not a secret: in this mode presenting no credential grants the same session.
const BASKULE_NO_AUTH_CREDENTIAL = "baskule-no-auth";

// Review M1/M5: the shared no-auth session must not reach features outside the alpha's scope.
// Terminals are a shell inside the server container (not the agent's computer); access management
// could revoke the one session every device shares. The UI already gates on these scopes.
const BASKULE_NO_AUTH_DROPPED_SCOPES: ReadonlySet<string> = new Set([
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthAccessWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
]);
export const BASKULE_NO_AUTH_SCOPES = AuthStandardClientScopes.filter(
  (scope) => !BASKULE_NO_AUTH_DROPPED_SCOPES.has(scope),
);

export interface BaskuleNoAuth {
  readonly credential: string;
  readonly sessionId: AuthSessionId;
  readonly matches: (credential: string) => boolean;
}

/** Read from the environment through Effect Config, so tests can supply it. */
export const resolveBaskuleNoAuth: Effect.Effect<BaskuleNoAuth | undefined> = Effect.gen(
  function* () {
    const mode = yield* Config.String(BASKULE_AUTH_MODE_ENV).pipe(Config.option);
    if (Option.getOrUndefined(mode)?.trim().toLowerCase() !== "none") return undefined;
    return {
      credential: BASKULE_NO_AUTH_CREDENTIAL,
      sessionId: BASKULE_NO_AUTH_SESSION_ID,
      matches: (credential: string) => credential === BASKULE_NO_AUTH_CREDENTIAL,
    };
  },
).pipe(Effect.orDie);

/** The persisted owner session row, created once and reused across restarts. */
export const baskuleNoAuthSessionRow = (issuedAt: DateTime.Utc) => ({
  sessionId: BASKULE_NO_AUTH_SESSION_ID,
  subject: BASKULE_NO_AUTH_SUBJECT,
  scopes: BASKULE_NO_AUTH_SCOPES,
  method: "browser-session-cookie" as const,
  client: {
    label: "Baskule (no auth)",
    ipAddress: null,
    userAgent: null,
    deviceType: "unknown" as const,
    os: null,
    browser: null,
  },
  issuedAt,
  expiresAt: BASKULE_NO_AUTH_EXPIRES_AT,
});

/**
 * An owner row from an older build (wider scopes) or one revoked through the access API would
 * otherwise persist across restarts; every start puts it back to the current shape (review M5).
 */
const encodeScopesJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
export const resetBaskuleNoAuthSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE auth_sessions
    SET revoked_at = NULL, scopes = ${encodeScopesJson(BASKULE_NO_AUTH_SCOPES)}
    WHERE session_id = ${BASKULE_NO_AUTH_SESSION_ID}
  `;
});

export const warnBaskuleNoAuth = (host: string | undefined) =>
  Effect.logWarning(
    `BASKULE_AUTH_MODE=none: authentication is DISABLED. Anyone who can reach ${host ?? "this server"} has full owner access. Bind only to a private or Tailscale address.`,
  );

/**
 * In no-auth mode any pairing credential that the store rejects becomes an
 * owner grant, so `/api/auth/browser-session` and `/api/auth/token` (the
 * bootstrap exchange used by desktop and mobile) always issue a real session.
 */
export function withBaskuleNoAuthGrants(
  store: PairingGrantStore.PairingGrantStore["Service"],
  noAuth: BaskuleNoAuth | undefined,
): PairingGrantStore.PairingGrantStore["Service"] {
  if (!noAuth) return store;
  return {
    ...store,
    consume: (credential, input) =>
      store.consume(credential, input).pipe(
        Effect.orElseSucceed(
          () =>
            ({
              method: "one-time-token",
              scopes: BASKULE_NO_AUTH_SCOPES,
              subject: BASKULE_NO_AUTH_SUBJECT,
              label: "Baskule client",
              expiresAt: BASKULE_NO_AUTH_EXPIRES_AT,
            }) satisfies PairingGrantStore.BootstrapGrant,
        ),
      ),
  };
}
