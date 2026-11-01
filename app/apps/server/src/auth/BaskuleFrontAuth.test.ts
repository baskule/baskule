// baskule: BASKULE_AUTH_MODE=front (0.2, E7/E8).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAccessReadScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { encodeBaskuleIdentity, type BaskuleIdentity } from "../baskule/identity.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { frontSessionIdFor, revokeFrontSessions } from "./BaskuleFrontAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-baskule-front-auth-test-" })),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ BASKULE_AUTH_MODE: "front" }))),
);

const alice: BaskuleIdentity = {
  userId: "u-alice",
  name: "Alice",
  email: "alice@example.test",
  role: "member",
  sessionId: "ba-session-1",
  spaceRole: "owner",
};

const request = (headers: Record<string, string> = {}, url = "/api/auth/session") =>
  ({ url, cookies: {}, headers: { host: "space.cell", ...headers } }) as never;
const as = (identity: BaskuleIdentity, url?: string, extra: Record<string, string> = {}) =>
  request({ "x-baskule-identity": encodeBaskuleIdentity(identity), ...extra }, url);

it.layer(NodeServices.layer)("Baskule front auth mode", (it) => {
  it.effect("authenticates only through the identity header", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateHttpRequest(as(alice));
      expect(session.subject).toBe("u-alice");
      expect(session.sessionId).toBe(yield* frontSessionIdFor("ba-session-1"));
      expect(session.scopes).not.toContain(AuthSettingsWriteScope);
      expect(session.scopes).not.toContain(AuthAccessReadScope);
      expect((yield* auth.getSessionState(as(alice))).authenticated).toBe(true);

      const missing = yield* Effect.flip(auth.authenticateHttpRequest(request()));
      expect(missing._tag).toBe("ServerAuthMissingCredentialError");
      // A T3 bearer is no credential here, nor is a forged/garbled header.
      const bearer = yield* Effect.flip(
        auth.authenticateHttpRequest(request({ authorization: "Bearer x" })),
      );
      expect(bearer._tag).toBe("ServerAuthMissingCredentialError");
      const forged = yield* Effect.flip(
        auth.authenticateHttpRequest(request({ "x-baskule-identity": "eyJ1c2VySWQiOiJ4In0" })),
      );
      expect(forged._tag).toBe("ServerAuthInvalidCredentialError");
      expect((yield* auth.getSessionState(request())).authenticated).toBe(false);
    }).pipe(Effect.provide(layerAuth)),
  );

  it.effect("refuses pairing and token exchange", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const exchange = yield* Effect.flip(
        auth.exchangeBootstrapCredentialForAccessToken("dummy", undefined, {
          deviceType: "mobile",
        }),
      );
      expect(exchange._tag).toBe("ServerAuthInvalidCredentialError");
      const browser = yield* Effect.flip(
        auth.createBrowserSession("dummy", { deviceType: "desktop" }),
      );
      expect(browser._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerAuth)),
  );

  it.effect("binds WebSocket tickets to the identity that minted them", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateHttpRequest(as(alice));
      const { ticket } = yield* auth.issueWebSocketTicket(session, { use: "rpc" });
      const wsUrl = `/ws?wsTicket=${encodeURIComponent(ticket)}`;
      const upgraded = yield* auth.authenticateWebSocketUpgrade(as(alice, wsUrl), "rpc");
      expect(upgraded.sessionId).toBe(session.sessionId);
      const wrongAudience = yield* Effect.flip(
        auth.authenticateWebSocketUpgrade(as(alice, wsUrl), "media"),
      );
      expect(wrongAudience._tag).toBe("ServerAuthInvalidCredentialError");

      const bob = { ...alice, userId: "u-bob", sessionId: "ba-session-2" };
      const stolen = yield* Effect.flip(auth.authenticateWebSocketUpgrade(as(bob, wsUrl), "rpc"));
      expect(stolen._tag).toBe("ServerAuthInvalidCredentialError");
      const anonymous = yield* Effect.flip(
        auth.authenticateWebSocketUpgrade(request({}, wsUrl), "rpc"),
      );
      expect(anonymous._tag).toBe("ServerAuthMissingCredentialError");
    }).pipe(Effect.provide(layerAuth)),
  );

  it.effect("revokes by user or by session and re-activates on the next vouched request", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* auth.authenticateHttpRequest(as(alice));
      yield* auth.authenticateHttpRequest(as({ ...alice, sessionId: "ba-session-3" }));
      const { ticket } = yield* auth.issueWebSocketTicket(first);
      expect(yield* revokeFrontSessions(sessions, { userId: "u-alice" })).toBe(2);
      const revoked = yield* Effect.flip(sessions.verifyWebSocketToken(ticket));
      expect(revoked._tag).toBe("WebSocketSessionRevokedError");
      expect(yield* revokeFrontSessions(sessions, { sessionId: "ba-session-1" })).toBe(0);
      // The Worker vouches again (the member was re-added): the same session works again.
      const again = yield* auth.authenticateHttpRequest(as(alice));
      expect(again.sessionId).toBe(first.sessionId);
      expect((yield* sessions.verifyWebSocketToken(ticket)).sessionId).toBe(first.sessionId);
    }).pipe(Effect.provide(layerAuth)),
  );
});
