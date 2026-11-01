#!/usr/bin/env node
// Exercise the operator assets without checkout mounts. Only disposable, uniquely named projects are changed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { createApi } from "./journeys/api.mjs";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2] ?? "all";
if (!["all", "single", "cluster", "restore", "fresh", "proxy"].includes(target)) throw new Error("Choose all, single, cluster, restore, or fresh");
const version = process.env.BASKULE_INSTALL_VERSION ?? "local";
const registry = process.env.BASKULE_INSTALL_REGISTRY ?? "ghcr.io/baskule";
const computerImage = `${registry}/baskule-computerd:${version}`;
const id = `release-install-${randomBytes(4).toString("hex")}`;
const run = resolve(root, ".run", id);
const evidence = resolve(root, process.env.BASKULE_INSTALL_EVIDENCE ?? ".run/evidence/release-install");
mkdirSync(run, { recursive: true });
mkdirSync(evidence, { recursive: true });
const assets = resolve(run, "assets");
execFileSync(resolve(root, "scripts/release-install-assets.sh"), [assets], {
  env: { ...process.env, BASKULE_VERSION: version },
});
const projects = [];
const containers = new Map();
const fixtureVolumes = new Set();
const fixtureNetworks = new Set();
const fixtureImages = new Set();
function command(args, { cwd = root, input, inputFile, output, allowFailure = false } = {}) {
  appendFileSync(resolve(evidence, "commands.log"), `docker ${args.map(a => a.startsWith("RUSTFS_SECRET_KEY=") ? "RUSTFS_SECRET_KEY=<redacted>" : a).join(" ")}\n`);
  const source = inputFile ? openSync(inputFile, "r") : undefined;
  const destination = output ? openSync(output, "w", 0o600) : undefined;
  let result;
  try {
    result = spawnSync("docker", args, { cwd, input, env: { ...process.env, BASKULE_REGISTRY: registry }, encoding: "utf8", timeout: 900_000,
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
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
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
  const kind = role.startsWith("node") ? "node" : role.startsWith("single") ? "single" : role;
  const compose = kind === "single" ? "docker-compose.yml" : `cluster-${kind}.yml`;
  const example = kind === "single" ? "baskule.env.example" : `cluster-${kind}.env.example`;
  copyFileSync(resolve(assets, compose), resolve(directory, "docker-compose.yml"));
  const file = resolve(directory, ".env");
  if (kind !== "single") {
    mkdirSync(resolve(directory, "config"));
    copyFileSync(resolve(assets, example), file);
    envFile(file, { COMPUTERD_TOKEN: randomBytes(32).toString("hex"), OPENSHELL_VOLUMES_TOKEN: randomBytes(32).toString("hex") });
  }
  if (Object.keys(values).length) envFile(file, values);
  const project = `${id}-${role}`;
  const files = ["-f", resolve(directory, "docker-compose.yml")];
  const dc = (args, options = {}) => command(["compose", "-p", project, ...files, ...args], { cwd: directory, ...options });
  if (kind === "single" && !Object.keys(values).length) expect(readdirSync(directory)).toEqual(["docker-compose.yml"]);
  const w = { directory, file, project, dc, values, files };
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
const admin = { email: "admin@release.test", password: `quoted$"${randomBytes(24).toString("hex")}` };
const adminVars = { SETUP_TOKEN: randomBytes(32).toString("hex") };
async function fake(w, lan) {
  const name = `${w.project}-llm`;
  const args = ["run", "-d", "--no-healthcheck", "--name", name];
  let endpoint;
  if (lan) {
    args.push("--network", lan.network, "--ip", lan.address);
    endpoint = `http://${lan.address}:47601/v1`;
  } else {
    args.push("--network", `${w.project}_baskule-net`, "--network-alias", "release-install-llm");
    endpoint = "http://release-install-llm:47601/v1";
  }
  containers.set(name, "model");
  command([...args, "--entrypoint", "node", "-v", `${root}/platform/dev/fake-llm:/fake:ro`, computerImage,
    "/fake/server.mjs", "--host", "0.0.0.0"]);
  return { endpoint, name };
}
function secretHash(w) {
  return w.dc(["run", "--rm", "--no-deps", "--entrypoint", "sha256sum", "setup", "/run/baskule/secrets"]);
}
async function completeSetup(w, base) {
  const status = await (await fetch(`${base}/api/baskule/setup`)).json();
  if (!status.required) return;
  const logs = w.values.SETUP_TOKEN ? "" : w.dc(["logs", "--no-color", "setup"]);
  const token = w.values.SETUP_TOKEN ?? logs.match(/\/setup#token=([^\s]+)/)?.[1];
  expect(token).toBeTruthy();
  const result = spawnSync("curl", ["-sS", "-c", resolve(w.directory, "setup-cookies"), "-H", `Origin: ${base}`, "-H", "Content-Type: application/json", "--data-binary", "@-", "-w", "\n%{http_code}", `${base}/api/baskule/setup`], {
    input: JSON.stringify({ token, name: "Release admin", ...admin }), encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n").at(-1)).toBe("201");
  const me = spawnSync("curl", ["-sS", "-b", resolve(w.directory, "setup-cookies"), `${base}/api/baskule/me`], { encoding: "utf8" });
  expect(JSON.parse(me.stdout).user.role).toBe("admin");
  pass("logs setup link creates the first admin through curl and its browser session cookie works");
}
async function proxy() {
  const p = await port();
  const w = world("single-proxy", { BASKULE_PORT: p, SETUP_TOKEN: adminVars.SETUP_TOKEN, COMPUTERD_TOKEN: "computer-env-override", OPENSHELL_VOLUMES_TOKEN: "volume-env-override", RUSTFS_ACCESS_KEY: "rustfs-env-override", RUSTFS_SECRET_KEY: "rustfs-env-secret-override" });
  w.dc(["up", "-d"]);
  const edge = `http://127.0.0.1:${p}`;
  await ready(`${edge}/api/baskule/setup`);
  const proxyPort = await port();
  const proxyConfig = resolve(w.directory, "outer-proxy.Caddyfile");
  writeFileSync(proxyConfig, `{
    admin off
    auto_https off
  }
  :${proxyPort} {
    bind 127.0.0.1
    reverse_proxy ${edge} {
      header_up Host proxy.baskule.test
      header_up X-Forwarded-Host proxy.baskule.test
      header_up X-Forwarded-Proto https
      header_up X-Forwarded-For {http.request.header.X-Test-Client-IP}
    }
  }`);
  const proxyName = `${w.project}-outer-proxy`;
  containers.set(proxyName, "proxy");
  command(["run", "-d", "--name", proxyName, "--network", "host", "-v", `${proxyConfig}:/etc/caddy/Caddyfile:ro`,
    "caddy:2@sha256:25cdc846626b62d05f6b633b9b40c2c9f6ef89b515dc76133cefd920f7dbe562"]);
  const base = `http://127.0.0.1:${proxyPort}`;
  await ready(`${base}/api/baskule/setup`);
  const origin = "https://proxy.baskule.test";
  const headers = { "X-Test-Client-IP": "203.0.113.17", Origin: origin, "Content-Type": "application/json" };
  const token = w.dc(["logs", "--no-color", "setup"]).match(/\/setup#token=([^\s]+)/)[1];
  expect(token).toBe(adminVars.SETUP_TOKEN);
  const post = async (path, body, extra = {}) => {
    const result = spawnSync("curl", ["-sS", "-D", resolve(w.directory, "proxy-headers"), ...Object.entries({ ...headers, ...extra }).flatMap(([key,value]) => ["-H", `${key}: ${value}`]), "--data-binary", "@-", "-w", "\n%{http_code}", `${base}${path}`], { input: JSON.stringify(body), encoding: "utf8" });
    expect(result.status).toBe(0);
    return Number(result.stdout.trim().split("\n").at(-1));
  };
  expect(await post("/api/baskule/setup", { token, name: "Proxy admin", ...admin }, { Origin: "https://foreign.test" })).toBe(403);
  expect(await post("/api/baskule/setup", { token, name: "Proxy admin", ...admin })).toBe(201);
  expect(/set-cookie: (?:__Secure-)?baskule\.session_token=.*; Secure(?:;|\r|$)/i.test(readFileSync(resolve(w.directory, "proxy-headers"), "utf8"))).toBe(true);
  expect(await post("/auth/sign-in/email", admin)).toBe(200);
  expect(await post("/auth/sign-in/email", admin, { Origin: "https://foreign.test" })).toBe(403);
  // Distinct forwarded client addresses have independent sign-in budgets.
  for (let n = 0; n < 10; n++) expect(await post("/auth/sign-in/email", { ...admin, password: "wrong" }, { "X-Test-Client-IP": "203.0.113.18" })).toBe(401);
  expect(await post("/auth/sign-in/email", admin, { "X-Test-Client-IP": "203.0.113.18" })).toBe(429);
  expect(await post("/auth/sign-in/email", admin, { "X-Test-Client-IP": "203.0.113.19" })).toBe(200);
  pass("HTTPS proxy headers without PUBLIC_ORIGINS: setup, Secure session, sign-in, foreign Origin refusal and real-client rate limits");
}
async function exercise(w, base, endpoint) {
  await ready(`${base}/version.json`);
  const stamp = await (await fetch(`${base}/version.json`)).json();
  expect(stamp.umbrella).toBeTruthy();
  expect((await (await fetch(`${base}/.well-known/baskule`)).json()).authentication.password).toBe(true);
  const api = createApi({ urls: { loopback: base, front: base }, admin });
  await completeSetup(w, base);
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
  return { space, thread, admin, user: { email: chatting.email, password: chatting.password } };
}
async function persisted(base, previous) {
  const api = createApi({ urls: { loopback: base, front: base }, admin: previous.admin ?? admin });
  if (previous.admin) await api.adminSession();
  const person = await api.Person.signIn(previous.user.email, previous.user.password);
  const client = await rpc(person, previous.space ?? api.personalSpace(person));
  try {
    if (previous.thread) {
      const state = api.watchThread(client, previous.thread);
      await api.waitFor("chat persisted", () => state.assistantText().includes("RELEASE_INSTALL_CHAT_OK"));
      state.stop();
    } else {
      const shell = api.watchShell(client);
      await api.waitFor("stored threads loaded", () => shell.ready);
      const projections = await Promise.all([...shell.threads.keys()].map(threadId => client.ok("orchestration.getThreadProjection", { threadId })));
      expect(JSON.stringify(projections)).toContain("RELEASE_INSTALL_CHAT_OK");
      shell.stop();
    }
    const result = await client.ok("projects.readFile", { cwd: "/sandbox/space", relativePath: "release-proof.txt" });
    expect(JSON.stringify(result)).toContain("RELEASE_INSTALL_DISK_OK");
  } finally { client.close(); await client.closed; }
}
async function fresh() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const p = await port();
    const base = `http://127.0.0.1:${p}`;
    const w = world(`single-${attempt}`, { BASKULE_PORT: p });
    w.dc(["up", "-d"]);
    await health(w, ["baskule-celld-a", "baskule-celld-b", "baskule-openshell", "baskule-computerd"]);
    await ready(`${base}/version.json`);
    await completeSetup(w, base);
    await createApi({ urls: { loopback: base, front: base }, admin }).adminSession();
    expect(w.dc(["ps", "-a", "--format", "{{.ExitCode}}", "baskule-bootstrap"])).toBe("0");
    writeFileSync(resolve(evidence, `${w.project}.log`), w.dc(["logs", "--no-color"]));
    pass(`fresh install ${attempt}/3: first up, bucket bootstrap, all services healthy, version and quoted-password admin sign-in`);
    w.dc(["down", "-v"]);
  }
}
function imageCleanup(w) {
  const gateway = w.dc(["ps", "-q", "baskule-openshell"]);
  // A distinct obsolete image proves that pruning frees an image, beyond just removing aliases.
  const old = command(["exec", gateway, "sh", "-c",
    `mkdir -p /tmp/obsolete; echo old > /tmp/obsolete/release; tar -C /tmp/obsolete -cf - . | docker import - ${registry}/baskule-computer:obsolete`]);
  const next = `${version}-upgrade`;
  for (const name of ["celld", "computerd", "openshell-gateway"]) {
    const tag = `${registry}/baskule-${name}:${next}`;
    fixtureImages.add(tag);
    command(["tag", `${registry}/baskule-${name}:${version}`, tag]);
  }
  const composeFile = resolve(w.directory, "docker-compose.yml");
  writeFileSync(composeFile, readFileSync(composeFile, "utf8").replaceAll(`BASKULE_VERSION:-${version}`, `BASKULE_VERSION:-${next}`));
  w.dc(["up", "-d"]);
  const updated = w.dc(["ps", "-q", "baskule-openshell"]);
  const references = command(["exec", updated, "docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]);
  expect(references.split("\n").sort()).toEqual(["computer", "openshell-supervisor", "openshell-sandbox"].map(name => `${registry}/baskule-${name}:${next}`).sort());
  expect(command(["exec", updated, "docker", "image", "ls", "-aq"])).not.toContain(old.replace("sha256:", "").slice(0, 12));
  writeFileSync(resolve(evidence, "gateway-upgrade-images.txt"), `${references}\nobsolete image pruned: ${old}\n`);
  pass("gateway update keeps only current workload tags and prunes a distinct obsolete image");
}
function metadata(w, create = false) {
  const gateway = w.dc(["ps", "-q", "baskule-openshell"]);
  const code = `import os,json,stat
path='/var/lib/openshell/backup-metadata-proof'
${create ? `open(path,'w').write('backup metadata')
os.setxattr(path,'user.baskule-test',b'preserved')
os.setxattr(path,'trusted.overlay.opaque',b'y')
os.chown(path,12345,23456)
os.chmod(path,0o640)` : ""}
s=os.stat(path)
print(json.dumps([s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),os.getxattr(path,'user.baskule-test').decode(),os.getxattr(path,'trusted.overlay.opaque').decode()]))`;
  expect(JSON.parse(command(["exec", gateway, "python3", "-c", code]))).toEqual([12345, 23456, 0o640, "preserved", "y"]);
}
async function single() {
  const base = "http://127.0.0.1:47090";
  const w = world("single", {});
  w.dc(["up", "-d"]);
  await health(w, ["baskule-celld-a", "baskule-celld-b", "baskule-openshell", "baskule-computerd"]);
  const llm = await fake(w);
  const result = await exercise(w, base, llm.endpoint);
  const secrets = secretHash(w);
  w.dc(["up", "-d"]);
  expect(secretHash(w)).toBe(secrets);
  pass("second up preserves generated secrets");
  imageCleanup(w);
  expect(secretHash(w)).toBe(secrets);
  pass("downloaded compose version update preserves generated secrets");
  await persisted(base, result);
  writeFileSync(resolve(run, "single-proof.json"), JSON.stringify({ ...result, directory: w.directory }), { mode: 0o600 });
  command(["rm", "-f", llm.name]); containers.delete(llm.name);
  metadata(w, true);
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
  metadata(w);
  expect(secretHash(w)).toBe(secrets);
  pass("restored secrets match the original volume");
  pass("single-machine backup restores chat, computer disk, user/trusted xattrs, numeric ownership and modes into empty volumes");
}
async function restoreOnly() {
  if (!process.argv[3]) throw new Error("Pass the private single-proof.json path");
  const previous = JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"));
  const p = await port();
  const base = `http://127.0.0.1:${p}`;
  const w = world("single", adminVars);
  if (existsSync(resolve(previous.directory, ".env"))) copyFileSync(resolve(previous.directory, ".env"), w.file);
  envFile(w.file, { BASKULE_REGISTRY: registry, BASKULE_VERSION: version, BASKULE_PORT: p, PUBLIC_ORIGINS: base });
  w.dc(["run", "--rm", "-T", "restore"], { inputFile: resolve(evidence, "single-backup.tar.gz") });
  w.dc(["up", "-d"]);
  await ready(`${base}/version.json`);
  await persisted(base, previous);
  pass("focused restore preserves chat and re-admits the computer disk into empty volumes");
}
async function cluster() {
  const network = `${id}-lan`;
  fixtureNetworks.add(network); command(["network", "create", network]);
  const [{ Subnet: subnet }] = JSON.parse(command(["network", "inspect", "-f", "{{json .IPAM.Config}}", network]));
  const [baseAddress, bits] = subnet.split("/");
  if (Number(bits) > 28) throw new Error("The private test LAN needs at least eight addresses");
  const octets = baseAddress.split(".").map(Number);
  const address = offset => [...octets.slice(0, 3), octets[3] + offset].join(".");
  const [nodeA, nodeB, computerHost, edgeHost, modelHost, storageHost] = [2, 3, 4, 5, 6, 7].map(address);
  const adapter = (w, services) => {
    const file = resolve(run, `${w.project}-lan.yml`);
    writeFileSync(file, `services:\n${services}networks:\n  lan:\n    external: true\n    name: ${network}\n`);
    w.files.push("-f", file);
    w.dc(["--profile", "*", "config", "-q"]);
  };
  const storage = `${id}-s3`;
  const storageVolume = `${id}-s3`;
  containers.set(storage, "storage"); fixtureVolumes.add(storageVolume);
  const key = randomBytes(32).toString("hex");
  command(["run", "-d", "--name", storage, "--network", network, "--ip", storageHost,
    "-e", "RUSTFS_ADDRESS=0.0.0.0:47093", "-e", "RUSTFS_CONSOLE_ENABLE=false", "-e", "RUSTFS_ACCESS_KEY=release-test",
    "-e", `RUSTFS_SECRET_KEY=${key}`, "-v", `${storageVolume}:/data`,
    "rustfs/rustfs@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b", "rustfs", "/data"]);
  const token = randomBytes(32).toString("hex");
  const base = `http://${edgeHost}:47090`;
  const shared = { ...adminVars, S3_ENDPOINT: `http://${storageHost}:47093`, S3_REGION: "us-east-1",
    S3_ACCESS_KEY: "release-test", S3_SECRET_KEY: key, CELLD_BUCKET_NAME: "baskule", COMPUTERD_TOKEN: token,
    COMPUTERD_URL: `http://${computerHost}:47094`, CELLD_NODES_INTERNAL: `${nodeA}:47092 ${nodeB}:47092`, PUBLIC_ORIGINS: base };
  const a = world("node-a", { ...shared, BASKULE_PRIVATE_IP: nodeA, CELLD_NODE: `${id}-a` });
  const b = world("node-b", { ...shared, BASKULE_PRIVATE_IP: nodeB, CELLD_NODE: `${id}-b` });
  const computers = world("computers", { BASKULE_PRIVATE_IP: computerHost, COMPUTERD_TOKEN: token, PLATFORM_URL: base });
  const edge = world("edge", { BASKULE_BIND: edgeHost, BASKULE_NODES_WORKER: `${nodeA}:47091 ${nodeB}:47091` });
  for (const [w, ip] of [[a, nodeA], [b, nodeB]]) adapter(w,
    `  node:\n    network_mode: !reset null\n    networks:\n      lan:\n        ipv4_address: ${ip}\n  deploy:\n    network_mode: !reset null\n    networks: [lan]\n`);
  adapter(computers, `  baskule-computerd:\n    ports: !reset []\n    networks:\n      lan:\n        ipv4_address: ${computerHost}\n`);
  adapter(edge, `  edge:\n    ports: !reset []\n    networks:\n      lan:\n        ipv4_address: ${edgeHost}\n`);
  // The external bucket is an independent fixture, not a service of any cluster role.
  await expect.poll(async () => {
    try { return (await fetch(`${shared.S3_ENDPOINT}/health/ready`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
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
  let fleet;
  await expect.poll(() => {
    fleet = a.dc(["exec", "-T", "node", "sh", "-c", 'celld diagnose --read-only --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"'], { allowFailure: true });
    writeFileSync(resolve(evidence, "cluster-fleet.json"), fleet);
    const peers = fleet.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).filter(row => row.check?.startsWith("peer "));
    return peers.length === 2 && peers.every(row => row.verdict === "ok");
  }, { message: "both fleet peers answer signed probes", timeout: 90_000 }).toBe(true);
  expect(fleet).toMatch(/2 node lease/);
  expect(fleet).toContain(`peer ${id}-a`); expect(fleet).toContain(`peer ${id}-b`);
  pass("cluster forms a two-node fleet with an external bucket");
  const llm = await fake(computers, { network, address: modelHost });
  await completeSetup(a, base);
  const result = await exercise(computers, base, llm.endpoint);
  // Kill the node owning the most cells; disable automatic restart for this drill.
  const owned = (w, ip) => JSON.parse(w.dc(["exec", "-T", "node", "curl", "-sf", `http://${ip}:47092/state`])).owned_cells ?? 0;
  const victim = owned(a, nodeA) >= owned(b, nodeB) ? a : b;
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
  if (target === "proxy") await proxy();
  if (target === "fresh") await fresh();
  if (target === "restore") await restoreOnly();
  if (target === "all" || target === "single") await single();
  if (target === "all" || target === "cluster") await cluster();
} finally {
  for (const [name, kind] of containers) if (kind === "model" || kind === "proxy") command(["rm", "-f", name], { allowFailure: true });
  for (const w of [...projects].reverse()) {
    const logs = w.dc(["logs", "--no-color"], { allowFailure: true });
    if (logs) writeFileSync(resolve(evidence, `${w.project}.log`), logs);
    w.dc(["down", "-v", "--remove-orphans"], { allowFailure: true });
  }
  for (const [name, kind] of containers) if (kind === "storage") command(["rm", "-f", name], { allowFailure: true });
  for (const volume of fixtureVolumes) command(["volume", "rm", volume], { allowFailure: true });
  for (const image of fixtureImages) command(["image", "rm", image], { allowFailure: true });
  for (const network of fixtureNetworks) command(["network", "rm", network], { allowFailure: true });
}
