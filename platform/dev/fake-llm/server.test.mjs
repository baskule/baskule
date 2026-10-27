import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "./server.mjs";

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
