import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

for (const [name, status, success] of [
  ["new tags", "404", true], ["existing tag", "200", false],
  ["unauthorized", "401", false], ["registry unavailable", "503", false], ["existing chart", "chart-exists", false],
]) test(`publication: ${name}`, () => {
  const work = mkdtempSync(resolve(tmpdir(), "publish-test-"));
  try {
    const refs = ["celld", "computerd", "openshell-gateway"].map(name => `ghcr.io/baskule/baskule-${name}:test`);
    const images = refs.map(ref => `${ref} unused-identity`).join("\n") + "\n";
    writeFileSync(resolve(work, "images.txt"), images);
    const files = { "images.txt": images, "baskule-0.5.0.tgz": "verified chart" };
    for (const ref of refs) files[`${ref.split("/").at(-1).split(":")[0]}.tar.gz`] = "verified archive";
    for (const [file, content] of Object.entries(files)) writeFileSync(resolve(work, file), content);
    writeFileSync(resolve(work, "SHA256SUMS"), Object.entries(files).map(([file, content]) => `${createHash("sha256").update(content).digest("hex")}  ${file}\n`).join(""));
    writeFileSync(resolve(work, "curl"), '#!/bin/bash\nif [[ "$*" == *ghcr.io/token* ]]; then echo \'{"token":"test-token"}\'; elif [[ "$*" == *charts/baskule/manifests/* && "$MOCK_STATUS" == chart-exists ]]; then echo 200; elif [[ "$*" == *baskule-openshell-gateway/manifests/* && "$MOCK_STATUS" != chart-exists ]]; then echo "$MOCK_STATUS"; else echo 404; fi\n', { mode: 0o755 });
    writeFileSync(resolve(work, "docker"), '#!/bin/bash\necho "$*" >> "$MOCK_LOG"\n', { mode: 0o755 });
    writeFileSync(resolve(work, "helm"), '#!/bin/bash\necho "helm $*" >> "$MOCK_LOG"\nif [[ "$1" == registry ]]; then cat >/dev/null; fi\n', { mode: 0o755 });
    const log = resolve(work, "commands");
    const result = spawnSync("bash", ["scripts/ci/publish-images.sh", work], { encoding: "utf8",
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, GH_TOKEN: "test", GH_ACTOR: "test", MOCK_STATUS: status, MOCK_LOG: log } });
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    const calls = readFileSync(log, "utf8");
    assert.equal(calls.split("\n").filter(line => line.startsWith("push ")).length, success ? 3 : 0);
    assert.equal(calls.split("\n").filter(line => line.startsWith("load ")).length, success ? 3 : 0);
    assert.equal(calls.split("\n").filter(line => line.startsWith("helm push ")).length, success ? 1 : 0);
    if (status === "200" || status === "chart-exists") assert.match(result.stderr, /Refusing to overwrite/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
