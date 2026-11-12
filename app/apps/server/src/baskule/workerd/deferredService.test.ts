import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { deferredService } from "./deferredService.ts";

class Value extends Context.Service<Value, { readonly owner: string }>()(
  "t3/baskule/workerd/deferredService.test/Value",
) {}
class Owner extends Context.Service<Owner, string>()(
  "t3/baskule/workerd/deferredService.test/Owner",
) {}

describe("Space deferred acquisition", () => {
  it.effect("shares concurrent acquisition, captures its Space, and releases on disposal", () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let starts = 0;
      let closes = 0;
      const layer = Layer.effect(
        Value,
        Effect.acquireRelease(
          Effect.gen(function* () {
            starts++;
            const owner = yield* Owner;
            yield* Deferred.succeed(acquired, undefined);
            yield* Deferred.await(release);
            return { owner };
          }),
          () =>
            Effect.sync(() => {
              closes++;
            }),
        ),
      );
      const scope = yield* Scope.make();
      const get = yield* deferredService(
        Layer.build(layer).pipe(Effect.map(Context.get(Value))),
      ).pipe(Effect.provideService(Owner, "space-a"), Scope.provide(scope));
      expect(starts).toBe(0);
      const first = yield* Effect.forkChild(get.pipe(Effect.provideService(Owner, "wrong-space")));
      yield* Deferred.await(acquired);
      const second = yield* Effect.forkChild(get);
      yield* Deferred.succeed(release, undefined);
      const a = yield* Fiber.join(first);
      expect(yield* Fiber.join(second)).toBe(a);
      expect(a.owner).toBe("space-a");
      expect(starts).toBe(1);
      yield* Scope.close(scope, Exit.void);
      expect(closes).toBe(1);
      expect(Exit.isFailure(yield* Effect.exit(get))).toBe(true);
    }),
  );

  it.effect("does not acquire unused resources and keeps distinct Spaces independent", () =>
    Effect.gen(function* () {
      let starts = 0;
      const layer = Layer.sync(Value, () => ({ owner: String(++starts) }));
      const unused = yield* Scope.make();
      const unusedService = yield* deferredService(
        Layer.build(layer).pipe(Effect.map(Context.get(Value))),
      ).pipe(Scope.provide(unused));
      yield* Scope.close(unused, Exit.void);
      expect(starts).toBe(0);
      expect(Exit.isFailure(yield* Effect.exit(unusedService))).toBe(true);
      const a = yield* Scope.make();
      const b = yield* Scope.make();
      const getA = yield* deferredService(
        Layer.build(layer).pipe(Effect.map(Context.get(Value))),
      ).pipe(Scope.provide(a));
      const getB = yield* deferredService(
        Layer.build(layer).pipe(Effect.map(Context.get(Value))),
      ).pipe(Scope.provide(b));
      expect((yield* getA).owner).toBe("1");
      expect((yield* getB).owner).toBe("2");
      yield* Scope.close(a, Exit.void);
      expect((yield* getB).owner).toBe("2");
      yield* Scope.close(b, Exit.void);
    }),
  );
  it.effect.each([false, true])(
    "retries first acquisition and caches only success (defect=%s)",
    (defect) =>
      Effect.gen(function* () {
        let attempts = 0;
        const layer = Layer.effect(
          Value,
          Effect.suspend(() => {
            attempts++;
            if (attempts === 1) return defect ? Effect.die("transient") : Effect.fail("transient");
            return Effect.succeed({ owner: "recovered" });
          }),
        );
        const get = yield* deferredService(Layer.build(layer).pipe(Effect.map(Context.get(Value))));
        expect(Exit.isFailure(yield* Effect.exit(get))).toBe(true);
        expect((yield* get).owner).toBe("recovered");
        expect((yield* get).owner).toBe("recovered");
        expect(attempts).toBe(2);
      }),
  );

  it.effect("refuses first use from a closing scope finalizer", () =>
    Effect.gen(function* () {
      let starts = 0;
      let blocked = false;
      const scope = yield* Scope.make();
      const get = yield* deferredService(
        Layer.build(Layer.sync(Value, () => ({ owner: String(++starts) }))).pipe(
          Effect.map(Context.get(Value)),
        ),
      ).pipe(Scope.provide(scope));
      yield* Effect.addFinalizer(() =>
        Effect.exit(get).pipe(
          Effect.map((exit) => {
            blocked = Exit.isFailure(exit);
          }),
        ),
      ).pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      expect(blocked).toBe(true);
      expect(starts).toBe(0);
    }),
  );
});
