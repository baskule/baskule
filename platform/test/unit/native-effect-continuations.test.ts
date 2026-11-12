import { build } from "esbuild";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { nativeEffectContinuations } from "../../../app/apps/server/src/baskule/workerd/nativeEffectContinuations.mjs";
import { embeddedAgent } from "../../src/agent/build.mjs";
import { bindBootScheduler, withBootScheduler } from "../../../app/apps/server/src/baskule/workerd/bootScheduler.mjs";

const bundle = async (contents: string, resolveDir: string) => (await build({
  stdin: { contents, resolveDir }, bundle: true, format: "esm", platform: "neutral", write: false,
  external: ["node:*"], plugins: [nativeEffectContinuations, embeddedAgent],
})).outputFiles[0]!.text;

it.each(["../../", "../../../app/apps/server/"])("keeps %s's dispatcher timers in each boot event after a foreign request retires", async directory => {
  const helper = fileURLToPath(new URL("../../../app/apps/server/src/baskule/workerd/bootScheduler.mjs", import.meta.url).href);
  const source = await bundle(`import { bindBootScheduler } from ${JSON.stringify(helper)};
    import * as Context from "effect/Context";
    import * as Scheduler from "effect/Scheduler";
    export const scheduler = Context.get(Context.empty(), Scheduler.Scheduler);
    export const pinned = () => new Scheduler.MixedScheduler("async", bindBootScheduler());`, fileURLToPath(new URL(directory, import.meta.url).href));
  const { scheduler, pinned } = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const events = new AsyncLocalStorage<string>();
  const timers: { owner: string | undefined; run: () => void }[] = [];
  let expected = 3;
  let scheduled!: () => void;
  let ready = new Promise<void>(resolve => { scheduled = resolve; });
  const capture = (run: () => void) => {
    const inOrigin = AsyncLocalStorage.snapshot();
    timers.push({ owner: events.getStore(), run: () => inOrigin(run) });
    if (timers.length === expected) scheduled();
  };
  vi.stubGlobal("setImmediate", capture);
  vi.stubGlobal("clearImmediate", () => {});
  vi.stubGlobal("setTimeout", capture);
  vi.stubGlobal("clearTimeout", () => {});
  try {
    const first = events.run("boot-1", () => withBootScheduler(() => scheduler.makeDispatcher()));
    const second = events.run("boot-2", () => withBootScheduler(() => scheduler.makeDispatcher()));
    const pinnedFirst = events.run("boot-1", () => withBootScheduler(() => pinned()));
    const crossBoot = events.run("boot-2", () => withBootScheduler(() => pinnedFirst.makeDispatcher()));
    const observed: number[] = [];
    events.run("retired-request", () => {
      first.scheduleTask(() => {
        expect(scheduler.makeDispatcher()).toBeDefined();
        observed.push(1);
      }, 0);
      second.scheduleTask(() => observed.push(2), 0);
      crossBoot.scheduleTask(() => observed.push(4), 0);
    });
    await ready;
    expect(observed).toEqual([]);
    expect(timers.map(timer => timer.owner)).toEqual(["boot-1", "boot-2", "boot-1"]);
    for (const timer of timers.splice(0)) events.run(timer.owner!, timer.run);
    expected = 1;
    ready = new Promise<void>(resolve => { scheduled = resolve; });
    first.scheduleTask(() => observed.push(3), 0);
    await ready;
    expect(timers.map(timer => timer.owner)).toEqual(["boot-1"]);
    timers[0]!.run();
    expect(observed).toEqual([1, 2, 4, 3]);
  } finally { vi.unstubAllGlobals(); }
});

it("fails fast when the OpenCode scheduler owner is absent or closed", () => {
  expect(() => bindBootScheduler()).toThrow("context is missing");
  const controller = new AbortController();
  const schedule = withBootScheduler(() => bindBootScheduler(), controller.signal);
  controller.abort();
  expect(() => schedule(() => {})).toThrow("scheduler is closed");
});

it("keeps busy Code Mode interruptible and lets a polling program's host tool complete", async () => {
  const core = realpathSync(fileURLToPath(new URL("../../node_modules/@opencode/core", import.meta.url).href));
  const scheduler = fileURLToPath(new URL("../../../app/apps/server/src/baskule/workerd/bootScheduler.mjs", import.meta.url).href);
  const source = await bundle(`import { CodeMode, Tool } from "@opencode/codemode";
    import { Effect, Exit, Schema } from "effect";
    import assert from "node:assert/strict";
    import { bindBootScheduler, withBootScheduler } from ${JSON.stringify(scheduler)};
    await withBootScheduler(async () => {
      const controller = new AbortController();
      const events = [];
      const heartbeat = setTimeout(() => events.push("heartbeat"), 0);
      const interrupt = setTimeout(() => { events.push("interrupt"); controller.abort(); }, 50);
      const exit = await Effect.runPromiseExit(CodeMode.execute({ code: "while (true) {}" }), { signal: controller.signal });
      clearTimeout(heartbeat); clearTimeout(interrupt);
      assert(Exit.hasInterrupts(exit));
      assert.deepEqual(events, ["heartbeat", "interrupt"]);
      const value = await Effect.runPromise(CodeMode.execute({
        code: "let r; tools.delayed({}).then(value => { r = value; }); while (r === undefined) await null; return r;",
        tools: { delayed: Tool.make({ description: "host timer", input: Schema.Struct({}), output: Schema.String,
          execute: () => Effect.promise(() => new Promise(resolve => setTimeout(() => resolve("ready"), 50))) }) },
      }));
      assert.equal(value.ok, true);
      assert.equal(value.value, "ready");
      console.log("busy interrupt, heartbeat, polling tool: passed");
    });`, core);
  // The child deadline also detects a scheduler that starves the test runner's own timers.
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, ["--input-type=module"], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Code Mode child failed: ${error.message}\n${stderr}`));
      else resolve(stdout);
    });
    child.stdin!.end(source);
  });
  expect(output).toContain("busy interrupt, heartbeat, polling tool: passed");
});
