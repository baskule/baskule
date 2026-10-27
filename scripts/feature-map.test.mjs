import { test } from "node:test";
import assert from "node:assert/strict";
import { journeyTags, validateFeatures, touchedFeatures } from "./feature-map.mjs";

test("every journey needs its own known feature, even when a sibling is tagged", () => {
  const parsed = journeyTags('test("a", { tag: ["@feature:chat"] }, () => {}); test("b", () => {}); test("c", {tag: "@feature:typo"}, () => {});', "example.spec.mjs");
  assert.deepEqual(parsed, [["chat"], [], ["typo"]]);
  const errors = validateFeatures([{ name: "chat", paths: ["chat/**"], profile: "light", journeys: "@feature:chat" }], parsed.map((features) => ({ file: "example", features })));
  assert.match(errors.join("\n"), /no feature tag/);
  assert.match(errors.join("\n"), /unknown feature typo/);
});
test("checks preserve unmigrated features; an empty feature and dangling journey fail", () => {
  const entry = { name: "chat", paths: ["chat/**"], profile: "light" };
  assert.match(validateFeatures([entry], []).join(), /neither journeys nor checks/);
  assert.deepEqual(validateFeatures([{ ...entry, checks: ["scripts/check space"] }], []), []);
  assert.match(validateFeatures([{ ...entry, journeys: "@feature:chat" }], []).join(), /no journey/);
});
test("a chat source change selects the chat features", () => {
  for (const path of ["platform/src/space/index.ts", "app/apps/server/src/baskule/newChatStart.ts", "app/apps/server/src/baskule/author.ts", "app/apps/server/src/baskule/workerd/space-server.ts", "app/packages/provider-core/src/server/textGenerationPrompts.ts", "platform/dev/fake-llm/server.mjs", "app/apps/web/src/components/chat/MessageTimeline.tsx", "e2e/journeys/fixtures.mjs"]) {
    const names = touchedFeatures([path]).map((f) => f.name);
    for (const name of ["personal-chat", "team-chat", "conversation-controls"]) assert.ok(names.includes(name), `${path}: ${name}`);
  }
});

test("conditional skip and fixme annotations are not additional journeys", () => {
  assert.deepEqual(journeyTags('test("a", { tag: "@feature:chat" }, () => { test.skip(true, "reason"); test.fixme(false); });', "example.spec.mjs"), [["chat"]]);
  assert.deepEqual(journeyTags('test.skip("not covered", () => {});', "example.spec.mjs"), [[]]);
});
