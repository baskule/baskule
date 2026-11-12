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
if (!["all", "single", "restore", "fresh", "proxy", "https", "external"].includes(target)) throw new Error("Choose all, single, proxy, https, external, restore, or fresh");
const version = process.env.BASKULE_INSTALL_VERSION ?? "local";
const registry = process.env.BASKULE_INSTALL_REGISTRY ?? "ghcr.io/baskule";
const computerImage = `${registry}/baskule-computerd:${version}`;
const id = `release-install-${randomBytes(4).toString("hex")}`;
const run = resolve(root, ".run", id);
const evidence = resolve(root, process.env.BASKULE_INSTALL_EVIDENCE ?? ".run/evidence/release-install");
mkdirSync(run, { recursive: true });
mkdirSync(evidence, { recursive: true });
const assets = process.env.BASKULE_INSTALL_ASSETS ? resolve(process.env.BASKULE_INSTALL_ASSETS) : resolve(run, "assets");
if (!process.env.BASKULE_INSTALL_ASSETS) execFileSync(resolve(root, "scripts/release-install-assets.sh"), [assets], {
  env: { ...process.env, BASKULE_VERSION: version },
});
const projects = [];
const containers = new Map();
const fixtureVolumes = new Set();
const fixtureImages = new Set();
function command(args, { cwd = root, input, inputFile, output, allowFailure = false } = {}) {
  appendFileSync(resolve(evidence, "commands.log"), `docker ${args.map(a => a.startsWith("RUSTFS_SECRET_KEY=") ? "RUSTFS_SECRET_KEY=<redacted>" : a).join(" ")}\n`);
  const source = inputFile ? openSync(inputFile, "r") : undefined;
  const destination = output ? openSync(output, "w", 0o600) : undefined;
  const env = { ...process.env, BASKULE_REGISTRY: registry };
  // CI sets this for packaging; installed versions must come from the downloaded Compose file.
  delete env.BASKULE_VERSION;
  let result;
  try {
    result = spawnSync("docker", args, { cwd, input, env, encoding: "utf8", timeout: 900_000,
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
  copyFileSync(resolve(assets, "docker-compose.yml"), resolve(directory, "docker-compose.yml"));
  const file = resolve(directory, ".env");
  if (Object.keys(values).length) envFile(file, values);
  const project = `${id}-${role}`;
  const files = ["-f", resolve(directory, "docker-compose.yml")];
  const dc = (args, options = {}) => command(["compose", "-p", project, ...files, ...args], { cwd: directory, ...options });
  if (!Object.keys(values).length) expect(readdirSync(directory)).toEqual(["docker-compose.yml"]);
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
async function fake(w) {
  const name = `${w.project}-llm`;
  const args = ["run", "-d", "--no-healthcheck", "--name", name,
    "--network", `${w.project}_baskule-net`, "--network-alias", "release-install-llm"];
  const endpoint = "http://release-install-llm:47601/v1";
  containers.set(name, "model");
  command([...args, "--entrypoint", "node", "-v", `${root}/platform/dev/fake-llm:/fake:ro`, computerImage,
    "/fake/server.mjs", "--host", "0.0.0.0"]);
  return { endpoint, name };
}
function secretHash(w) {
  return w.dc(["run", "--rm", "--no-deps", "--entrypoint", "sh", "baskule-bootstrap", "-c", "sha256sum /run/baskule/*/secrets"]);
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
function stopWorld(w) {
  const logs = w.dc(["logs", "--no-color"], { allowFailure: true });
  if (logs) writeFileSync(resolve(evidence, `${w.project}.log`), logs);
  w.dc(["down", "-v", "--remove-orphans"], { allowFailure: true });
  purgeComputers(w);
}
function scopedSecrets(w) {
  // computerd drops root before exec; root without CAP_SYS_PTRACE cannot read its environ.
  for (const [service, role, keys, user] of [
    ["baskule-rustfs", "storage", ["RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"]],
    ["baskule-computerd", "computerd", ["COMPUTERD_TOKEN"], "node"],
  ]) {
    const container = w.dc(["ps", "-q", service]);
    const names = command(["exec", ...(user ? ["--user", user] : []), container, "sh", "-c",
      'environ=$(tr "\\0" "\\n" < /proc/1/environ) && printf "%s\\n" "$environ" | cut -d= -f1']).split("\n");
    expect(names.filter(name => /^(RUSTFS_(?:ACCESS_KEY|SECRET_KEY)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|S3_(?:ACCESS_KEY|SECRET_KEY)|SETUP_TOKEN|COMPUTERD_TOKEN|E2E_LOGIN_.*)$/.test(name)).sort()).toEqual(keys.sort());
    const mounts = JSON.parse(command(["inspect", "-f", "{{json .Mounts}}", container]));
    expect(mounts.filter(mount => mount.Name?.endsWith("-secrets")).map(mount => mount.Name)).toEqual([`${w.project}_baskule-${role}-secrets`]);
  }
  pass("RustFS and computerd expose only consumer secrets and no unrelated .env values");
}
function directClient(w) {
  const name = `${w.project}-direct-client`;
  containers.set(name, "proxy");
  command(["run", "-d", "--name", name, "--network", `${w.project}_baskule-net`, "--entrypoint", "sh",
    `${registry}/baskule-celld:${version}`, "-c", "exec tail -f /dev/null"]);
  const post = (body, extra = {}) => {
    const headers = { Host: "direct.baskule.test", Origin: "http://direct.baskule.test", "Content-Type": "application/json", ...extra };
    const result = command(["exec", "-i", name, "curl", "-sS", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}",
      ...Object.entries(headers).flatMap(([key,value]) => ["-H", `${key}: ${value}`]), "--data-binary", "@-", "http://baskule-edge:47090/auth/sign-in/email"], { input: JSON.stringify(body) });
    return Number(result);
  };
  expect(post(admin, { "X-Forwarded-Host": "spoof.baskule.test", Origin: "http://spoof.baskule.test" })).toBe(403);
  expect(post(admin, { "X-Forwarded-Proto": "https", Origin: "https://direct.baskule.test" })).toBe(403);
  for (let n = 0; n < 10; n++) expect(post({ ...admin, password: "wrong" }, { "X-Forwarded-For": `203.0.114.${n}` })).toBe(401);
  expect(post(admin, { "X-Forwarded-For": "203.0.114.200" })).toBe(429);
  command(["rm", "-f", name]); containers.delete(name);
  pass("with default proxy trust, a direct bridge client cannot spoof forwarded host, scheme or IP");
}
async function external() {
  const p = await port();
  const key = randomBytes(32).toString("hex");
  const w = world("single-external", { BASKULE_PORT: p, S3_ENDPOINT: "http://external-storage:47093",
    S3_ACCESS_KEY: "external-test", S3_SECRET_KEY: key });
  const override = resolve(w.directory, "broken-local-storage.yml");
  writeFileSync(override, 'services:\n  baskule-rustfs:\n    entrypoint: ["/bin/sh", "-c", "exit 1"]\n    restart: "no"\n');
  w.files.push("-f", override);
  w.dc(["create", "baskule-rustfs"]);
  const storage = `${w.project}-external-storage`;
  const volume = `${storage}-data`;
  containers.set(storage, "storage"); fixtureVolumes.add(volume);
  command(["run", "-d", "--name", storage, "--network", `${w.project}_baskule-net`, "--network-alias", "external-storage",
    "-e", "RUSTFS_ADDRESS=0.0.0.0:47093", "-e", "RUSTFS_CONSOLE_ENABLE=false", "-e", "RUSTFS_ACCESS_KEY=external-test",
    "-e", `RUSTFS_SECRET_KEY=${key}`, "-v", `${volume}:/data`,
    "rustfs/rustfs@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b", "rustfs", "/data"]);
  w.dc(["up", "-d", "baskule-rustfs", "setup", "baskule-edge"]);
  const base = `http://127.0.0.1:${p}`;
  await ready(`${base}/api/baskule/setup`);
  await completeSetup(w, base);
  await createApi({ urls: { loopback: base, front: base }, admin }).adminSession();
  expect(command(["inspect", "-f", "{{.State.ExitCode}}", w.dc(["ps", "-aq", "baskule-rustfs"])])).toBe("1");
  pass("external S3 deploys, completes setup and signs in while local RustFS has failed");
  w.dc(["stop"]);
  command(["rm", "-f", storage]); containers.delete(storage);
  stopWorld(w);
}
const caddyImage = "caddy:2@sha256:25cdc846626b62d05f6b633b9b40c2c9f6ef89b515dc76133cefd920f7dbe562";
async function outerProxy(w, upstream) {
  const proxyPort = await port();
  const config = resolve(w.directory, "outer-proxy.Caddyfile");
  writeFileSync(config, `{
    admin off
    auto_https off
  }
  :${proxyPort} {
    bind 127.0.0.1
    reverse_proxy ${upstream} {
      header_up Host proxy.baskule.test
      header_up X-Forwarded-Host proxy.baskule.test
      header_up X-Forwarded-Proto https
      header_up X-Forwarded-For {http.request.header.X-Test-Client-IP}
    }
  }`);
  const name = `${w.project}-outer-proxy`;
  containers.set(name, "proxy");
  command(["run", "-d", "--name", name, "--network", "host", "-v", `${config}:/etc/caddy/Caddyfile:ro`, caddyImage]);
  const base = `http://127.0.0.1:${proxyPort}`;
  await ready(`${base}/api/baskule/setup`);
  return { name, post: curlPost(w, base, { Origin: "https://proxy.baskule.test", "X-Test-Client-IP": "203.0.113.17" }) };
}
function curlPost(w, base, headers = {}, options = []) {
  return (path, body, extra = {}) => {
    const result = spawnSync("curl", ["-sS", "--max-time", "20", ...options, "-D", resolve(w.directory, "response-headers"), "-c", resolve(w.directory, "response-cookies"),
      ...Object.entries({ Origin: base, "Content-Type": "application/json", ...headers, ...extra }).flatMap(([key,value]) => ["-H", `${key}: ${value}`]),
      "--data-binary", "@-", "-w", "\n%{http_code}", `${base}${path}`], { input: JSON.stringify(body), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return Number(result.stdout.trim().split("\n").at(-1));
  };
}
function secureCookie(w) {
  expect(/set-cookie: (?:__Secure-)?baskule\.session_token=.*; Secure(?:;|\r|$)/i.test(readFileSync(resolve(w.directory, "response-headers"), "utf8"))).toBe(true);
}
function proxyBudgets(post) {
  for (let n = 0; n < 10; n++) expect(post("/auth/sign-in/email", { ...admin, password: "wrong" }, { "X-Test-Client-IP": "203.0.113.18" })).toBe(401);
  expect(post("/auth/sign-in/email", admin, { "X-Test-Client-IP": "203.0.113.18" })).toBe(429);
  expect(post("/auth/sign-in/email", admin, { "X-Test-Client-IP": "203.0.113.19" })).toBe(200);
}
function privateProxyBudget(post) {
  // A replacing proxy prevents incoming XFF injection; private_ranges coalesces LAN/VPN peers.
  for (let n = 0; n < 10; n++) expect(post("/auth/sign-in/email", { ...admin, password: "wrong" }, {
    "X-Test-Client-IP": `10.1.0.${n + 1}`, "X-Forwarded-For": `203.0.114.${n + 1}`,
  })).toBe(401);
  expect(post("/auth/sign-in/email", admin, {
    "X-Test-Client-IP": "10.1.0.200", "X-Forwarded-For": "203.0.114.200",
  })).toBe(429);
}
async function proxy() {
  for (const trusted of [false, true]) {
    const p = await port();
    const w = world(`single-proxy-${trusted ? "trusted" : "default"}`, { BASKULE_PORT: p, SETUP_TOKEN: adminVars.SETUP_TOKEN,
      ...(trusted ? { BASKULE_TRUSTED_PROXIES: "private_ranges" } : {}), COMPUTERD_TOKEN: "computer-env-override",
      RUSTFS_ACCESS_KEY: "rustfs-env-override", RUSTFS_SECRET_KEY: "rustfs-env-secret-override",
      E2E_LOGIN_EMAIL: "not-for-services@example.test", E2E_LOGIN_PASSWORD: "not-for-services" });
    w.dc(["up", "-d"]);
    const fixture = await outerProxy(w, `http://127.0.0.1:${p}`);
    const { post } = fixture;
    const setupLog = w.dc(["logs", "--no-color", "setup"]);
    expect(setupLog.includes(`http://127.0.0.1:${p}/setup#token=`)).toBe(true);
    const token = setupLog.match(/\/setup#token=([^\s]+)/)[1];
    expect(token).toBe(adminVars.SETUP_TOKEN);
    const body = { token, name: "Proxy admin", ...admin };
    if (!trusted) {
      expect(post("/api/baskule/setup", body)).toBe(403);
      envFile(w.file, { PUBLIC_ORIGINS: "https://proxy.baskule.test" });
      w.dc(["up", "-d"]);
      await ready(`http://127.0.0.1:${p}/api/baskule/setup`);
    }
    expect(post("/api/baskule/setup", body, { Origin: "https://foreign.test" })).toBe(403);
    expect(post("/api/baskule/setup", body)).toBe(201);
    if (trusted) secureCookie(w);
    expect(post("/auth/sign-in/email", admin)).toBe(200);
    expect(post("/auth/sign-in/email", admin, { Origin: "https://foreign.test" })).toBe(403);
    if (trusted) {
      proxyBudgets(post);
      privateProxyBudget(post);
      pass("explicitly trusted host-local proxy: setup, Secure cookie, sign-in, foreign Origin refusal and separate public-client limits plus a shared LAN/VPN budget without PUBLIC_ORIGINS");
    } else {
      directClient(w);
      // Changing a forwarded address does not create another rate-limit budget without trust.
      for (let n = 0; n < 8; n++) expect(post("/auth/sign-in/email", { ...admin, password: "wrong" }, { "X-Test-Client-IP": `203.0.113.${n + 30}` })).toBe(401);
      expect(post("/auth/sign-in/email", admin, { "X-Test-Client-IP": "203.0.113.90" })).toBe(429);
      pass("untrusted proxy: foreign origin refused until PUBLIC_ORIGINS is set, setup and sign-in work, clients share the proxy limit");
    }
    scopedSecrets(w);
    const countLinks = service => (w.dc(["logs", "--no-color", service]).match(/setup#token=/g) ?? []).length;
    expect(countLinks("baskule-deploy")).toBe(0);
    const before = countLinks("setup");
    w.dc(["up", "-d"]);
    expect(countLinks("setup")).toBe(before);
    expect(countLinks("baskule-deploy")).toBe(0);
    pass("custom port setup link, silent single-host deploy and no new setup links after admin creation");
    command(["rm", "-f", fixture.name]); containers.delete(fixture.name);
    stopWorld(w);
  }
}
async function https() {
  const httpPort = await port(), tlsPort = await port();
  const domain = "baskule.test";
  const w = world("single-https", { BASKULE_DOMAIN: domain, BASKULE_EDGE: "https", BASKULE_BIND: "127.0.0.1" });
  const config = JSON.parse(w.dc(["config", "--format", "json"]));
  expect(config.services["baskule-edge"].ports.map(p => [p.host_ip, p.target, p.protocol])).toEqual([
    [undefined, 80, "tcp"], [undefined, 443, "tcp"], [undefined, 443, "udp"],
  ]);
  expect(config.services["baskule-edge"].environment.BASKULE_TRUSTED_PROXIES).toBe("");
  envFile(w.file, { BASKULE_DOMAIN: "" });
  expect(() => w.dc(["run", "--rm", "--no-deps", "setup"])).toThrow("BASKULE_DOMAIN is required when BASKULE_EDGE=https");
  envFile(w.file, { BASKULE_DOMAIN: domain });
  pass("HTTPS without a domain fails setup with a clear configuration error");
  // Test-only CA and random port numbers; retain all-interface TCP/UDP publishing.
  const override = resolve(w.directory, "internal-ca.yml");
  const caddy = config.configs.edge.content.replace("admin off", "admin off\n    local_certs");
  writeFileSync(override, `services:\n  baskule-edge:\n    ports: !override ["${httpPort}:80", "${tlsPort}:443", "${tlsPort}:443/udp"]\nconfigs:\n  edge:\n    content: ${JSON.stringify(caddy)}\n`);
  w.files.push("-f", override);
  w.dc(["up", "-d"]);
  const edge = w.dc(["ps", "-q", "baskule-edge"]);
  const bindings = JSON.parse(command(["inspect", "-f", "{{json .NetworkSettings.Ports}}", edge]));
  for (const listener of ["80/tcp", "443/tcp", "443/udp"]) {
    expect(bindings[listener].map(p => p.HostIp).sort()).toEqual(["0.0.0.0", "::"]);
  }
  const ca = resolve(w.directory, "root.crt");
  await expect.poll(() => command(["exec", edge, "sh", "-c", "test -f /data/caddy/pki/authorities/local/root.crt && echo ready"], { allowFailure: true }), { timeout: 30_000 }).toBe("ready");
  command(["cp", `${edge}:/data/caddy/pki/authorities/local/root.crt`, ca]);
  const base = `https://${domain}`;
  const options = ["--noproxy", "*", "--cacert", ca, "--connect-to", `${domain}:443:127.0.0.1:${tlsPort}`];
  await expect.poll(() => spawnSync("curl", ["-sS", "--max-time", "3", ...options, "-o", "/dev/null", "-w", "%{http_code}", `${base}/api/baskule/setup`], { encoding: "utf8" }).stdout, { timeout: 60_000 }).toBe("200");
  const redirect = spawnSync("curl", ["-sS", "-I", "-H", `Host: ${domain}`, `http://127.0.0.1:${httpPort}`], { encoding: "utf8" });
  expect(redirect.stdout).toContain(`Location: https://${domain}/`);
  const logs = w.dc(["logs", "--no-color", "setup"]);
  expect(logs).toContain(`${base}/setup#token=`);
  const token = logs.match(/\/setup#token=([^\s]+)/)[1];
  const post = curlPost(w, base, {}, options);
  expect(post("/api/baskule/setup", { token, name: "HTTPS admin", ...admin })).toBe(201);
  secureCookie(w);
  const me = spawnSync("curl", ["-sS", ...options, "-b", resolve(w.directory, "response-cookies"), `${base}/api/baskule/me`], { encoding: "utf8" });
  expect(me.status).toBe(0);
  expect(JSON.parse(me.stdout).user.role).toBe("admin");
  expect(post("/auth/sign-in/email", admin)).toBe(200);
  secureCookie(w);
  expect(post("/auth/sign-in/email", admin, { Origin: "https://foreign.test" })).toBe(403);
  // The private HTTP listener remains available for computerd runtime settings.
  expect(command(["exec", w.dc(["ps", "-q", "baskule-computerd"]), "sh", "-c",
    '. /run/baskule/secrets; exec node -e \'fetch(process.env.PRODUCT_SETTINGS_URL,{headers:{Authorization:"Bearer "+process.env.COMPUTERD_TOKEN}}).then(r=>{console.log(r.status);if(!r.ok)process.exit(1)})\''])).toBe("200");
  const ipv6 = spawnSync("curl", ["-sS", "--max-time", "10", ...options.slice(0, -1),
    `${domain}:443:[::1]:${tlsPort}`, "-o", "/dev/null", "-w", "%{http_code}", `${base}/api/baskule/setup`], { encoding: "utf8" });
  expect(ipv6.status, ipv6.stderr).toBe(0);
  expect(ipv6.stdout).toBe("200");
  const originalCA = readFileSync(ca, "utf8");
  w.dc(["up", "-d", "--no-deps", "--force-recreate", "baskule-edge"]);
  const recreated = w.dc(["ps", "-q", "baskule-edge"]);
  expect(recreated).not.toBe(edge);
  await expect.poll(() => spawnSync("curl", ["-sS", "--max-time", "3", ...options, "-o", "/dev/null", "-w", "%{http_code}", `${base}/api/baskule/setup`], { encoding: "utf8" }).stdout, { timeout: 60_000 }).toBe("200");
  command(["cp", `${recreated}:/data/caddy/pki/authorities/local/root.crt`, ca]);
  expect(readFileSync(ca, "utf8")).toBe(originalCA);
  pass("built-in HTTPS with test-only internal CA: verified TLS, HTTP redirect, domain setup URL, Secure cookies, sign-in, origin refusal, private settings, IPv4/IPv6 TCP and UDP listeners, and CA retained across edge recreation without PUBLIC_ORIGINS");
  stopWorld(w);
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
  pass(`${w.project}: version, default password auth, admin sign-in, fake chat, platform-to-computer command, computer execution`);
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
    await health(w, ["baskule-celld-a", "baskule-celld-b", "baskule-computerd"]);
    await ready(`${base}/version.json`);
    await completeSetup(w, base);
    await createApi({ urls: { loopback: base, front: base }, admin }).adminSession();
    expect(w.dc(["ps", "-a", "--format", "{{.ExitCode}}", "baskule-bootstrap"])).toBe("0");
    writeFileSync(resolve(evidence, `${w.project}.log`), w.dc(["logs", "--no-color"]));
    pass(`fresh install ${attempt}/3: first up, bucket bootstrap, all services healthy, version and quoted-password admin sign-in`);
    w.dc(["down", "-v"]);
  }
}
async function single() {
  const base = "http://127.0.0.1:47090";
  const w = world("single", {});
  w.dc(["up", "-d"]);
  await health(w, ["baskule-celld-a", "baskule-celld-b", "baskule-computerd"]);
  const llm = await fake(w);
  const result = await exercise(w, base, llm.endpoint);
  const secrets = secretHash(w);
  w.dc(["up", "-d"]);
  expect(secretHash(w)).toBe(secrets);
  pass("second up preserves generated secrets");
  expect(secretHash(w)).toBe(secrets);
  await persisted(base, result);
  writeFileSync(resolve(run, "single-proof.json"), JSON.stringify({ ...result, directory: w.directory, instance: JSON.parse(w.dc(["config", "--format", "json"])).services["baskule-computerd"].environment.COMPUTERD_INSTANCE }), { mode: 0o600 });
  command(["rm", "-f", llm.name]); containers.delete(llm.name);
  // Use exactly the documented stop/backup/start operations from the install directory.
  w.dc(["down"]);
  const backup = resolve(evidence, "single-backup.tar.gz");
  w.dc(["run", "--rm", "-T", "backup"], { output: backup });
  w.dc(["up", "-d"]);
  await health(w, ["baskule-celld-a", "baskule-celld-b", "baskule-computerd"]);
  await ready(`${base}/version.json`);
  await persisted(base, result);
  pass("single-machine down/up preserves chat and computer disk");
  w.dc(["down", "-v"]);
  purgeComputers(w);
  w.dc(["run", "--rm", "-T", "restore"], { inputFile: backup });
  w.dc(["up", "-d"]);
  await health(w, ["baskule-celld-a", "baskule-celld-b", "baskule-computerd"]);
  await ready(`${base}/version.json`);
  await persisted(base, result);
  expect(secretHash(w)).toBe(secrets);
  pass("restored secrets match the original volume");
  pass("single-machine backup restores chat and computer disk into empty volumes");
  stopWorld(w);
}
function purgeComputers(w) {
  const config = JSON.parse(w.dc(["--profile", "*", "config", "--format", "json"]));
  const service = config.services["baskule-computerd"];
  const instance = service.environment.COMPUTERD_INSTANCE;
  if (!instance) throw new Error("Refusing cleanup without COMPUTERD_INSTANCE");
  const filters = ["--filter", "label=baskule.managed=true", "--filter", `label=baskule.instance=${instance}`];
  for (const name of command(["ps", "-aq", ...filters]).split(/\s+/).filter(Boolean)) command(["rm", "-f", name]);
  for (const name of command(["volume", "ls", "-q", ...filters]).split(/\s+/).filter(Boolean)) command(["volume", "rm", name]);
  const network = service.environment.COMPUTER_NETWORK;
  // `docker inspect` prints [] when the object is missing.
  const [value] = JSON.parse(command(["network", "inspect", network], { allowFailure: true }) || "[]");
  if (value?.Labels?.["baskule.instance"] === instance && Object.keys(value.Containers ?? {}).length === 0) command(["network", "rm", network]);
  const legacy = service.environment.COMPUTER_LEGACY_VOLUME;
  if (legacy && command(["volume", "ls", "-q", "--filter", `name=^${legacy}$`])) command(["volume", "rm", legacy]);
  command(["run", "--rm", "--network", "host", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--read-only", "--tmpfs", "/run", "--entrypoint", "node", service.image, "--input-type=module", "-e", 'import {guardGcScript} from "./src/guard.ts"; import {execFileSync} from "node:child_process"; execFileSync("sh", ["-ec", guardGcScript()], {stdio:"inherit"});']);
}
async function restoreOnly() {
  if (!process.argv[3]) throw new Error("Pass the private single-proof.json path");
  const previous = JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"));
  const p = await port();
  const base = `http://127.0.0.1:${p}`;
  const w = world("single", adminVars);
  if (existsSync(resolve(previous.directory, ".env"))) copyFileSync(resolve(previous.directory, ".env"), w.file);
  envFile(w.file, { BASKULE_REGISTRY: registry, BASKULE_VERSION: version, BASKULE_PORT: p, PUBLIC_ORIGINS: base, COMPUTERD_INSTANCE: previous.instance ?? previous.directory.split("/").at(-1) });
  w.dc(["run", "--rm", "-T", "restore"], { inputFile: resolve(evidence, "single-backup.tar.gz") });
  w.dc(["up", "-d"]);
  await ready(`${base}/version.json`);
  await persisted(base, previous);
  pass("focused restore preserves chat and restores the computer disk into empty volumes");
}
try {
  if (target === "all" || target === "https") await https();
  if (target === "all" || target === "proxy") await proxy();
  if (target === "all" || target === "external") await external();
  if (target === "fresh") await fresh();
  if (target === "restore") await restoreOnly();
  if (target === "all" || target === "single") await single();
} finally {
  for (const [name, kind] of containers) if (kind === "model" || kind === "proxy") command(["rm", "-f", name], { allowFailure: true });
  for (const w of [...projects].reverse()) {
    const logs = w.dc(["logs", "--no-color"], { allowFailure: true });
    if (logs) writeFileSync(resolve(evidence, `${w.project}.log`), logs);
    w.dc(["down", "-v", "--remove-orphans"], { allowFailure: true });
    // Best effort: a cleanup failure must not hide the test failure or skip the remaining cleanup.
    try { purgeComputers(w); } catch (error) { console.error(`computer cleanup failed for ${w.project}: ${error.message}`); }
  }
  for (const [name, kind] of containers) if (kind === "storage") command(["rm", "-f", name], { allowFailure: true });
  for (const volume of fixtureVolumes) command(["volume", "rm", volume], { allowFailure: true });
  for (const image of fixtureImages) command(["image", "rm", image], { allowFailure: true });
}
