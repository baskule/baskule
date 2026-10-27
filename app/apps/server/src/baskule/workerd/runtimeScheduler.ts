import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";

/** Keep shared fibers independent of request-owned scheduler timers (stock celld #258). */
export const makeRuntimeScheduler = () =>
  Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
