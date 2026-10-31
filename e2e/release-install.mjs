#!/usr/bin/env node
// Exercise the operator assets without checkout mounts. Only disposable, uniquely named projects are changed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { createApi } from "./journeys/api.mjs";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2] ?? "all";
if (!["all", "single", "cluster"].includes(target)) throw new Error("Choose all, single, or cluster");
const version = process.env.BASKULE_INSTALL_VERSION ?? "local";
const registry = process.env.BASKULE_INSTALL_REGISTRY ?? "ghcr.io/baskule";
const image = `${registry}/baskule-celld:${version}`;
const computerImage = `${registry}/baskule-computerd:${version}`;
const id = `release-install-${randomBytes(4).toString("hex")}`;
const run = resolve(root, ".run", id);
const evidence = resolve(root, ".run/evidence/release-install");
mkdirSync(run, { recursive: true });
mkdirSync(evidence, { recursive: true });
const assets = resolve(run, "assets");
execFileSync(resolve(root, "scripts/release-install-assets.sh"), [assets], {
  env: { ...process.env, BASKULE_VERSION: version },
});
const projects = [];
const containers = new Set();
const fixtureVolumes = new Set();
const fixtureNetworks = new Set();
function command(args, { cwd = root, input, inputFile, output, allowFailure = false } = {}) {
  appendFileSync(resolve(evidence, "commands.log"), `docker ${args.map(a => a.startsWith("RUSTFS_SECRET_KEY=") ? "RUSTFS_SECRET_KEY=<redacted>" : a).join(" ")}\n`);
  const source = inputFile ? openSync(inputFile, "r") : undefined;
  const destination = output ? openSync(output, "w", 0o600) : undefined;
  let result;
  try {
    result = spawnSync("docker", args, { cwd, input, encoding: "utf8", timeout: 900_000,
      stdio: [source ?? "pipe", destination ?? "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 });
  } finally {
    if (source !== undefined) closeSync(source);
    if (destination !== undefined) closeSync(destination);
  }
  if (result.status !== 0 && !allowFailure) throw new Error(`docker ${args[0]} failed: ${String(result.stderr || result.error)}`);
  return output ? "" : result.stdout?.trim() ?? "";
}
async function port() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "0.0.0.0", done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
function envFile(file, values) {
  let content = readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, () => line) : `${content}\n${line}\n`;
  }
  writeFileSync(file, content, { mode: 0o600 });
}
function world(role, values) {
  const directory = resolve(run, role);
  mkdirSync(directory);
  const kind = role.startsWith("node") ? "node" : role;
  const compose = kind === "single" ? "docker-compose.yml" : `cluster-${kind}.yml`;
  const example = kind === "single" ? "baskule.env.example" : `cluster-${kind}.env.example`;
  copyFileSync(resolve(assets, compose), resolve(directory, "docker-compose.yml"));
  copyFileSync(resolve(assets, example), resolve(directory, ".env.example"));
  const generated = command(["run", "--rm", "-i", "--network", "none", "--entrypoint", "baskule-celld-job", image, "init-env", "-"], {
    input: readFileSync(resolve(directory, ".env.example")),
  });
  const file = resolve(directory, ".env");
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  envFile(file, { BASKULE_REGISTRY: registry, BASKULE_VERSION: version, ...values });
  const project = `${id}-${role}`;
  const dc = (args, options = {}) => command(["compose", "-p", project, ...args], { cwd: directory, ...options });
  expect(readdirSync(directory).sort()).toEqual([".env", ".env.example", "docker-compose.yml"]);
  const w = { directory, file, project, dc, values };
  projects.push(w);
  dc(["--profile", "*", "config", "-q"]);
  return w;
}
async function ready(url) {
  await expect.poll(async () => {
    try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
  }, { message: `ready: ${url}`, timeout: 180_000 }).toBe(true);
}
function pass(message) {
  console.log(`PASS ${message}`);
  appendFileSync(resolve(evidence, "results.log"), `PASS ${message}\n`);
}
async function health(w, services) {
  for (const service of services) {
    await expect.poll(() => {
      const container = w.dc(["ps", "-aq", service]);
      return container && command(["inspect", "-f", "{{.State.Health.Status}}", container]);
    }, { message: `${w.project}/${service} healthy`, timeout: 180_000 }).toBe("healthy");
  }
}
async function rpc(person, space) {
  let client, failure;
  person.rpc(space).then(value => { client = value; }, error => { failure = error; });
  await expect.poll(() => {
    if (failure) throw failure;
    return Boolean(client);
  }, { message: "space RPC socket opened", timeout: 60_000 }).toBe(true);
  return client;
}
const admin = { email: "admin@release.test", password: randomBytes(24).toString("hex") };
const adminVars = { ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: admin.password, AUTH_CONFIG: "'{\"version\":1,\"password\":true}'" };
async function fake(w, host) {
  const name = `${w.project}-llm`;
  const args = ["run", "-d", "--no-healthcheck", "--name", name];
  let endpoint;
  if (host) {
    const p = await port();
    args.push("--network", `${w.project}_baskule-net`, "-p", `${host}:${p}:47601`);
    endpoint = `http://${host}:${p}/v1`;
  } else {
    args.push("--network", `${w.project}_baskule-net`, "--network-alias", "release-install-llm");
    endpoint = "http://release-install-llm:47601/v1";
  }
  containers.add(name);
  command([...args, "--entrypoint", "node", "-v", `${root}/platform/dev/fake-llm:/fake:ro`, computerImage,
    "/fake/server.mjs", "--host", "0.0.0.0"]);
  return { endpoint, name };
}
async function exercise(w, base, endpoint) {
  await ready(`${base}/version.json`);
  const stamp = await (await fetch(`${base}/version.json`)).json();
  expect(stamp.umbrella).toBeTruthy();
  expect((await (await fetch(`${base}/.well-known/baskule`)).json()).authentication.password).toBe(true);
  const api = createApi({ urls: { loopback: base, front: base }, admin });
  const person = await api.adminSession();
  const { apiKeyConfigured: _key, transcriptionApiKeyConfigured: _voiceKey, authentication: _auth, ...settings } = await person.json("GET", "/api/baskule/admin/settings");
  await person.json("PATCH", "/api/baskule/admin/settings", {
    ...settings, apiKey: "fake-llm-key",
    ai: { providerId: "custom", baseUrl: endpoint, model: { id: "fake-model", name: "fake-model", image: true, pdf: true, limit: { context: 200_000, output: 16_000 }, settings: {} } },
  });
  // Model changes reload resident spaces; use a fresh world as the journey fixtures do.
  const chatting = await api.person("Release", id);
  const space = api.personalSpace(chatting);
  const client = await rpc(chatting, space);
  let thread;
  try {
    const projectId = (await client.ok("projects.ensureScratch", {})).projectId;
    thread = await api.launch(client, projectId, "Release installation [[fake:text RELEASE_INSTALL_CHAT_OK]]");
    const state = api.watchThread(client, thread);
    await api.waitFor("fake chat answered", () => state.settled() && state.assistantText().includes("RELEASE_INSTALL_CHAT_OK"), 180_000);
    state.stop();
    // Drive a real computer through the platform's configured computerd endpoint.
    const toolThread = await api.launch(client, projectId, '[[fake:tool shell {"command":"printf RELEASE_INSTALL_DISK_OK > /sandbox/space/release-proof.txt; cat /sandbox/space/release-proof.txt"}]]');
    const tool = api.watchThread(client, toolThread);
    await api.waitFor("computer command answered", () => tool.settled() && tool.assistantText().includes("RELEASE_INSTALL_DISK_OK"), 240_000);
    tool.stop();
  } finally { client.close(); await client.closed; }
  const gateway = w.dc(["ps", "-q", "baskule-openshell"]);
  const networks = JSON.parse(command(["inspect", "-f", "{{json .NetworkSettings.Networks}}", gateway]));
  expect(Object.keys(networks)).toEqual([`${w.project}_baskule-computers`]);
  pass(`${w.project}: version, default password auth, admin sign-in, fake chat, platform-to-computer command, gateway network isolation`);
  return { space, thread, user: { email: chatting.email, password: chatting.password } };
}
async function persisted(base, previous) {
  const api = createApi({ urls: { loopback: base, front: base }, admin });
  await api.adminSession();
  const person = await api.Person.signIn(previous.user.email, previous.user.password);
  const client = await rpc(person, previous.space);
  try {
    const state = api.watchThread(client, previous.thread);
    await api.waitFor("chat persisted", () => state.assistantText().includes("RELEASE_INSTALL_CHAT_OK"));
    state.stop();
    const result = await client.ok("projects.readFile", { cwd: "/sandbox/space", relativePath: "release-proof.txt" });
    expect(JSON.stringify(result)).toContain("RELEASE_INSTALL_DISK_OK");
  } finally { client.close(); await client.closed; }
}
async function single() {
  const p = await port();
  const base = `http://127.0.0.1:${p}`;
  const w = world("single", { ...adminVars, AUTH_CONFIG: "", BASKULE_PORT: p, PUBLIC_ORIGINS: base });
  w.dc(["up", "-d"]);
  await health(w, ["baskule-celld-a", "baskule-celld-b", "baskule-openshell", "baskule-computerd"]);
  const llm = await fake(w);
  const result = await exercise(w, base, llm.endpoint);
  command(["rm", "-f", llm.name]); containers.delete(llm.name);
  envFile(w.file, { ADMIN_PASSWORD: "" });
  // Use exactly the documented stop/backup/start operations from the install directory.
  w.dc(["down"]);
  const backup = resolve(evidence, "single-backup.tar.gz");
  w.dc(["run", "--rm", "-T", "backup"], { output: backup });
  w.dc(["up", "-d"]);
  await ready(`${base}/version.json`);
  await persisted(base, result);
  pass("single-machine down/up preserves chat and computer disk");
  w.dc(["down", "-v"]);
  w.dc(["run", "--rm", "-T", "restore"], { inputFile: backup });
  w.dc(["up", "-d"]);
  await ready(`${base}/version.json`);
  await persisted(base, result);
  pass("single-machine backup restores chat and computer disk into empty volumes");
  w.dc(["down", "-v"]);
}
async function cluster() {
  const host = Object.values(networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal)?.address;
  if (!host) throw new Error("Cluster simulation needs a private host IPv4 interface");
  const storagePort = await port();
  const storage = `${id}-s3`;
  const storageVolume = `${id}-s3`;
  containers.add(storage); fixtureVolumes.add(storageVolume);
  fixtureNetworks.add(storage); command(["network", "create", storage]);
  const key = randomBytes(32).toString("hex");
  command(["run", "-d", "--name", storage, "--network", storage, "-p", `${host}:${storagePort}:47093`,
    "-e", "RUSTFS_ADDRESS=0.0.0.0:47093", "-e", "RUSTFS_CONSOLE_ENABLE=false", "-e", "RUSTFS_ACCESS_KEY=release-test",
    "-e", `RUSTFS_SECRET_KEY=${key}`, "-v", `${storageVolume}:/data`,
    "rustfs/rustfs@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b", "rustfs", "/data"]);
  const token = randomBytes(32).toString("hex");
  const workerA = await port(), workerB = await port(), peerA = await port(), peerB = await port(), cp = await port(), ep = await port();
  const base = `http://${host}:${ep}`;
  const shared = { ...adminVars, BASKULE_PRIVATE_IP: host, S3_ENDPOINT: `http://${host}:${storagePort}`, S3_REGION: "us-east-1",
    S3_ACCESS_KEY: "release-test", S3_SECRET_KEY: key, CELLD_BUCKET_NAME: "baskule", COMPUTERD_TOKEN: token,
    COMPUTERD_URL: `http://${host}:${cp}`, CELLD_NODES_INTERNAL: `${host}:${peerA} ${host}:${peerB}`, PUBLIC_ORIGINS: base };
  const a = world("node-a", { ...shared, CELLD_NODE: `${id}-a`, CELLD_WORKER_PORT: workerA, CELLD_INTERNAL_PORT: peerA });
  const b = world("node-b", { ...shared, CELLD_NODE: `${id}-b`, CELLD_WORKER_PORT: workerB, CELLD_INTERNAL_PORT: peerB });
  const computers = world("computers", { BASKULE_PRIVATE_IP: host, COMPUTERD_PORT: cp, COMPUTERD_TOKEN: token, PLATFORM_URL: base });
  const edge = world("edge", { BASKULE_BIND: host, BASKULE_PORT: ep, BASKULE_NODES_WORKER: `${host}:${workerA} ${host}:${workerB}` });
  // The external bucket is an independent fixture, not a service of any cluster role.
  await expect.poll(async () => {
    try { await fetch(shared.S3_ENDPOINT, { signal: AbortSignal.timeout(3000) }); return true; } catch { return false; }
  }, { message: "external S3 fixture ready", timeout: 60_000 }).toBe(true);
  // Create only the bucket, as the guide requires; do not initialize celld state with a bootstrap shortcut.
  a.dc(["run", "--rm", "--no-deps", "--entrypoint", "sh", "deploy", "-c",
    'curl -sf --aws-sigv4 "aws:amz:$AWS_REGION:s3" -H "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" -u "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -X PUT "$S3_ENDPOINT/$CELLD_BUCKET_NAME"']);
  computers.dc(["up", "-d"]);
  a.dc(["up", "-d"]); b.dc(["up", "-d"]);
  a.dc(["run", "--rm", "deploy"]);
  edge.dc(["up", "-d"]);
  await health(a, ["node"]); await health(b, ["node"]);
  await health(computers, ["baskule-openshell", "baskule-computerd"]);
  const fleet = a.dc(["exec", "-T", "node", "sh", "-c", 'celld diagnose --read-only --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"']);
  writeFileSync(resolve(evidence, "cluster-fleet.json"), fleet);
  expect(fleet).toMatch(/2 node lease/);
  expect(fleet).toContain(`peer ${id}-a`); expect(fleet).toContain(`peer ${id}-b`);
  pass("cluster forms a two-node fleet with an external bucket");
  const llm = await fake(computers, host);
  const result = await exercise(computers, base, llm.endpoint);
  // Kill the node owning the most cells; disable automatic restart for this drill.
  const owned = (w, port) => JSON.parse(w.dc(["exec", "-T", "node", "curl", "-sf", `http://${host}:${port}/state`])).owned_cells ?? 0;
  const victim = owned(a, peerA) >= owned(b, peerB) ? a : b;
  const victimId = victim.dc(["ps", "-q", "node"]);
  command(["update", "--restart=no", victimId]); command(["kill", victimId]);
  for (let i = 0; i < 20; i++) expect((await fetch(`${base}/version.json`)).status).toBe(200);
  await expect.poll(async () => {
    try { await persisted(base, result); return true; } catch { return false; }
  }, { message: "cell takeover after node loss", timeout: 120_000 }).toBe(true);
  pass("cluster serves 20/20 Worker requests and persisted cell/computer state after owner-node kill");
  command(["rm", "-f", llm.name]); containers.delete(llm.name);
}
try {
  if (target !== "cluster") await single();
  if (target !== "single") await cluster();
} finally {
  for (const name of containers) command(["rm", "-f", name], { allowFailure: true });
  for (const w of [...projects].reverse()) {
    writeFileSync(resolve(evidence, `${w.project}.log`), w.dc(["logs", "--no-color"], { allowFailure: true }));
    w.dc(["down", "-v", "--remove-orphans"], { allowFailure: true });
  }
  for (const volume of fixtureVolumes) command(["volume", "rm", volume], { allowFailure: true });
  for (const network of fixtureNetworks) command(["network", "rm", network], { allowFailure: true });
}
