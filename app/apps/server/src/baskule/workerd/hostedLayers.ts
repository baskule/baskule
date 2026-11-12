// @effect-diagnostics effectFnOpportunity:off -- forwarding adapters retain the underlying service spans.
import { deferredService } from "./deferredService.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";

export const layerProviderRegistry = Layer.effect(
  ProviderRegistry.ProviderRegistry,
  Effect.gen(function* () {
    const service = yield* deferredService(
      Layer.build(ProviderRegistry.layer).pipe(
        Effect.map(Context.get(ProviderRegistry.ProviderRegistry)),
      ),
    );
    return ProviderRegistry.ProviderRegistry.of({
      getProviders: Effect.flatMap(service, (s) => s.getProviders),
      refresh: (provider) => Effect.flatMap(service, (s) => s.refresh(provider)),
      refreshInstance: (id) => Effect.flatMap(service, (s) => s.refreshInstance(id)),
      refreshAfterUpdate: (provider, id) =>
        Effect.flatMap(service, (s) => s.refreshAfterUpdate(provider, id)),
      refreshWorkspaceSnapshot: (input) =>
        Effect.flatMap(service, (s) => s.refreshWorkspaceSnapshot(input)),
      invalidateModelCaches: (input) =>
        Effect.flatMap(service, (s) => s.invalidateModelCaches(input)),
      refreshModelCatalog: Effect.flatMap(service, (s) => s.refreshModelCatalog),
      getProviderMaintenanceCapabilitiesForInstance: (id, provider, options) =>
        Effect.flatMap(service, (s) =>
          s.getProviderMaintenanceCapabilitiesForInstance(id, provider, options),
        ),
      setProviderMaintenanceActionState: (input) =>
        Effect.flatMap(service, (s) => s.setProviderMaintenanceActionState(input)),
      streamChanges: Stream.unwrap(Effect.map(service, (s) => s.streamChanges)),
    });
  }),
);

export const layerEnvironmentTheme = Layer.effect(
  EnvironmentTheme.EnvironmentThemeService,
  Effect.gen(function* () {
    const service = yield* deferredService(
      Layer.build(EnvironmentTheme.layer).pipe(
        Effect.map(Context.get(EnvironmentTheme.EnvironmentThemeService)),
      ),
    );
    return EnvironmentTheme.EnvironmentThemeService.of({
      current: Effect.flatMap(service, (s) => s.current),
      streamChanges: Stream.unwrap(Effect.map(service, (s) => s.streamChanges)),
    });
  }),
);

export const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.checkStartupFailure.pipe(Effect.orDie);
      // Identity/session reads cannot observe an unrecovered orchestration projection.
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        ["/.well-known/t3/environment", "/api/auth/session"].includes(request.url.split("?")[0]!)
      ) {
        return yield* httpEffect.pipe(
          Effect.tap(() => startup.checkStartupFailure.pipe(Effect.orDie)),
        );
      }
      yield* startup.awaitCommandReady.pipe(Effect.orDie);
      return yield* httpEffect;
    }),
  { global: true },
);
