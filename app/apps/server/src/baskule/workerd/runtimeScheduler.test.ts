import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import { makeRuntimeScheduler } from "./runtimeScheduler.ts";

describe("shared cell scheduler", () => {
  it.live("reproduces a discarded request timer leaving its dispatcher suspended", () =>
    Effect.promise(async () => {
      const callbacks: Array<() => void> = [];
      const scheduler = new Scheduler.MixedScheduler("async", (callback) => {
        callbacks.push(callback);
        return () => {};
      });
      const dispatcher = scheduler.makeDispatcher();
      const observed: number[] = [];
      dispatcher.scheduleTask(() => observed.push(1), 0);
      // The request retires and its timer is discarded. A later event queues more work.
      dispatcher.scheduleTask(() => observed.push(2), 0);
      await Promise.resolve();
      expect(callbacks).toHaveLength(1);
      expect(observed).toEqual([]);
      dispatcher.flush();
      expect(observed).toEqual([1, 2]);
    }),
  );

  it.effect("retains the sync scheduler for shared services and later request contexts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(makeRuntimeScheduler(), scope);
        const scheduler = yield* Effect.provide(Scheduler.Scheduler, context);
        expect(scheduler.executionMode).toBe("sync");
        const dispatcher = scheduler.makeDispatcher();
        const observed: number[] = [];
        dispatcher.scheduleTask(() => observed.push(1), 0);
        yield* Effect.promise(() => Promise.resolve());
        dispatcher.scheduleTask(() => observed.push(2), 0);
        yield* Effect.promise(() => Promise.resolve());
        expect(observed).toEqual([1, 2]);
        yield* Effect.provide(Effect.yieldNow, context);
        expect(yield* Effect.provide(Effect.succeed("descriptor completed"), context)).toBe(
          "descriptor completed",
        );
      }),
    ),
  );
});
