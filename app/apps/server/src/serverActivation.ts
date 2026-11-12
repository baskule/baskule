import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

// baskule: register the scoped child immediately while the persistent activation gate parks its work.
export const forkParkedFiber = Effect.fn("serverActivation.forkParkedFiber")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<Fiber.Fiber<A, E>, never, Scope.Scope | R> {
  const activation = yield* ServerActivation;
  if (activation === undefined) {
    return yield* Effect.forkScoped(effect);
  }
  // forkScoped registers the child in this scope before returning. Activation is a
  // persistent gate, so the child cannot miss it even if it has not run yet.
  return yield* Effect.forkScoped(activation.pipe(Effect.andThen(effect)), {
    startImmediately: true,
  });
});

export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);
