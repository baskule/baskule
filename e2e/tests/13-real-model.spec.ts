// Real-model subset (E2E_REAL=1, mistral-large-4 through the router, metered and logged): a plain question with no
// computer, and a shell task whose output file is checked on the computer.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { REAL, ROOT, RUN, composer, computerStatus, cx, metric, newDevice, routerUsage, shot, signInBrowser, startChat, waitAnswer, waitComposer, waitRunDone, world } from "./lib";

const S = "13-real-model";
test.skip(!REAL, "real-model subset: E2E_REAL=1");

test("(real) plain question: answered by mistral-large-4, no computer", { tag: ["@real"] }, async ({ browser }) => {
  const w = await world();
  const before = routerUsage();
  const a = await newDevice(browser);
  await signInBrowser(a.page, w.bob);
  await waitComposer(a.page);
  const t0 = Date.now();
  await startChat(a.page, "[[real]] What is 7 times 6? Reply with only the number.", "Personal");
  await waitAnswer(a.page, /42/, 120_000);
  await waitRunDone(a.page);
  expect(computerStatus(w.bob.personal).phase).not.toMatch(/ready|starting/);
  const after = routerUsage();
  expect(after.requests).toBeGreaterThan(before.requests);
  await shot(a.page, S, "01-plain");
  metric(S, { plainMs: Date.now() - t0, requests: after.requests - before.requests });
  await a.context.close();
});

test("(real) shell task: the file exists on the computer", { tag: ["@real"] }, async ({ browser }) => {
  const w = await world();
  const a = await newDevice(browser);
  await signInBrowser(a.page, w.alice);
  await waitComposer(a.page);
  const t0 = Date.now();
  const id = await startChat(a.page, `[[real]] Use the shell to create a file named luna-${RUN}.txt in your working directory containing exactly the text: hello from luna. Then reply with just: done.`, "Personal");
  await waitRunDone(a.page, 240_000);
  await waitAnswer(a.page, /done/i, 30_000);
  expect(cx(w.alice.personal, `cat /sandbox/space/chats/*${id.slice(-8)}/luna-${RUN}.txt`).trim()).toBe("hello from luna");
  await shot(a.page, S, "02-shell");
  metric(S, { shellMs: Date.now() - t0 });
  await a.context.close();
});


test("(real) PDF text reaches the model without starting a computer", { tag: ["@real"] }, async ({ browser }) => {
  const w = await world();
  const device = await newDevice(browser);
  await signInBrowser(device.page, w.bob);
  await waitComposer(device.page);
  expect(computerStatus(w.bob.personal).phase).toBe("absent");
  await composer(device.page).fill("[[real]] Quote the text printed inside the attached PDF. Reply only with that text.");
  const [chooser] = await Promise.all([
    device.page.waitForEvent("filechooser"),
    device.page.getByRole("button", { name: "Attach files" }).click(),
  ]);
  await chooser.setFiles({ name: "document.pdf", mimeType: "application/pdf", buffer: readFileSync(`${ROOT}/e2e/fixtures/attachment.pdf`) });
  await expect(device.page.getByText("document.pdf").first()).toBeVisible();
  await device.page.getByRole("button", { name: "Submit message", exact: true }).click();
  await waitAnswer(device.page, /Baskule PDF attachment test/, 120_000);
  await waitRunDone(device.page);
  expect(computerStatus(w.bob.personal).phase).toBe("absent");
  await shot(device.page, S, "03-pdf");
  await device.context.close();
});
