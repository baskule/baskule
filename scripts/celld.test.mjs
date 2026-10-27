import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("celld writes temporary cache files inside each worktree", () => {
  const base = mkdtempSync(join(tmpdir(), "osdev-celld-launcher-"));
  const shared = join(base, "shared-tmp");
  mkdirSync(shared);
  try {
    for (const name of ["a", "b"]) {
      const root = join(base, name);
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, ".tools/bin"), { recursive: true });
      copyFileSync(new URL("./celld.sh", import.meta.url), join(root, "scripts/celld.sh"));
      const binary = join(root, ".tools/bin/celld");
      writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$1" > "$TMPDIR/cache-written"\n');
      chmodSync(binary, 0o755);
      const result = spawnSync("bash", [join(root, "scripts/celld.sh"), name], { env: { ...process.env, TMPDIR: shared }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const cache = join(root, ".run/celld-tmp/cache-written");
      assert.equal(existsSync(cache), true, "native cache must use the worktree's temporary directory");
      assert.equal(readFileSync(cache, "utf8"), name);
    }
    assert.equal(existsSync(join(shared, "cache-written")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
