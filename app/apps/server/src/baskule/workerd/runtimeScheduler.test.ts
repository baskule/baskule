import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { makeRuntimeScheduler } from "./runtimeScheduler.ts";

describe("shared cell scheduler", () => {
  it("reproduces a discarded request timer leaving its dispatcher suspended", async () => {
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
  });

  it("retains the sync scheduler for shared services and later request contexts", async () => {
    const scope = Effect.runSync(Scope.make());
    const context = await Effect.runPromise(Layer.buildWithScope(makeRuntimeScheduler(), scope));
    try {
      // Mirrors SpaceServer's retained context and subsequent HTTP/service invocations.
      const run = Effect.runPromiseWith(context);
      const scheduler = await run(Scheduler.Scheduler);
      expect(scheduler.executionMode).toBe("sync");
      const dispatcher = scheduler.makeDispatcher();
      const observed: number[] = [];
      dispatcher.scheduleTask(() => observed.push(1), 0);
      await Promise.resolve();
      dispatcher.scheduleTask(() => observed.push(2), 0);
      await Promise.resolve();
      expect(observed).toEqual([1, 2]);
      await run(Effect.yieldNow);
      expect(await run(Effect.succeed("descriptor completed"))).toBe("descriptor completed");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
