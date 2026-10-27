// baskule: `BASKULE_AUTH_MODE=front` (Baskule Alpha 0.2, architecture v3 E7/E8).
//
// A space's T3 server runs in a SpaceCell that only the Baskule Worker can reach. The Worker
// authenticates the member (Better Auth), checks Origin and membership, strips any inbound
// identity header and forwards `x-baskule-identity`. In this mode that header is the only
// credential:
// - each (user, Worker session) pair maps to one persisted T3 session row, so WebSocket tickets,
//   `awaitInvalidation` and revocation keep working;
// - a WebSocket ticket only authenticates an upgrade that carries the identity it was minted for;
// - T3's own pairing, bearer exchange and browser-session cookies are refused.
// MCP client sessions (minted by the server for its provider, never by a client) keep T3's
// behaviour.
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  authScopeResponse,
  type AuthSessionState,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServerRequest } from "effect/http";

import {
  BASKULE_IDENTITY_HEADER,
  parseBaskuleIdentity,
  type BaskuleIdentity,
} from "../baskule/identity.ts";
import { BASKULE_AUTH_MODE_ENV } from "./BaskuleNoAuth.ts";
import type * as EnvironmentAuth from "./EnvironmentAuth.ts";
import type * as SessionStore from "./SessionStore.ts";

export const BASKULE_FRONT_SESSION_PREFIX = "baskule-front-";
const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";
const FRONT_EXPIRES_AT = DateTime.makeUnsafe("9999-12-31T23:59:59.999Z");

/** What a member can do in a space. Settings, providers, access management are installation-managed. */
export const BASKULE_FRONT_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
];

export const resolveBaskuleFrontAuth: Effect.Effect<boolean> = Config.String(
  BASKULE_AUTH_MODE_ENV,
).pipe(
  Config.option,
  Effect.map((mode) => Option.getOrUndefined(mode)?.trim().toLowerCase() === "front"),
  Effect.orDie,
);

const sha256Hex = (value: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  });

/** The T3 session id for a Worker session: stable, and not the Worker's own id. */
export const frontSessionIdFor = (workerSessionId: string) =>
  sha256Hex(`baskule-front\0${workerSessionId}`).pipe(
    Effect.map((hash) => AuthSessionId.make(`${BASKULE_FRONT_SESSION_PREFIX}${hash}`)),
  );

export const identityFromRequest = (
  request: HttpServerRequest.HttpServerRequest,
): BaskuleIdentity | undefined => parseBaskuleIdentity(request.headers[BASKULE_IDENTITY_HEADER]);

const encodeScopes = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

type Errors = {
  readonly missing: () => EnvironmentAuth.ServerAuthMissingCredentialError;
  readonly invalid: (diagnostic: string) => EnvironmentAuth.ServerAuthInvalidCredentialError;
  readonly internal: (cause: unknown) => EnvironmentAuth.ServerAuthSessionCredentialValidationError;
};

/**
 * Replaces the client-facing authentication of `service` with the front mode. `errors` comes
 * from EnvironmentAuth so this module does not import it at runtime (the two modules refer to
 * each other).
 */
