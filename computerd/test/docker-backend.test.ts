import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerBackend } from "../src/docker.ts";

function stub(fields: Record<string, unknown>) {
  const backend: InstanceType<typeof DockerBackend> = Object.create(DockerBackend.prototype);
  Object.assign(backend, fields);
  return backend as any;
}

const machine = (name: string, labels: Record<string, string>) => ({ name, phase: "ready", image: "i", labels, error: null });

test("an unscoped computerd stops only unscoped computers when its guard fails", async () => {
  const stopped: string[] = [];
  const backend = stub({
    guardInstance: "", guardVerified: undefined,
    list: async () => [machine("mine", { "baskule.managed": "true" }), machine("other", { "baskule.managed": "true", "baskule.instance": "other" })],
    stop: async (name: string) => { stopped.push(name); },
  });
  await backend.stopUnguarded();
  assert.deepEqual(stopped, ["mine"]);
});

test("a scoped computerd stops its own computers and nothing once the guard is verified again", async () => {
  const stopped: string[] = [];
  let listed: Record<string, string> = {};
  const backend = stub({
    guardInstance: "a", guardVerified: undefined,
    list: async (labels: Record<string, string>) => { listed = labels; return [machine("x", { "baskule.instance": "a" })]; },
    stop: async (name: string) => { stopped.push(name); },
  });
  await backend.stopUnguarded();
  assert.deepEqual(listed, { "baskule.managed": "true", "baskule.instance": "a" });
  assert.deepEqual(stopped, ["x"]);
  backend.guardVerified = { subnets: [], at: Date.now() };
  stopped.length = 0;
  await backend.stopUnguarded();
  assert.deepEqual(stopped, []);
});

test("deleting a space removes its legacy copies, container and disk", async () => {
  const requests: { method: string; path: string; body?: any }[] = [];
  const backend = stub({
    legacyVolume: "legacy", guardImage: "computerd",
    request: async (method: string, path: string, body?: any) => {
      requests.push({ method, path, body });
      if (path === "/containers/create") return { Id: "helper" };
      if (path.includes("/wait?")) return { StatusCode: 0 };
      return null;
    },
  });
  const result = await backend.remove("os-scoped", "baskule-space-scoped", "baskule-space-legacy");
  assert.deepEqual(result, { machineDeleted: true, diskDeleted: true });
  const create = requests.find(r => r.path === "/containers/create")!;
  assert.deepEqual(create.body.Entrypoint.slice(-1), ["baskule-space-legacy"]);
  assert.equal(create.body.HostConfig.NetworkMode, "none");
  assert.match(create.body.Entrypoint[2], /_data" "\/legacy\/volumes\/\$1\/_data\.migrated"/);
  assert.ok(requests.some(r => r.method === "DELETE" && r.path === "/containers/helper?force=true"));
  assert.ok(requests.some(r => r.method === "DELETE" && r.path.startsWith("/volumes/baskule-space-scoped")));
  await assert.rejects(backend.remove("os-x", "baskule-space-x", "../escape"), /Invalid legacy disk name/);
});
