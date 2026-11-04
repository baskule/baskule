import { test } from "node:test";
import assert from "node:assert/strict";
import { guardScript, guardChain, privateRanges } from "../src/guard.ts";
test("guard blocks private destinations and host INPUT without restricting public ports", () => {
  const script = guardScript(["172.30.0.0/24"]);
  for (const range of privateRanges) assert.ok(script.includes(`-d ${range}`));
  assert.ok(script.includes("INPUT -s 172.30.0.0/24"));
  assert.ok(script.includes("--dst-type LOCAL"));
  assert.ok(script.includes("-I DOCKER-USER 1"));
  assert.ok(script.includes("head -n 1"));
  assert.ok(script.includes("iptables-restore -w --noflush"));
  assert.ok(script.includes(`-F ${guardChain(["172.30.0.0/24"])}`));
  assert.ok(!script.includes("--dport"));
});
test("IPv6 and invalid networks", () => {
  assert.ok(guardScript(["fd00::/64"]).includes("-d fe80::/10"));
  for (const subnet of ["x", "1.2.3.4/33", "1.2.3.4/24;id"]) assert.throws(() => guardScript([subnet]));
  assert.throws(() => guardScript([]));
});

test("subnet sets own stable distinct chains and ordered leading jumps", () => {
  const a = "172.30.0.0/24", b = "172.31.0.0/24";
  assert.equal(guardChain([a,b]), guardChain([b,a,a]));
  assert.notEqual(guardChain([a]), guardChain([b]));
  const script = guardScript([b,a]);
  assert.ok(script.includes("head -n 2"));
  for (const parent of ["INPUT", "FORWARD", "DOCKER-USER"]) {
    assert.ok(script.includes(`-I ${parent} 1 -s ${a}`));
    assert.ok(script.includes(`-D ${parent} -s ${a}`));
  }
});
