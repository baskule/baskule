import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "release-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = (name, files) => {
    const directory = join(root, "artifacts", name);
    mkdirSync(directory, { recursive: true });
    const checksums = Object.entries(files).map(([name, contents]) => {
      writeFileSync(join(directory, name), contents);
      return `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`;
    });
    writeFileSync(join(directory, "SHA256SUMS"), checksums.join(""));
  };
  artifact("backend", { "docker-compose.yml": "compose", "baskule.env.example": "example", "baskule-1.2.3.tgz": "chart", "images.txt": "image digests", "computer.tar.gz": "internal image archive" });
  artifact("linux-apps", { "Baskule.AppImage": "app", "latest-linux.yml": "updater", "compatibility.json": "[]", "hosted-web.tar.gz": "internal web bundle" });
  return {
    root, artifact,
    run: () => spawnSync("bash", [fileURLToPath(new URL("assemble-release.sh", import.meta.url))], { cwd: root, env: { ...process.env, VERSION: "1.2.3" }, encoding: "utf8" }),
  };
}

test("verification assembles installable assets with verifiable checksums, excluding internal bundles", t => {
  const f = fixture(t);
  f.artifact("native/native-android-arm64-1.2.3", { "Baskule.apk": "android", "STATUS.txt": "unsigned" });
  f.artifact("native/native-ios-simulator-1.2.3", { "simulator.zip": "simulator" });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(join(f.root, "release")).sort(), ["baskule.env.example", "Baskule.AppImage", "Baskule.apk", "SHA256SUMS", "backend-1.2.3-metadata.tar.gz", "baskule-1.2.3.tgz", "compatibility.json", "docker-compose.yml", "latest-linux.yml"].sort());
  const verify = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: join(f.root, "release"), encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  const metadata = spawnSync("tar", ["-tzf", "release/backend-1.2.3-metadata.tar.gz"], { cwd: f.root, encoding: "utf8" });
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.match(metadata.stdout, /images.txt/);
  assert.doesNotMatch(metadata.stdout, /computer.tar.gz/);
});

test("assembly rejects missing native artifacts", t => {
  const f = fixture(t);
  assert.notEqual(f.run().status, 0);
});

test("corrupted build artifacts fail assembly", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "artifacts/linux-apps/Baskule.AppImage"), "corrupted");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Baskule.AppImage: FAILED/);
});

test("native packages cannot overwrite another release asset", t => {
  const f = fixture(t);
  f.artifact("native/first", { "Baskule.apk": "first" });
  f.artifact("native/second", { "Baskule.apk": "second" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate release asset/);
});
