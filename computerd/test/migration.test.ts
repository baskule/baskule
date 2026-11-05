import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { namesFor } from "../src/policy.ts";
import { migrationScript, migrationFinalizeScript } from "../src/docker.ts";

for (const scenario of ["absent legacy", "absent legacy with data", "target absent", "target incomplete", "target complete"]) {
  test(scenario, () => {
    const root = mkdtempSync(join(tmpdir(), "migration-"));
    const legacy = join(root, "legacy"), target = join(root, "target");
    const legacyDisk = namesFor("migration-test", "").volume;
    assert.notEqual(legacyDisk, namesFor("migration-test", "installation").volume);
    const source = join(legacy, "volumes", legacyDisk, "_data");
    mkdirSync(target, { recursive: true });
    if (!scenario.startsWith("absent legacy")) {
      mkdirSync(join(source, "home"), { recursive: true });
      writeFileSync(join(source, "home/data"), "legacy");
    }
    if (scenario === "absent legacy with data" || (scenario.startsWith("target ") && scenario !== "target absent")) {
      mkdirSync(join(target, "home"));
      writeFileSync(join(target, "home/data"), "new");
      writeFileSync(join(target, "stale"), "");
    }
    if (scenario === "target complete") writeFileSync(join(target, ".baskule-migrated"), "");
    try {
      for (const script of [migrationScript, migrationFinalizeScript]) execFileSync("sh", ["-ec", script.replaceAll("/legacy", legacy).replaceAll("/target", target), "migration", legacyDisk]);
      if (scenario.startsWith("absent legacy")) {
        assert.equal(existsSync(join(target, ".baskule-migrated")), !scenario.startsWith("absent legacy"));
        if (scenario.endsWith("with data")) assert.equal(readFileSync(join(target, "home/data"), "utf8"), "new");
      }
      else {
        assert.equal(readFileSync(join(target, "home/data"), "utf8"), scenario === "target complete" ? "new" : "legacy");
        assert.ok(existsSync(source + ".migrated"));
        rmSync(join(target, ".baskule-migrated"));
        writeFileSync(join(target, "home/data"), "retained");
        execFileSync("sh", ["-ec", migrationScript.replaceAll("/legacy", legacy).replaceAll("/target", target), "migration", legacyDisk]);
        assert.equal(readFileSync(join(target, "home/data"), "utf8"), "retained");
        assert.equal(existsSync(join(target, "stale")), scenario === "target complete");

      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("legacy inventory is shared and fresh disks skip migration helpers", async () => {
  const { DockerBackend } = await import("../src/docker.ts");
  const backend: InstanceType<typeof DockerBackend> = Object.create(DockerBackend.prototype);
  const requests: string[] = [];
  Object.assign(backend, {
    legacyVolume: "legacy",
    request: async (method: string, path: string) => {
      requests.push(method + " " + path);
      if (path.startsWith("/containers/json?")) return [];
      if (path === "/containers/create") return { Id: "inventory" };
      if (path.includes("/wait?")) return { StatusCode: 0 };
      if (path.includes("/logs?")) return "baskule-space-old\n";
      return null;
    },
  });
  await Promise.all(["one", "two"].map(id => backend.ensureDisk({
    disk: "baskule-space-scoped-" + id, legacyDisk: "baskule-space-" + id, image: "test", labels: {},
  })));
  assert.equal(requests.filter(r => r === "POST /containers/create").length, 1);
  assert.equal(requests.filter(r => r.startsWith("POST /containers/create?")).length, 0);
});


test("running legacy mounts refuse migration before inventory", async () => {
  const { DockerBackend } = await import("../src/docker.ts");
  const backend = Object.create(DockerBackend.prototype);
  Object.assign(backend, { legacyVolume: "legacy", request: async (_method: string, path: string) => {
    if (path === "/volumes/create") return {};
    assert.equal(path, "/containers/json?filters=" + encodeURIComponent(JSON.stringify({ volume: ["legacy"] })));
    return [{ Id: "old-gateway" }];
  } });
  await assert.rejects(backend.ensureDisk({ disk: "baskule-space-test", image: "test", labels: {} }),
    { status: 503, message: /docker compose up -d --remove-orphans/ });
});
