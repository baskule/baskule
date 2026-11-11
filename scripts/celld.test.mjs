import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("celld writes temporary cache files inside each worktree", () => {
  const base = mkdtempSync(join(tmpdir(), "baskule-dev-celld-launcher-"));
  const shared = join(base, "shared-tmp");
  mkdirSync(shared);
  try {
    for (const name of ["a", "b"]) {
      const root = join(base, name);
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, "fake-bin"), { recursive: true });
      mkdirSync(join(root, "deploy/celld/patches"), { recursive: true });
      mkdirSync(join(root, "deploy/celld/tests"), { recursive: true });
      for (const file of ["Dockerfile", "patches/test.patch", "tests/test.rs"]) writeFileSync(join(root, "deploy/celld", file), "fixture");
      copyFileSync(new URL("./celld.sh", import.meta.url), join(root, "scripts/celld.sh"));
      const binary = join(root, "fixture-celld");
      writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$1" > "$TMPDIR/cache-written"\n');
      chmodSync(binary, 0o755);
      const docker = join(root, "fake-bin/docker");
      const log = join(root, "docker-builds");
      writeFileSync(docker, `#!/bin/sh
case "$1" in
  build) echo build >> "$DOCKER_TEST_LOG" ;;
  create) echo fixture-container ;;
  cp) cp "$DOCKER_TEST_BINARY" "$3" ;;
  rm) exit 0 ;;
  *) exit 1 ;;
esac
`);
      chmodSync(docker, 0o755);
      const env = { ...process.env, TMPDIR: shared, PATH: `${join(root, "fake-bin")}:${process.env.PATH}`, DOCKER_TEST_BINARY: binary, DOCKER_TEST_LOG: log };
      const launch = () => spawnSync("bash", [join(root, "scripts/celld.sh"), name], { env, encoding: "utf8" });
      const result = launch();
      assert.equal(result.status, 0, result.stderr);
      const cache = join(root, ".run/celld-tmp/cache-written");
      assert.equal(existsSync(cache), true, "native cache must use the worktree's temporary directory");
      assert.equal(readFileSync(cache, "utf8"), name);
      assert.equal(launch().status, 0);
      assert.equal(readFileSync(log, "utf8"), "build\n", "unchanged runtime must reuse the extracted binary");
      writeFileSync(join(root, "deploy/celld/patches/test.patch"), "changed patch");
      const rebuilt = launch();
      assert.equal(rebuilt.status, 0, rebuilt.stderr);
      assert.equal(readFileSync(log, "utf8"), "build\nbuild\n", "patch changes must invalidate the binary cache");
    }
    assert.equal(existsSync(join(shared, "cache-written")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
