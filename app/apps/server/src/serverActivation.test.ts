import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as ServerActivation from "./serverActivation.ts";

it.effect("a parked child cannot miss an already completed activation", () =>
  Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    yield* Deferred.succeed(activation, undefined);
    const fiber = yield* ServerActivation.forkParkedFiber(Effect.succeed("ran")).pipe(
      Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
    );
    assert.equal(yield* Fiber.join(fiber), "ran");
  }),
);

it.effect("closing the scope cancels a parked child before it can do work", () =>
  Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    let runs = 0;
    const fiber = yield* ServerActivation.forkParkedFiber(
      Effect.sync(() => {
        runs++;
      }),
    ).pipe(
      Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      Scope.provide(scope),
    );
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.succeed(activation, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
    assert.equal(runs, 0);
  }),
);
