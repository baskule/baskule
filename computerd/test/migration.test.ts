import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { migrationScript } from "../src/docker.ts";

for (const scenario of ["absent legacy", "target absent", "target incomplete", "target complete"]) {
  test(scenario, () => {
    const root = mkdtempSync(join(tmpdir(), "migration-"));
    const legacy = join(root, "legacy"), target = join(root, "target");
    const source = join(legacy, "volumes/disk/_data");
    mkdirSync(target, { recursive: true });
    if (scenario !== "absent legacy") {
      mkdirSync(join(source, "home"), { recursive: true });
      writeFileSync(join(source, "home/data"), "legacy");
    }
    if (scenario.startsWith("target ") && scenario !== "target absent") {
      mkdirSync(join(target, "home"));
      writeFileSync(join(target, "home/data"), "new");
      writeFileSync(join(target, "stale"), "");
    }
    if (scenario === "target complete") writeFileSync(join(target, ".baskule-migrated"), "");
    try {
      execFileSync("sh", ["-ec", migrationScript.replaceAll("/legacy", legacy).replaceAll("/target", target), "migration", "disk"]);
      if (scenario === "absent legacy") assert.equal(existsSync(join(target, ".baskule-migrated")), false);
      else {
        assert.equal(readFileSync(join(target, "home/data"), "utf8"), scenario === "target complete" ? "new" : "legacy");
        assert.equal(existsSync(join(target, "stale")), scenario === "target complete");
        assert.ok(existsSync(join(target, ".baskule-migrated")));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
