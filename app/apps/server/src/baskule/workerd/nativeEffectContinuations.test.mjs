import { expect, test } from "vite-plus/test";
import { build } from "esbuild";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { nativeEffectContinuations } from "./nativeEffectContinuations.mjs";

test("native continuations retain cancellation and complete automatic yields and race cleanup", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-continuations-"));
  try {
    const outfile = NodePath.join(dir, "fixture.mjs");
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { withBootScheduler } from "./src/baskule/workerd/bootScheduler.mjs";
export async function run() {
  const controller = new AbortController();
  try {
    return await withBootScheduler(() => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      let resumed = 0, cancelled = 0, yielded = 0, cleaned = 0;
      const ready = yield* Deferred.make();
      let resume;
      const child = yield* Effect.callback(continueWith => {
        resume = continueWith;
        Deferred.doneUnsafe(ready, Effect.void);
        return Effect.sync(() => { cancelled++; });
      }).pipe(Effect.andThen(Effect.sync(() => { resumed++; })), Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(child);
      resume(Effect.void);
      yield* Effect.yieldNow;
      yield* Effect.forEach(Array.from({ length: 5000 }), () => Effect.sync(() => { yielded++; }), { discard: true });
      const racing = yield* Deferred.make();
      const winner = yield* Effect.raceFirst(
        Deferred.await(racing).pipe(Effect.as("winner")),
        Deferred.succeed(racing, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { cleaned++; }))),
      );
      return { resumed, cancelled, yielded, cleaned, winner };
    }))), controller.signal);
  } finally { controller.abort(); }
}`,
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      plugins: [nativeEffectContinuations],
    });
    const { run } = await import(NodeURL.pathToFileURL(outfile).href);
    expect(await run()).toEqual({
      resumed: 0,
      cancelled: 1,
      yielded: 5000,
      cleaned: 1,
      winner: "winner",
    });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