export const withBaskuleFrontAuth = Effect.fn("BaskuleFrontAuth.make")(function* (
  service: EnvironmentAuth.EnvironmentAuth["Service"],
  sessions: SessionStore.SessionStore["Service"],
  errors: Errors,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.logInfo(
    "BASKULE_AUTH_MODE=front: requests authenticate with x-baskule-identity only.",
  );

  /** Creates the session row, or re-activates it: the Worker has just vouched for this identity. */
  const ensureSession = (identity: BaskuleIdentity) =>
    Effect.gen(function* () {
      const sessionId = yield* frontSessionIdFor(identity.sessionId);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, method, scopes, client_label, client_device_type,
          issued_at, expires_at, revoked_at
        ) VALUES (
          ${sessionId}, ${identity.userId}, 'browser-session-cookie',
          ${encodeScopes(BASKULE_FRONT_SCOPES)}, ${identity.name || identity.email}, 'unknown',
          ${now}, ${DateTime.formatIso(FRONT_EXPIRES_AT)}, NULL
        )
        ON CONFLICT (session_id) DO UPDATE SET
          revoked_at = NULL,
          subject = excluded.subject,
          scopes = excluded.scopes,
          client_label = excluded.client_label
        WHERE auth_sessions.revoked_at IS NOT NULL
          OR auth_sessions.subject IS NOT excluded.subject
          OR auth_sessions.scopes IS NOT excluded.scopes
          OR auth_sessions.client_label IS NOT excluded.client_label
      `;
      return {
        sessionId,
        subject: identity.userId,
        method: "browser-session-cookie" as const,
        scopes: BASKULE_FRONT_SCOPES,
        expiresAt: FRONT_EXPIRES_AT,
      } satisfies EnvironmentAuth.AuthenticatedSession;
    }).pipe(Effect.mapError(errors.internal));

  const authenticate = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    EnvironmentAuth.AuthenticatedSession,
    | EnvironmentAuth.ServerAuthMissingCredentialError
    | EnvironmentAuth.ServerAuthInvalidCredentialError
    | EnvironmentAuth.ServerAuthSessionCredentialValidationError
  > => {
    const identity = identityFromRequest(request);
    if (identity === undefined) {
      return request.headers[BASKULE_IDENTITY_HEADER] === undefined
        ? Effect.fail(errors.missing())
        : Effect.fail(errors.invalid("Malformed Baskule identity."));
    }
    return ensureSession(identity);
  };

  const refused = (what: string) =>
    Effect.fail(
      errors.invalid(`${what} is unsupported in Baskule: sign in through the Baskule front.`),
    );

  const authenticateWebSocketUpgrade: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    (request) =>
      Effect.gen(function* () {
        const session = yield* authenticate(request);
        const url = HttpServerRequest.toURL(request);
        const ticket = Option.isSome(url)
          ? url.value.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM)
          : null;
        if (ticket && ticket.trim().length > 0) {
          const ticketSession = yield* sessions
            .verifyWebSocketToken(ticket)
            .pipe(Effect.mapError(() => errors.invalid("Invalid WebSocket ticket.")));
          if (ticketSession.sessionId !== session.sessionId) {
            return yield* errors.invalid("The WebSocket ticket belongs to another session.");
          }
        }
        return session;
      });

  return {
    ...service,
    getSessionState: (request) =>
      Effect.flatMap(service.getDescriptor(), (auth) =>
        authenticate(request).pipe(
          Effect.map((session): AuthSessionState => ({
            authenticated: true,
            auth,
            ...authScopeResponse(session.scopes),
            sessionMethod: session.method,
            expiresAt: DateTime.toUtc(FRONT_EXPIRES_AT),
          })),
          Effect.catchTags({
            ServerAuthMissingCredentialError: () =>
              Effect.succeed<AuthSessionState>({ authenticated: false, auth }),
            ServerAuthInvalidCredentialError: () =>
              Effect.succeed<AuthSessionState>({ authenticated: false, auth }),
          }),
        ),
      ),
    authenticateHttpRequest: authenticate,
    authenticateBrowserSession: authenticate,
    authenticateWebSocketUpgrade,
    createBrowserSession: () => refused("Browser-session pairing"),
    exchangeBootstrapCredentialForAccessToken: () => refused("Token exchange"),
  } satisfies EnvironmentAuth.EnvironmentAuth["Service"];
});

/**
 * Closes the sockets of a user, or of one Worker session (ControlCell → SpaceCell revoke).
 * Returns how many T3 sessions were revoked.
 */
export const revokeFrontSessions = Effect.fn("BaskuleFrontAuth.revoke")(function* (
  sessions: SessionStore.SessionStore["Service"],
  target: { readonly userId?: string | undefined; readonly sessionId?: string | undefined },
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = new Set<string>();
  if (target.sessionId) ids.add(yield* frontSessionIdFor(target.sessionId));
  if (target.userId) {
    const rows = yield* sql<{ session_id: string }>`
      SELECT session_id FROM auth_sessions
      WHERE subject = ${target.userId} AND revoked_at IS NULL
        AND session_id LIKE ${`${BASKULE_FRONT_SESSION_PREFIX}%`}
    `;
    for (const row of rows) ids.add(row.session_id);
  }
  let revoked = 0;
  for (const id of ids) {
    if (yield* sessions.revoke(AuthSessionId.make(id))) revoked++;
  }
  return revoked;
});
