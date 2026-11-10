import { Deferred, Effect, Fiber, MutableHashMap, Option, Scheduler } from "effect";
import type { LayerMap } from "effect/LayerMap";

/** Capture the actual pending build, before awaiting it. A later deadline must not evict a replacement. */
export const acquireLocation = <K, I, E>(locations: LayerMap<K, I, E>, key: K, pending: (invalidate: Effect.Effect<void>) => void) =>
  Effect.gen(function* () {
    const acquisition = yield* Effect.forkChild(locations.contextEffect(key), { startImmediately: true });
    const current = () => locations.rcMap.state._tag === "Open"
      ? Option.getOrUndefined(MutableHashMap.get(locations.rcMap.state.map, key)) : undefined;
    const entry = current();
    // Keep the identity/completion check and cache removal in one scheduler turn.
    pending(Effect.suspend(() => entry && current() === entry && !Deferred.isDoneUnsafe(entry.deferred)
      ? locations.invalidate(key) : Effect.void).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)));
    return yield* Fiber.join(acquisition);
  });

export class LocationToolsTimeout extends Error {
  constructor(directory: string) { super(`Location tools did not settle at ${directory}`); }
}
