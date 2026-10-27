// baskule: BASKULE_AUTH_MODE=none behaviour (D7).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAccessWriteScope, AuthTerminalOperateScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  BASKULE_NO_AUTH_SCOPES,
  BASKULE_NO_AUTH_SESSION_ID,
  BASKULE_NO_AUTH_SUBJECT,
} from "./BaskuleNoAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layerAuth = (env: Record<string, string>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-baskule-no-auth-test-" })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
  );

const NO_AUTH = { BASKULE_AUTH_MODE: "none" };
const HOST = "100.64.0.42:47080";

const request = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  ({ url: "/ws", cookies, headers: { host: HOST, ...headers } }) as never;

const metadata = { deviceType: "mobile" as const };

it.layer(NodeServices.layer)("Baskule no-auth mode", (it) => {
  it.effect("authenticates credential-less requests as the persisted owner session", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateHttpRequest(request());
      expect(session.sessionId).toBe(BASKULE_NO_AUTH_SESSION_ID);
      expect(session.scopes).toEqual(BASKULE_NO_AUTH_SCOPES);
      // Review M1: no shell inside the server container, no access management.
      expect(session.scopes).not.toContain(AuthTerminalOperateScope);
      expect(session.scopes).not.toContain(AuthAccessWriteScope);

      const state = yield* auth.getSessionState(request({ origin: `http://${HOST}` }));
      expect(state.authenticated).toBe(true);

      // A stale or foreign credential falls back too, so a browser cannot get locked out.
      const stale = yield* auth.authenticateHttpRequest(
        request({ authorization: "Bearer not-a-real-token" }),
      );
      expect(stale.sessionId).toBe(BASKULE_NO_AUTH_SESSION_ID);
    }).pipe(Effect.provide(layerAuth(NO_AUTH))),
  );

  it.effect("issues WebSocket tickets that verify against the stored session", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateHttpRequest(request());
      const { ticket } = yield* auth.issueWebSocketTicket(session);
      const upgraded = yield* auth.authenticateWebSocketUpgrade({
        url: `/ws?wsTicket=${encodeURIComponent(ticket)}`,
        cookies: {},
        headers: { host: HOST },
      } as never);
      expect(upgraded.sessionId).toBe(BASKULE_NO_AUTH_SESSION_ID);

      const plainUpgrade = yield* auth.authenticateWebSocketUpgrade(
        request({ origin: `http://${HOST}` }),
      );
      expect(plainUpgrade.sessionId).toBe(BASKULE_NO_AUTH_SESSION_ID);
    }).pipe(Effect.provide(layerAuth(NO_AUTH))),
  );

  it.effect("exchanges any bootstrap credential for a real bearer or browser session", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
        "dummy",
        undefined,
        metadata,
      );
      expect(token.token_type).toBe("Bearer");
      const bearer = yield* sessions.verify(token.access_token);
      expect(bearer.subject).toBe(BASKULE_NO_AUTH_SUBJECT);
      expect(bearer.sessionId).not.toBe(BASKULE_NO_AUTH_SESSION_ID);
      const viaBearer = yield* auth.authenticateHttpRequest(
        request({ authorization: `Bearer ${token.access_token}` }),
      );
      expect(viaBearer.sessionId).toBe(bearer.sessionId);

      const browser = yield* auth.createBrowserSession("anything", metadata);
      expect(browser.response.authenticated).toBe(true);
      expect((yield* sessions.verify(browser.sessionToken)).subject).toBe(BASKULE_NO_AUTH_SUBJECT);
    }).pipe(Effect.provide(layerAuth(NO_AUTH))),
  );

  it.effect("keeps working after the shared owner session is revoked (review M5)", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
        "dummy",
        undefined,
        metadata,
      );
      const bearer = yield* sessions.verify(token.access_token);
      expect(bearer.scopes).toEqual(BASKULE_NO_AUTH_SCOPES);
      yield* sessions.revokeAllExcept(bearer.sessionId);
      yield* sessions.revoke(BASKULE_NO_AUTH_SESSION_ID);
      const session = yield* auth.authenticateHttpRequest(request());
      expect(session.sessionId).toBe(BASKULE_NO_AUTH_SESSION_ID);
    }).pipe(Effect.provide(layerAuth(NO_AUTH))),
  );

  it.effect("still refuses cross-origin browser requests", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const error = yield* Effect.flip(
        auth.authenticateHttpRequest(
          request({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
        ),
      );
      expect(error._tag).toBe("ServerAuthMissingCredentialError");
    }).pipe(Effect.provide(layerAuth(NO_AUTH))),
  );

  it.effect("keeps normal auth when the mode is not set", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const error = yield* Effect.flip(auth.authenticateHttpRequest(request()));
      expect(error._tag).toBe("ServerAuthMissingCredentialError");
      const exchange = yield* Effect.flip(
        auth.exchangeBootstrapCredentialForAccessToken("dummy", undefined, metadata),
      );
      expect(exchange._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerAuth({}))),
  );
});
