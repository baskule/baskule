import { test } from "node:test";
import assert from "node:assert/strict";
import { guardScript, privateRanges } from "../src/guard.ts";
test("guard blocks private destinations and host INPUT without restricting public ports", () => {
  const script = guardScript(["172.30.0.0/24"]);
  for (const range of privateRanges) assert.ok(script.includes(`-d ${range}`));
  assert.ok(script.includes("INPUT -s 172.30.0.0/24"));
  assert.ok(script.includes("--dst-type LOCAL"));
  assert.ok(script.includes("-C DOCKER-USER"));
  assert.ok(!script.includes("--dport"));
});
test("IPv6 and invalid networks", () => {
  assert.ok(guardScript(["fd00::/64"]).includes("ip6tables -w -C DOCKER-USER -s fd00::/64 -d fe80::/10"));
  for (const subnet of ["x", "1.2.3.4/33", "1.2.3.4/24;id"]) assert.throws(() => guardScript([subnet]));
  assert.throws(() => guardScript([]));
});
