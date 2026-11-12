import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as HostedLayers from "./hostedLayers.ts";

it.effect("descriptor/session reads bypass pending recovery but return its recorded failure", () =>
  Effect.gen(function* () {
    const gate = yield* ServerRuntimeStartup.makeCommandGate;
    const startup = Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
      awaitCommandReady: gate.awaitCommandReady,
      checkStartupFailure: gate.checkStartupFailure,
      enqueueCommand: gate.enqueueCommand,
      markHttpListening: Effect.void,
    });
    const routes = Layer.mergeAll(
      HttpRouter.add("GET", "/.well-known/t3/environment", HttpServerResponse.text("descriptor")),
      HttpRouter.add("GET", "/api/auth/session", HttpServerResponse.text("session")),
    ).pipe(
      Layer.provide(HostedLayers.layerCommandReadiness),
      Layer.provideMerge(startup),
      Layer.provide(HttpServer.layerServices),
    );
    const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
    try {
      for (const path of ["/.well-known/t3/environment", "/api/auth/session"]) {
        const response = yield* Effect.promise(() =>
          app.handler(new Request(`http://space${path}`)),
        );
        assert.equal(response.status, 200);
      }
      yield* gate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: null,
          port: 443,
          cause: "recovery fixture",
        }),
      );
      for (const path of ["/.well-known/t3/environment", "/api/auth/session"]) {
        const response = yield* Effect.promise(() =>
          app.handler(new Request(`http://space${path}`)),
        );
        assert.equal(response.status, 500);
      }
    } finally {
      yield* Effect.promise(() => app.dispose());
    }
  }),
);
