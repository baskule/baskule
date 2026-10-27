// Opt-in release check against the configured production provider, without the test router.
// Run Playwright directly while holding the stack lock, after llm.sh restore.
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  ROOT, computerStatus, cx, metric, newDevice, sendInCurrent, shot,
  signInBrowser, startChat, waitAnswer, waitComposer, waitRunDone, world,
} from "./lib";

test.skip(process.env.E2E_DIRECT_REAL !== "1", "explicit production-provider smoke check only");

test("normal provider: greeting stays lazy, then creates DOCX and PDF in the same chat", { tag: ["@real"] }, async ({ browser }) => {
  test.setTimeout(420_000);
  expect(existsSync(`${ROOT}/.run/e2e-product-settings.json`), "test router must be disabled").toBe(false);
  const w = await world();
  const a = await newDevice(browser);
  try {
    await signInBrowser(a.page, w.alice);
    await waitComposer(a.page);
    expect(computerStatus(w.alice.personal).phase).toBe("absent");
    const started = Date.now();
    const id = await startChat(a.page, "Dis bonjour en un mot, sans utiliser aucun outil.", "Personal");
    await waitAnswer(a.page, /bonjour/i, 120_000);
    await waitRunDone(a.page);
    expect(computerStatus(w.alice.personal).phase).toBe("absent");
    const greetingMs = Date.now() - started;
    await sendInCurrent(a.page, "Create two real downloadable documents in your working directory: release-check.docx and release-check.pdf, each containing the sentence Baskule document check. Use your shell and file tools; install Python libraries if needed. Verify that both files exist, then provide download links. Do not just describe how to do it.");
    await waitAnswer(a.page, /release-check\.pdf/, 240_000);
    await waitRunDone(a.page, 240_000);
    // Validate the generated formats independently of the model's claim.
    const result = cx(w.alice.personal, `python3 - <<'PY'
import glob, pathlib, zipfile
p = pathlib.Path(glob.glob('/sandbox/space/chats/*${id.slice(-8)}')[0])
with zipfile.ZipFile(p/'release-check.docx') as z:
    assert b'Baskule document check' in z.read('word/document.xml')
pdf = (p/'release-check.pdf').read_bytes()
assert pdf.startswith(b'%PDF-') and b'%%EOF' in pdf[-1024:]
print('verified DOCX and PDF')
PY`);
    expect(result).toContain("verified DOCX and PDF");
    await shot(a.page, "18-direct-provider", "documents");
    metric("18-direct-provider", { greetingMs, totalMs: Date.now() - started, formatsVerified: true });
  } finally {
    await a.context.close();
  }
});
