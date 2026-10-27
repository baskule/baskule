// (h) Restart the whole installation (deploy/v2 down.sh + up.sh): accounts, sessions, spaces, chats and the
// computer's files are all kept.
import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

import { RUN, ROOT, V2, applyIdleMinutes, chatRow, download, ensureSidebar, metric, newDevice, openChat, personApi, sh, shot, signInBrowser, startChat, toggleFiles, until, waitAnswer, waitComposer, world } from "./lib";

const S = "08-restart";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

test("(h) a full stack restart keeps accounts, chats and files", { tag: ["@lifecycle", "@slow"] }, async ({ browser }) => {
  test.setTimeout(900_000);
  const w = await world();
  const a = await newDevice(browser);
  await signInBrowser(a.page, w.alice);
  await waitComposer(a.page);
  const content = `kept across restart ${RUN}`;
  const id = await startChat(a.page, `Write minutes [[fake:tool shell {"command":"echo '${content}' > minutes.txt && cat minutes.txt"}]]`, w.acme.name);
  await waitAnswer(a.page, /Done: shell=kept across restart/, 180_000);
  await a.context.close();
  const aliceApi = await personApi(w.alice);
  const peopleBefore = (await (await personApi({ ...w.admin, name: "admin" })).get("/api/baskule/admin/users")).json.users.length;

  const t0 = Date.now();
  sh(`${V2}/down.sh`, [], { timeoutMs: 300_000 });
  const downMs = Date.now() - t0;
  sh(`${V2}/up.sh`, [], { timeoutMs: 600_000 });
  // up.sh redeploys with the e2e LLM override; the router container went down with the stack.
  sh(`${ROOT}/e2e/v2/llm/llm.sh`, ["router", process.env.E2E_REAL_BUDGET ?? "0.25"], { timeoutMs: 300_000 });
  applyIdleMinutes();
  const upMs = Date.now() - t0 - downMs;

  // The session cookie from before the restart still works; accounts and memberships are intact.
  const me = await until(async () => { const r = await aliceApi.get("/api/baskule/me"); return r.status === 200 ? r.json : null; }, 120_000, 2000, "me after restart");
  expect(me.spaces.map((s: any) => s.id)).toEqual(expect.arrayContaining([w.alice.personal, w.acme.id]));
  expect((await (await personApi({ ...w.admin, name: "admin" })).get("/api/baskule/admin/users")).json.users.length).toBe(peopleBefore);
  await personApi(w.bob, { fresh: true }); // password sign-in works after the restart

  // The chat, its answer and its file.
  const a2 = await newDevice(browser);
  await signInBrowser(a2.page, w.alice);
  await waitComposer(a2.page);
  await ensureSidebar(a2.page);
  await expect(chatRow(a2.page, id)).toBeVisible({ timeout: 60_000 });
  await openChat(a2.page, id);
  await expect(a2.page.getByText(/Done: shell=kept across restart/).first()).toBeVisible();
  await toggleFiles(a2.page, true);
  await a2.page.getByRole("treeitem", { name: "minutes.txt" }).click({ timeout: 90_000 });
  const dl = await download(a2.page, a2.page.getByRole("button", { name: "Download file" }));
  expect(sha(dl.bytes)).toBe(sha(`${content}\n`));
  // And the space still answers.
  await a2.page.locator('[contenteditable="true"]').first().fill("Still there? [[fake:text Yes, after the restart.]]");
  await a2.page.keyboard.press("Enter");
  await waitAnswer(a2.page, /Yes, after the restart/);
  await shot(a2.page, S, "01-after-restart");
  metric(S, { downMs, upMs, totalMs: Date.now() - t0 });
  console.log(`restart: down ${downMs} ms, up ${upMs} ms`);
  await a2.context.close();
});
