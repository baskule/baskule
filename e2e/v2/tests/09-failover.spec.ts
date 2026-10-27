// (i) celld node failover while idle: each node in turn is killed (docker kill = crash) between two turns of an open
// chat; the chat continues on the surviving node (cells respawn from the bucket), then the node rejoins.
import { expect, test } from "@playwright/test";

import { BASE, personApi, until, metric, newDevice, sendInCurrent, sh, shot, signInBrowser, startChat, waitAnswer, waitComposer, waitHealthy, world } from "./lib";

const S = "09-failover";

test("(i) killing a celld node during idle: the chat continues", { tag: ["@lifecycle", "@slow"] }, async ({ browser }) => {
  test.setTimeout(900_000);
  const w = await world();
  const a = await newDevice(browser);
  await signInBrowser(a.page, w.alice);
  await waitComposer(a.page);
  await startChat(a.page, "Failover drill [[fake:text ready for the drill]]", w.acme.name);
  await waitAnswer(a.page, /ready for the drill/);
  const aliceApi = await personApi(w.alice);
  const bobApi = await personApi(w.bob);
  const timings: Record<string, number> = {};
  for (const node of ["a", "b"]) {
    const c = `baskule02-celld-${node}`;
    sh("docker", ["kill", c]);
    const t0 = Date.now();
    try {
      // The tab's socket to the dead node drops; while it reconnects the composer ignores Enter (the text stays).
      // A user presses send again: so does the test, until the message is accepted.
      const text = `After losing node ${node} [[fake:text answered without node ${node}]]`;
      await a.page.locator('[contenteditable="true"]').first().fill(text);
      const accepted = a.page.locator('[data-message-role="user"]').filter({ hasText: `After losing node ${node}` });
      for (let i = 0; i < 90 && !(await accepted.isVisible().catch(() => false)); i++) {
        await a.page.locator('[contenteditable="true"]').first().click();
        await a.page.keyboard.press("Enter");
        await a.page.waitForTimeout(2000); // no-fixed-sleep-allow: Retry sending until the user message appears, at most ninety attempts.
      }
      timings[`node${node}AcceptedMs`] = Date.now() - t0;
      await expect(accepted).toBeVisible();
      await waitAnswer(a.page, new RegExp(`answered without node ${node}`), 180_000);
      timings[`node${node}AnswerMs`] = Date.now() - t0;
      await shot(a.page, S, `0${node === "a" ? 1 : 2}-without-${node}`);
    } finally {
      sh("docker", ["start", c]);
      waitHealthy(c, 180);
    }
    // Recover every previously used space, not only the active team chat. A healthy node can still
    // leave an idle personal cell stuck; the descriptor is exactly what new browser connections need.
    for (const [label, api, space] of [
      ["alicePersonal", aliceApi, w.alice.personal],
      ["bobPersonal", bobApi, w.bob.personal],
      ["team", aliceApi, w.acme.id],
    ] as const) {
      const recoveredAt = Date.now();
      await until(async () => {
        const response = await fetch(`${BASE}/s/${space}/.well-known/t3/environment`, {
          headers: { cookie: api.cookie }, signal: AbortSignal.timeout(10_000),
        });
        return response.ok && Boolean((await response.json()).environmentId);
      }, 120_000, 2000, `${label} descriptor recovered after node ${node}`);
      timings[`node${node}${label}RecoveryMs`] = Date.now() - recoveredAt;
    }
    // Both nodes back before the next drill (the edge's health check marks it up within seconds).
    for (const n of ["a", "b"]) waitHealthy(`baskule02-celld-${n}`, 180);
  }
  // After both drills, a last turn on the healed fleet.
  await sendInCurrent(a.page, "Fleet healed? [[fake:text healed]]");
  await waitAnswer(a.page, /healed/);
  metric(S, timings);
  console.log(`failover: ${JSON.stringify(timings)}`);
  await a.context.close();
});
