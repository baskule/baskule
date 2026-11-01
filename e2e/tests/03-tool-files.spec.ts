// (c) A tool task starts the computer; the output file appears in the chat's files and downloads byte-identical.
// The agent's shared browser uses T3 preview tools on the computer to read a public page.
import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

import { RUN, fakeRequests, computerStatus, cx, download, metric, newDevice, shot, signInBrowser, startChat, toggleFiles, until, waitAnswer, waitComposer, world } from "./lib";

const S = "03-tool-files";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

test("(c) a tool task starts the computer and its output file downloads", { tag: ["@files", "@computer"] }, async ({ browser }) => {
  const w = await world();
  const a = await newDevice(browser);
  await signInBrowser(a.page, w.alice);
  await waitComposer(a.page);
  const content = `quarterly report ${RUN}\nline two\n`;
  const cmd = `printf 'quarterly report ${RUN}\\nline two\\n' > report.txt && wc -c report.txt`;
  const t0 = Date.now();
  const id = await startChat(a.page, `Write the report file [[fake:tool shell ${JSON.stringify({ command: cmd })}]]`, "Personal");
  const answer = await waitAnswer(a.page, /Done: shell=/, 180_000);
  const toolMs = Date.now() - t0;
  expect(answer).toMatch(/report\.txt/);
  const st = await until(() => { const s = computerStatus(w.alice.personal); return s.phase === "ready" ? s : null; }, 30_000, 1000, "computer ready");
  expect(st.running).toBe(true);
  await shot(a.page, S, "01-tool-done");

  // Files panel: the chat's folder lists report.txt; preview and download.
  await toggleFiles(a.page, true);
  const item = a.page.getByRole("treeitem", { name: "report.txt" });
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.click();
  await expect(a.page.getByText("line two", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await shot(a.page, S, "02-file-preview");
  const dl = await download(a.page, a.page.getByRole("button", { name: "Download file" }));
  expect(dl.name).toBe("report.txt");
  expect(sha(dl.bytes)).toBe(sha(content));

  // Bytes on the computer are the same (the agent ran in /sandbox/space/chats/<chat>).
  const onComputer = cx(w.alice.personal, `cat /sandbox/space/chats/*${id.slice(-8)}/report.txt`);
  expect(onComputer.trim()).toBe(content.trim()); // cx.sh output loses trailing newlines
  metric(S, { threadId: id, toolTurnMs: toolMs, bytes: dl.bytes.length });
  await a.context.close();
});

test("(c) the agent's shared browser reads a public page (T3 preview)", { tag: ["@browser"] }, async ({ browser }) => {
  const w = await world();
  const a = await newDevice(browser);
  await signInBrowser(a.page, w.alice);
  await waitComposer(a.page);
  const t0 = Date.now();
  await startChat(a.page, `Open example.com [[fake:tool *preview_open {"url":"https://example.com"}]]`, "Personal");
  await waitAnswer(a.page, /Done: .*preview_open=/, 240_000);
  const request = fakeRequests().reverse().find((r) => (r.messages ?? []).some((m: any) => m.role === "tool" && JSON.stringify(m.content).includes("Example Domain")));
  expect(request, "the browser returned the public page title").toBeTruthy();
  await shot(a.page, S, "03-browser");
  metric(S, { browserTurnMs: Date.now() - t0 });
  await a.context.close();
});
