import test from "node:test";
import assert from "node:assert/strict";
import { createServer, plan } from "./server.mjs";

test("title prompts return valid structured output rather than replaying chat markers", () => {
  const reply = plan({ messages: [{ role: "user", content: 'Generate a title. Return JSON with keys title and needsRefinement. Message: [[fake:long 300]] [[fake:delay 100]]' }] });
  assert.deepEqual(JSON.parse(reply.text), { title: "Fake chat title", needsRefinement: false });
  assert.equal(reply.delay, 5);
});
test("ordinary first-turn long streams retain all words and their requested delay", () => {
  const reply = plan({ messages: [{ role: "user", content: "[[fake:long 80]] [[fake:delay 40]]" }] });
  assert.equal(reply.text.split(" ").length, 80);
  assert.equal(reply.text.split(" ").at(-1), "word80");
  assert.equal(reply.delay, 40);
});
test("ordinary text and error markers retain their behaviour", () => {
  assert.equal(plan({ messages: [{ role: "user", content: "[[fake:text alpha]]" }] }).text, "alpha");
  assert.equal(plan({ messages: [{ role: "user", content: "[[fake:error 429]]" }] }).error, 429);
});

test("native dictation accepts multipart audio and retains metadata without recording bytes", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/_fake/reset`, { method: "POST" });
    const form = new FormData();
    form.set("model", "fake-transcribe");
    form.set("file", new Blob([new Uint8Array([0, 255, 128, 1])], { type: "audio/mp4" }), "recording.m4a");
    const response = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "Voice input verified." });
    const requests = await fetch(`${base}/_fake/requests`).then((r) => r.json());
    assert.deepEqual(requests, [{ kind: "transcription", model: "fake-transcribe", filename: "recording.m4a", type: "audio/mp4", bytes: 4 }]);

    form.set("file", new Blob([]), "empty.m4a");
    const empty = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form });
    assert.equal(empty.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
