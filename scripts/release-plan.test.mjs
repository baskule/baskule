import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.ok(whole.every((f) => !f.liveOnly));
  for (const feature of map.filter((f) => !f.liveOnly)) {
    assert.equal(whole.includes(feature), Boolean(feature.journeys || remainingFeatureChecks(feature, releaseCoverage).length));
  }
  assert.throws(() => releaseFeatures(map, "0/4"));
  assert.throws(() => releaseFeatures(map, "5/4"));
});

test("release CLI schedules journeys without redundant component checks", () => {
  const result = spawnSync(process.execPath, ["scripts/check.mjs", "release:journeys", "--shard", "2/4", "--fresh", "--dry-run"], { encoding: "utf8", env: { ...process.env, BASKULE_CHECK_RECORD: "0" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--shard 2\/4 --fully-parallel --workers 1/);
  for (const feature of features().filter((f) => !f.liveOnly && f.journeys)) assert.ok(result.stdout.includes(feature.journeys));
  assert.doesNotMatch(result.stdout, /release stack cleanup|feature:deployed-seams|feature:groups/);
});

test("live-only features require the explicit live gate", () => {
  const result = spawnSync(process.execPath, ["scripts/run-feature.mjs", "deployed-seams"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Live-installation feature:.*--live/);
  assert.deepEqual(releaseFeatures([{ name: "live", liveOnly: true, checks: ["echo live"] }]), []);
});

for (const failProfile of ["", "full"]) test(`release journeys stop each profile before the next, including after failure (${failProfile || "success"})`, t => {
  const root = mkdtempSync(join(tmpdir(), "release-journeys-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["scripts", "e2e", "bin", ".agents/skills/verify-baskule/features"]) mkdirSync(join(root, path), { recursive: true });
  for (const name of ["check.mjs", "check-lock.mjs", "feature-map.mjs", "release-plan.mjs"]) cpSync(new URL(name, import.meta.url), join(root, "scripts", name));
  for (const [name, profile] of [["first", "full"], ["second", "light"]]) {
    writeFileSync(join(root, `.agents/skills/verify-baskule/features/${name}.md`), `---\npaths: ["platform/**"]\nprofile: "${profile}"\n---\n`);
  }
  writeFileSync(join(root, "bin/pnpm"), `#!/bin/sh
set -eu
test ! -f "$FIXTURE_ROOT/running" || { echo 'Stack already running with its saved configuration' >&2; exit 2; }
echo "$JOURNEY_PROFILE" > "$FIXTURE_ROOT/running"
echo "start $JOURNEY_PROFILE" >> "$FIXTURE_ROOT/events"
output=../.run/journeys/results
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; break; fi
  shift
done
rm -rf "$output"
mkdir -p "$output"
echo "$JOURNEY_PROFILE" > "$output/evidence.txt"
test "$JOURNEY_PROFILE" != "$FAIL_PROFILE"
`, { mode: 0o755 });
  writeFileSync(join(root, "scripts/stack"), `#!/bin/sh
set -eu
test "$1" = down
echo "stop $(cat "$FIXTURE_ROOT/running")" >> "$FIXTURE_ROOT/events"
rm "$FIXTURE_ROOT/running"
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(root, "scripts/check.mjs"), "release:journeys", "--fresh"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_ROOT: root, FAIL_PROFILE: failProfile, BASKULE_CHECK_RECORD: "0" },
  });
  assert.equal(result.status, failProfile ? 1 : 0, result.stdout + result.stderr);
  assert.deepEqual(readFileSync(join(root, "events"), "utf8").trim().split("\n"), ["start full", "stop full", "start light", "stop light"]);
  assert.equal(existsSync(join(root, "running")), false);
  for (const profile of ["full", "light"]) assert.equal(readFileSync(join(root, `.run/journeys/results/${profile}/evidence.txt`), "utf8").trim(), profile);
});
