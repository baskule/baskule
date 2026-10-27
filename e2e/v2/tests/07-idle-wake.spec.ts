// (g) A computer that stays idle stops (computerd idle stop, E2E_IDLE_MINUTES); the next task wakes it and the files
// written before the sleep are still there. Bob's personal space (no browser stream kept open by earlier scenarios).
// Runs in the serial lifecycle phase: it lowers computerd's idle stop to E2E_IDLE_WAKE_MINUTES (0.5) for its own wait,
// the same code path with a shorter threshold, and restores the run's value afterwards.
import { expect, test } from "@playwright/test";

import { RUN, applyIdleMinutes, computerStatus, metric, newDevice, shot, signInBrowser, startChat, until, waitAnswer, waitComposer, world } from "./lib";

const S = "07-idle-wake";

test("(g) idle computer stops; a new task wakes it with its files intact", { tag: ["@lifecycle", "@slow", "@computer"] }, async ({ browser }) => {
  test.setTimeout(600_000);
  const idleMinutes = process.env.E2E_IDLE_WAKE_MINUTES ?? "0.5";
  applyIdleMinutes(idleMinutes);
  test.info().attach("idle-minutes", { body: idleMinutes });
  try {
    const w = await world();
    const b = await newDevice(browser);
    await signInBrowser(b.page, w.bob);
    await waitComposer(b.page);
    const file = `/sandbox/space/home/notes-${RUN}.txt`;
    await startChat(b.page, `Keep a note [[fake:tool shell {"command":"echo kept-${RUN} > ${file} && cat ${file}"}]]`, "Personal");
    await waitAnswer(b.page, new RegExp(`Done: shell=kept-${RUN}`), 180_000);
    expect(computerStatus(w.bob.personal).phase).toBe("ready");
    await b.context.close(); // nobody watching: the computer must still go to sleep on its own

    const t0 = Date.now();
    const stopped = await until(() => { const s = computerStatus(w.bob.personal); return s.phase === "stopped" || s.phase === "absent" ? s : null; },
      (Number(idleMinutes) * 60 + 180) * 1000, 2000, "computer stopped by idle");
    const idleStopMs = Date.now() - t0;
    expect(stopped.running).toBe(false);

    const b2 = await newDevice(browser);
    await signInBrowser(b2.page, w.bob);
    await waitComposer(b2.page);
    const t1 = Date.now();
    await startChat(b2.page, `Read my note [[fake:tool shell {"command":"cat ${file}"}]]`, "Personal");
    await waitAnswer(b2.page, new RegExp(`Done: shell=kept-${RUN}`), 180_000);
    const wakeTurnMs = Date.now() - t1;
    expect(computerStatus(w.bob.personal).phase).toBe("ready");
    await shot(b2.page, S, "01-woken");
    metric(S, { idleStopMs, wakeTurnMs });
    console.log(`idle stop after ${Math.round(idleStopMs / 1000)} s of waiting; wake + task ${wakeTurnMs} ms`);
    await b2.context.close();
  } finally {
    applyIdleMinutes(); // the run's value (E2E_IDLE_MINUTES)
  }
});
