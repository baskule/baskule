import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { nativeEffectContinuations } from "../../../app/apps/server/src/baskule/workerd/nativeEffectContinuations.mjs";

it.each(["../../", "../../../app/apps/server/"])("keeps %s's bundled default dispatcher runnable when request timers are discarded", async (directory) => {
  const bundle = await build({
    stdin: {
      contents: `import * as Context from "effect/Context";
        import * as Scheduler from "effect/Scheduler";
        export const scheduler = Context.get(Context.empty(), Scheduler.Scheduler);`,
      resolveDir: fileURLToPath(new URL(directory, import.meta.url).href),
    },
    bundle: true, format: "esm", platform: "neutral", write: false,
    external: ["node:*"], plugins: [nativeEffectContinuations],
  });
  const { scheduler } = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);
  const nativeTimer = vi.fn(() => 0);
  vi.stubGlobal("setImmediate", nativeTimer);
  try {
    const dispatcher = scheduler.makeDispatcher();
    const observed: number[] = [];
    dispatcher.scheduleTask(() => observed.push(1), 0);
    await Promise.resolve();
    dispatcher.scheduleTask(() => observed.push(2), 0);
    await Promise.resolve();
    expect(observed).toEqual([1, 2]);
    expect(nativeTimer).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
