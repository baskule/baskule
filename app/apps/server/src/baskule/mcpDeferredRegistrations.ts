// baskule: in a space cell, T3's MCP tools are registered on the first `/mcp` request instead of at boot. Building
// the tool descriptions (decoded parameter schemas, JSON Schema) is ~15 % of a cold space boot, and only the
// space's agent uses them, on its first turn. Provided by the workerd entry (spaceServer.ts); without it (upstream,
// tests) McpHttpServer registers at layer construction as before.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class McpDeferredRegistrations extends Context.Service<
  McpDeferredRegistrations,
  {
    /** Keeps a registration (its context already provided) for the first request. */
    readonly defer: (registration: Effect.Effect<void>) => Effect.Effect<void>;
    /** Runs the pending registrations once; concurrent callers wait for the same run. */
    readonly ensure: Effect.Effect<void>;
  }
>()("t3/baskule/mcpDeferredRegistrations") {}

export const layer = Layer.effect(
  McpDeferredRegistrations,
  Effect.gen(function* () {
    const pending: Array<Effect.Effect<void>> = [];
    const lock = yield* Semaphore.make(1);
    return McpDeferredRegistrations.of({
      defer: (registration) => Effect.sync(() => void pending.push(registration)),
      ensure: Effect.suspend(() =>
        pending.length === 0
          ? Effect.void
          : lock.withPermits(1)(
              Effect.suspend(() =>
                Effect.forEach(pending.splice(0), (run) => run, { discard: true }),
              ),
            ),
      ),
    });
  }),
);
