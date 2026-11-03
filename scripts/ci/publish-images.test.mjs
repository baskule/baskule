import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const sha = data => createHash("sha256").update(data).digest("hex");
function fixture(scenario) {
  const work = mkdtempSync(resolve(tmpdir(), "publish-test-"));
  const refs = ["celld", "computerd", "openshell-gateway", "openshell-kubernetes", "computer", "openshell-supervisor", "openshell-sandbox"].map(name => `ghcr.io/baskule/baskule-${name}:test`);
  const expected = {};
  const files = {};
  for (const ref of refs) {
    const config = JSON.stringify({ architecture: "amd64", os: "linux", config: { Labels: { image: ref } } });
    const digest = sha(config);
    expected[ref] = `sha256:${digest}`;
    const content = resolve(work, digest);
    mkdirSync(content);
    writeFileSync(resolve(content, `${digest}.json`), config);
    writeFileSync(resolve(content, "manifest.json"), JSON.stringify([{ Config: `${digest}.json`, RepoTags: [ref], Layers: [] }]));
    const name = ref.split("/").at(-1).split(":")[0];
    const archive = `${name}.tar.gz`;
    assert.equal(spawnSync("tar", ["-czf", resolve(work, archive), "-C", content, "manifest.json", `${digest}.json`]).status, 0);
    files[archive] = readFileSync(resolve(work, archive));
  }
  files["images.txt"] = refs.map(ref => `${ref} ${expected[ref]}\n`).join("");
  if (scenario !== "missing chart") files["baskule-0.5.0.tgz"] = "verified chart";
  if (scenario === "multiple charts") files["baskule-0.6.0.tgz"] = "second chart";
  for (const [file, data] of Object.entries(files)) writeFileSync(resolve(work, file), data);
  writeFileSync(resolve(work, "SHA256SUMS"), Object.entries(files).map(([file, data]) => `${sha(data)}  ${file}\n`).join(""));
  const chart = "ghcr.io/baskule/charts/baskule:0.5.0";
  expected[chart] = `sha256:${sha("verified chart")}`;
  const chartManifest = { layers: [{ mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip", digest: expected[chart] }] };
  const remote = {};
  if (scenario.includes("mismatch")) remote[scenario === "chart mismatch" ? chart : refs[0]] = scenario === "chart mismatch"
    ? { layers: [{ ...chartManifest.layers[0], digest: `sha256:${"f".repeat(64)}` }] }
    : { config: { digest: `sha256:${"f".repeat(64)}` } };
  if (scenario === "matching index") {
    remote[refs[0]] = { manifests: [{ digest: "sha256:child", platform: { os: "linux", architecture: "amd64" } }, { digest: "sha256:attestation", platform: { os: "unknown", architecture: "unknown" } }] };
    remote["ghcr.io/baskule/baskule-celld:sha256:child"] = { config: { digest: expected[refs[0]] } };
  }
  writeFileSync(resolve(work, "expected.json"), JSON.stringify(expected));
  writeFileSync(resolve(work, "remote.json"), JSON.stringify(remote));
  writeFileSync(resolve(work, "curl"), `#!/usr/bin/env node
const fs = require("node:fs");
const args=process.argv.slice(2), work=process.env.MOCK_WORK;
fs.appendFileSync(work+"/commands", "curl "+args.join(" ")+"\\n");
if(args.at(-1).includes("ghcr.io/token")) { console.log('{"token":"test"}'); process.exit(0); }
if(args.includes("--head")) process.exit(process.env.MOCK_PRIVATE === "1" ? 22 : 0);
const [,repo,tag]=args.at(-1).match(/ghcr.io\\/v2\\/(.+)\\/manifests\\/(.+)/);
const remote=JSON.parse(fs.readFileSync(work+"/remote.json"));
const manifest=remote["ghcr.io/"+repo+":"+tag];
const status=process.env.MOCK_SCENARIO === "unauthorized" ? 401 : process.env.MOCK_SCENARIO === "unavailable" ? 503 : manifest ? 200 : 404;
if(args.includes("-o")) { fs.writeFileSync(args[args.indexOf("-o")+1],JSON.stringify(manifest||{})); process.stdout.write(String(status)); }
else if(status === 200) console.log(JSON.stringify(manifest)); else process.exit(22);
`, { mode: 0o755 });
  writeFileSync(resolve(work, "docker"), `#!/bin/bash
set -euo pipefail
echo "$*" >> "$MOCK_WORK/commands"
case $1 in
  save) name=\${2##*/}; name=\${name%%:*}; gzip -dc "$MOCK_WORK/$name.tar.gz" ;;
  push)
    count=$(cat "$MOCK_WORK/count" 2>/dev/null || echo 0); count=$((count+1)); echo "$count" > "$MOCK_WORK/count"
    if [[ $MOCK_SCENARIO == partial && $count == 4 && ! -f $MOCK_WORK/failed ]]; then touch "$MOCK_WORK/failed"; exit 1; fi
    jq --arg ref "$2" --slurpfile expected "$MOCK_WORK/expected.json" '.[$ref]={config:{digest:$expected[0][$ref]}}' "$MOCK_WORK/remote.json" > "$MOCK_WORK/next"
    mv "$MOCK_WORK/next" "$MOCK_WORK/remote.json" ;;
esac
`, { mode: 0o755 });
  writeFileSync(resolve(work, "helm"), `#!/bin/bash
set -euo pipefail
echo "helm $*" >> "$MOCK_WORK/commands"
if [[ $1 == push ]]; then
  if [[ $MOCK_SCENARIO == chart-failure && ! -f $MOCK_WORK/failed ]]; then touch "$MOCK_WORK/failed"; exit 1; fi
  jq --arg ref '${chart}' --slurpfile expected "$MOCK_WORK/expected.json" '.[$ref]={layers:[{mediaType:"application/vnd.cncf.helm.chart.content.v1.tar+gzip",digest:$expected[0][$ref]}]}' "$MOCK_WORK/remote.json" > "$MOCK_WORK/next"
  mv "$MOCK_WORK/next" "$MOCK_WORK/remote.json"
fi
`, { mode: 0o755 });
  const run = (script = "scripts/ci/publish-images.sh", extra = {}) => spawnSync("bash", [script, work], { encoding: "utf8", env: { ...process.env, PATH: `${work}:${process.env.PATH}`, GH_TOKEN: "test", GH_ACTOR: "test", MOCK_WORK: work, MOCK_SCENARIO: scenario, ...extra } });
  const calls = () => existsSync(resolve(work, "commands")) ? readFileSync(resolve(work, "commands"), "utf8").trim().split("\n") : [];
  return { work, refs, run, calls };
}

for (const scenario of ["missing chart", "multiple charts", "image mismatch", "chart mismatch", "unauthorized", "unavailable"]) test(`publication refuses ${scenario} before pushing`, () => {
  const f = fixture(scenario);
  try {
    const result = f.run();
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(f.calls().filter(line => /^(push |helm push )/.test(line)).length, 0);
    assert.match(result.stderr, /exactly one|differing release artifact|refusing publication/);
  } finally { rmSync(f.work, { recursive: true, force: true }); }
});

for (const scenario of ["new", "partial", "chart-failure", "matching index"]) test(`publication resumes ${scenario} and skips matching artifacts`, () => {
  const f = fixture(scenario);
  try {
    const first = f.run();
    assert.equal(first.status, scenario === "partial" || scenario === "chart-failure" ? 1 : 0, first.stderr);
    const before = f.calls().length;
    const second = f.run();
    assert.equal(second.status, 0, second.stderr);
    const newCalls = f.calls().slice(before);
    assert.equal(newCalls.filter(line => line.startsWith("push ")).length, scenario === "partial" ? 4 : 0);
    assert.equal(newCalls.filter(line => line.startsWith("helm push ")).length, scenario === "partial" || scenario === "chart-failure" ? 1 : 0);
    assert.equal(f.run().status, 0);
    const count = f.calls().length;
    for (const privatePackage of ["1", "0"]) assert.equal(f.run("scripts/ci/check-public-images.sh", { MOCK_PRIVATE: privatePackage }).status, privatePackage === "1" ? 22 : 0);
    assert.equal(f.calls().slice(count).filter(line => /^(push |helm push )/.test(line)).length, 0);
  } finally { rmSync(f.work, { recursive: true, force: true }); }
});

test("Docker archive config identity is independent of the runner image store", t => {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    assert.notEqual(process.env.GITHUB_ACTIONS, "true", "Docker is required to verify the CI image store");
    t.skip("Docker unavailable"); return;
  }
  const work = mkdtempSync(resolve(tmpdir(), "config-id-test-"));
  const name = `baskule-config-id-test-${process.pid}`;
  const image = `${name}:local`;
  try {
    writeFileSync(resolve(work, "Dockerfile"), "FROM scratch\nCOPY marker /marker\n");
    writeFileSync(resolve(work, "marker"), "config identity probe\n");
    const build = spawnSync("docker", ["build", "-t", image, work], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const saved = spawnSync("bash", ["-o", "pipefail", "-c", 'docker save "$1" | bash scripts/ci/image-config-id.sh', "bash", image], { encoding: "utf8" });
    assert.equal(saved.status, 0, saved.stderr);
    const inspect = JSON.parse(spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" }).stdout)[0];
    assert.match(saved.stdout.trim(), /^sha256:[a-f0-9]{64}$/);
    // Same config identity after loading the saved artifact, regardless of .Id.
    const output = resolve(work, "artifacts");
    mkdirSync(output);
    const source = readFileSync("scripts/release-backend.sh", "utf8");
    const save = source.slice(source.indexOf("save_image() {"), source.indexOf('case "$phase"'));
    const packaged = spawnSync("bash", ["-ec", `set -o pipefail; image_tag=test; ${save}\nsave_image "$1" "$2"`, "bash", name, output], { encoding: "utf8" });
    assert.equal(packaged.status, 0, packaged.stderr);
    assert.equal(readFileSync(resolve(output, "images.txt"), "utf8"), `ghcr.io/baskule/${name}:test ${saved.stdout.trim()}\n`);
    const archive = resolve(output, `${name}.tar.gz`);
    assert.equal(spawnSync("docker", ["load", "-i", archive], { stdio: "ignore" }).status, 0);
    const fromArchive = spawnSync("bash", ["scripts/ci/image-config-id.sh", archive], { encoding: "utf8" });
    assert.equal(fromArchive.stdout, saved.stdout);
    const manifest = JSON.parse(spawnSync("tar", ["-xOf", archive, "manifest.json"], { encoding: "utf8" }).stdout);
    const config = spawnSync("tar", ["-xOf", archive, manifest[0].Config]);
    assert.equal(config.status, 0);
    assert.equal(saved.stdout.trim(), `sha256:${sha(config.stdout)}`);
    t.diagnostic(JSON.stringify({ inspectId: inspect.Id, descriptorType: inspect.Descriptor?.mediaType ?? "classic store", configId: saved.stdout.trim() }));
  } finally { spawnSync("docker", ["image", "rm", image, `ghcr.io/baskule/${name}:test`], { stdio: "ignore" }); rmSync(work, { recursive: true, force: true }); }
});
