import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** Capture dependencies at Space construction; acquire and finalize in that Space's scope. */
export const deferredService = Effect.fn("Baskule.deferredService")(function* <S, E, R>(
  acquisition: Effect.Effect<S, E, R>,
) {
  const context = yield* Effect.context<R>();
  const scope = yield* Effect.scope;
  const checkOpen = Effect.suspend(() =>
    scope.state._tag === "Closed"
      ? Effect.die(new Error("The Space service scope is closed"))
      : Effect.void,
  );
  const acquire = yield* Effect.cachedWithTTL(
    checkOpen.pipe(Effect.andThen(acquisition), Effect.provideContext(context)),
    (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  );
  return checkOpen.pipe(Effect.andThen(acquire));
});
