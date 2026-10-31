// (j) Uploads: an image attached to a message reaches the model as an image part (no computer needed); another file
// type (CSV) is put where the agent can use it on the computer.
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { RUN, ROOT, adminApi, runId, personApi, chooseSpace, composer, computerStatus, openNewChat, fakeRequests, metric, newDevice, shot, signInBrowser, userMessages, waitAnswer, waitRunDone, waitComposer, world } from "./lib";

const S = "10-uploads";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function sendWithFile(page: Page, text: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  // File chips live inside the editor: replacing its text after attaching deletes the file.
  await composer(page).fill(text);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach files" }).click()]);
  await chooser.setFiles(file);
  await expect(page.getByText(file.name).first()).toBeVisible();
  // The chip appears before upload completes; click waits for the submit control to enable.
  await page.getByRole("button", { name: "Submit message", exact: true }).click();
  await expect(userMessages(page).filter({ hasText: text.slice(0, 20) }).last()).toBeVisible({ timeout: 30_000 });
}

test("(j) an image reaches the model; a CSV reaches the computer", { tag: ["@files", "@chat"] }, async ({ browser }) => {
  const w = await world();
  const b = await newDevice(browser);
  await signInBrowser(b.page, w.bob);
  await waitComposer(b.page);

  // Image, in a fresh chat of Acme (whose computer state we record): the model gets an image part.
  await openNewChat(b.page);
  await chooseSpace(b.page, w.acme.name);
  await sendWithFile(b.page, `What is in this picture? [[fake:describe]]`, { name: `pixel-${RUN}.png`, mimeType: "image/png", buffer: PNG });
  const answer = await waitAnswer(b.page, /attachments: image\/png/, 120_000);
  expect(answer).toMatch(/image\/png x1/);
  const req = fakeRequests().reverse().find((r) => JSON.stringify(r.messages ?? []).includes("fake:describe"));
  expect(JSON.stringify(req?.messages ?? [])).toMatch(/"image_url"/);
  await shot(b.page, S, "01-image");
  await waitRunDone(b.page);

  // CSV: the agent reads it on the computer, by name, from its chat folder (or wherever the upload is put).
  const csvName = `data-${RUN}.csv`;
  const csv = `city,visits\nLyon,${RUN.length}\nNantes,7\n`;
  await sendWithFile(b.page, `Sum the visits [[fake:tool shell {"command":"f=$(find /sandbox -name '${csvName}' 2>/dev/null | head -1); echo found:$f; cat \\"$f\\""}]]`, { name: csvName, mimeType: "text/csv", buffer: Buffer.from(csv) });
  const out = await waitAnswer(b.page, /Done: shell=found:/, 180_000);
  expect(out, "the CSV is on the computer").toMatch(/found:\/sandbox\/\S+data-/);
  expect(out).toContain("Nantes,7");
  await shot(b.page, S, "02-csv");
  metric(S, { computerAfter: computerStatus(w.acme.id).phase });
  await b.context.close();
});


test("(j) images and PDFs reach the model directly without starting a computer", { tag: ["@files", "@chat", "@computer"] }, async ({ browser }) => {
  const person = { name: `PDF ${runId()}`, email: `pdf-${runId()}@e2e.test`, password: `pdf-${runId()}-password` };
  const admin = await adminApi();
  const created = await admin.post("/api/baskule/admin/users", person);
  expect([200, 201, 409]).toContain(created.status);
  const api = await personApi(person);
  const me = await api.get("/api/baskule/me");
  const personal = me.json.spaces.find((s: any) => s.kind === "personal").id;
  expect(computerStatus(personal).phase).toBe("absent");
  const device = await newDevice(browser);
  await signInBrowser(device.page, person);
  await waitComposer(device.page);
  await sendWithFile(device.page, "Describe this image [[fake:describe]]", {
    name: `image-${RUN}.png`, mimeType: "image/png", buffer: PNG,
  });
  await waitAnswer(device.page, /image\/png x1/);
  await waitRunDone(device.page);
  expect(computerStatus(personal).phase).toBe("absent");
  await sendWithFile(device.page, "Describe this PDF [[fake:describe]]", {
    name: `document-${RUN}.pdf`, mimeType: "application/pdf",
    buffer: readFileSync(`${ROOT}/e2e/fixtures/attachment.pdf`),
  });
  await waitAnswer(device.page, /application\/pdf x1/);
  await waitRunDone(device.page);
  const request = fakeRequests().reverse().find((r) => JSON.stringify(r.messages ?? []).includes("Describe this PDF"));
  const parts = (request?.messages ?? []).filter((m: any) => m.role === "user")
    .flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
  expect(parts.some((part: any) => (part.type === "file" || part.type === "input_file") &&
    (part.file ?? part).file_data?.startsWith("data:application/pdf;base64,"))).toBe(true);
  expect(computerStatus(personal).phase).toBe("absent");
  await shot(device.page, S, "03-pdf-no-computer");
  await device.context.close();
});
