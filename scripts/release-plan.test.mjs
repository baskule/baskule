import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { features } from "./feature-map.mjs";
import { releaseCoverage, releaseFeatures, remainingFeatureChecks } from "./release-plan.mjs";

test("release removes covered loops and their selections but retains uncovered commands", () => {
  const feature = { checks: ["scripts/check worker space:files-and-attachments", "scripts/check web agent", "desktop/check.sh", "scripts/check feature:custom", "custom/check.sh", "scripts/check worker && echo extra"] };
  assert.deepEqual(remainingFeatureChecks(feature, ["worker", "space", "desktop"]), ["scripts/check web agent", "scripts/check feature:custom", "custom/check.sh", "scripts/check worker && echo extra"]);
  assert.deepEqual(remainingFeatureChecks(feature), feature.checks);
});

test("release shards cover all local journeys and uncovered custom checks exactly once", () => {
  const map = features();
  const whole = releaseFeatures(map);
  const shards = [1, 2, 3, 4].flatMap((n) => releaseFeatures(map, `${n}/4`));
  assert.deepEqual(shards.map((f) => f.name).sort(), whole.map((f) => f.name).sort());
  assert.deepEqual(releaseFeatures([...map].reverse(), "2/4").map((f) => f.name), releaseFeatures(map, "2/4").map((f) => f.name));
  assert.equal(new Set(shards.map((f) => f.name)).size, whole.length);
  assert.ok(whole.every((f) => !f.ownerRun));
  for (const feature of map.filter((f) => !f.ownerRun)) {
    assert.equal(whole.includes(feature), Boolean(feature.journeys || remainingFeatureChecks(feature, releaseCoverage).length));
  }
  assert.throws(() => releaseFeatures(map, "0/4"));
  assert.throws(() => releaseFeatures(map, "5/4"));
});

test("release CLI schedules journeys without redundant component checks", () => {
  const result = spawnSync(process.execPath, ["scripts/check.mjs", "release:journeys", "--shard", "2/4", "--fresh", "--dry-run"], { encoding: "utf8", env: { ...process.env, BASKULE_CHECK_RECORD: "0" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--shard 2\/4 --fully-parallel --workers 1/);
  for (const feature of features().filter((f) => !f.ownerRun && f.journeys)) assert.ok(result.stdout.includes(feature.journeys));
  assert.doesNotMatch(result.stdout, /release stack cleanup|feature:deployed-seams|feature:groups/);
});
