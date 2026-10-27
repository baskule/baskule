// Per-worktree real app stacks. Profiles describe processes; this file owns their lifecycle.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN = join(ROOT, ".run/stack");
const STATE = join(RUN, "stack.json");
const SHARED = process.env.BASKULE_SHARED || (existsSync(join(ROOT, ".tools"))
  ? dirname(realpathSync(join(ROOT, ".tools")))
  : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "baskule"));
const REGISTRY = join(SHARED, "run/stacks");
const CACHE = join(SHARED, "cache/builds");
const args = process.argv.slice(2);
const command = args.shift() || "help";
const json = args.includes("--json");
const notice = (s) => console.error(s);
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
function save(p, value) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${p}.${process.pid}.tmp`, p);
}
function run(cmd, argv = [], options = {}) {
  const settings = { cwd: ROOT, env: process.env, encoding: "utf8", maxBuffer: 32 << 20, ...options };
  if (cmd === "portless") settings.env = portlessEnvironment(settings.env);
  const r = spawnSync(cmd, argv, settings);
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")}: ${r.error?.message || r.stderr || r.stdout || `exit ${r.status}`}`);
  return Buffer.isBuffer(r.stdout) ? r.stdout : r.stdout?.trim() || "";
}
export function portlessEnvironment(env = process.env) {
  // A globally installed Portless must not inherit pnpm-exec's dlx detection flags.
  const { npm_command: _npmCommand, PNPM_SCRIPT_SRC_DIR: _pnpmScript, ...clean } = env;
  return clean;
}
function removeAlias(s) {
  if (!s.aliasRegistered) return;
  const r = spawnSync("portless", ["alias", "--remove", s.alias], { encoding: "utf8", env: portlessEnvironment() });
  if (r.status !== 0 && !r.stderr?.includes("No alias found")) throw new Error(`Cannot remove alias ${s.alias}: ${r.error?.message || r.stderr}`);
  s.aliasRegistered = false;
}
async function lock(name) {
  const p = join(SHARED, "run/locks", `${name}.lock`);
  mkdirSync(dirname(p), { recursive: true });
  const fd = openSync(p, "a");
  try {
    await new Promise((yes, no) => {
      const child = spawn("flock", ["-x", "-w", "600", "3"], { stdio: ["ignore", "ignore", "inherit", fd] });
      child.once("error", no);
      child.once("exit", (code) => code === 0 ? yes() : no(new Error(`Lock ${name} unavailable; retry after the other startup finishes.`)));
    });
    return () => closeSync(fd);
  } catch (e) { closeSync(fd); throw e; }
}
function identity(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return f[0] === "Z" ? null : { pid, start: f[19], group: Number(f[2]), parent: Number(f[1]) };
  } catch { return null; }
}
function alive(p) { return p && identity(p.pid)?.start === p.start; }
function descendants(p) {
  if (!alive(p)) return [];
  const all = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map((p) => identity(Number(p))).filter(Boolean);
  const ids = new Set([p.pid]);
  let previous;
  do { previous = ids.size; for (const child of all) if (ids.has(child.parent)) ids.add(child.pid); } while (ids.size !== previous);
  return all.filter((child) => ids.has(child.pid));
}
function listeners(port) {
  const output = run("ss", ["-H", "-ltnp", `sport = :${port}`]);
  return [...output.matchAll(/pid=(\d+)/g)].map((m) => identity(Number(m[1]))).filter(Boolean);
}
async function until(label, fn, timeout = 180_000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { if (e.code === "STACK_SERVICE_EXITED") throw e; error = e; }
    await delay(200);
  }
  throw new Error(`${label}: timed out${error ? ` (${error.message})` : ""}. See scripts/stack logs <service>.`);
}
async function http(url, options = {}) { return fetch(url, { signal: AbortSignal.timeout(10_000), ...options }); }
async function probe(url) { const r = await http(url); await r.arrayBuffer(); return r.ok; }
async function freePort() {
  const server = createServer();
  await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const port = server.address().port;
  await new Promise((yes) => server.close(yes));
  return port;
}
function interpolate(value, env) {
  if (typeof value === "string") return value.replace(/\$\{([A-Z_0-9]+)\}/g, (_, key) => {
    if (env[key] === undefined) throw new Error(`Profile references unknown variable ${key}. Supply --set ${key}=value.`);
    return env[key];
  });
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}
function profile(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Profile names use lowercase letters, digits and hyphens.");
  const path = join(ROOT, "stack/profiles", `${name}.json`);
  if (!existsSync(path)) throw new Error(`Profile ${name} missing. Add ${path}, or use --profile full|light|rustfs.`);
  const p = load(path);
  p.shared ??= [];
  p.env ??= {};
  if (!Array.isArray(p.shared) || !p.env || typeof p.env !== "object" || Array.isArray(p.env)) throw new Error(`Invalid ${path}: shared must be an array and env an object.`);
  if (!["dev", "rustfs"].includes(p.mode) || !p.services?.celld) throw new Error(`Invalid ${path}: mode must be dev or rustfs and services must include celld.`);
  for (const [name, service] of Object.entries(p.services)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || (name !== "celld" && typeof service.command !== "string")) throw new Error(`Invalid service ${name} in ${path}.`);
  }
  for (const service of p.shared || []) if (!["gateway", "rustfs"].includes(service)) throw new Error(`Unknown shared service ${service} in ${path}.`);
  return p;
}
function overrides() {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--set") continue;
    const match = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(args[++i] || "");
    if (!match) throw new Error("Expected --set K=V (uppercase environment variable).");
    result[match[1]] = match[2];
  }
  return result;
}
export function environment(s) {
  const ports = Object.fromEntries(Object.entries(s.ports).map(([name, port]) => [`PORT_${name.toUpperCase().replaceAll("-", "_")}`, String(port)]));
  const base = { ...process.env, ROOT, RUN, ...ports,
    LOOPBACK_URL: s.urls.loopback, STACK_URL: s.urls.front, COMPUTERD_INSTANCE: s.id,
    COMPUTERD_TOKEN: s.computerdToken, COMPUTERD_PORT: String(s.ports.computerd), COMPUTERD_HOST: "127.0.0.1",
    DEV_GATEWAY_PORT: process.env.DEV_GATEWAY_PORT || "47510", DEV_VOLUMES_PORT: process.env.DEV_VOLUMES_PORT || "47511",
    OPENSHELL_VOLUMES_TOKEN: process.env.OPENSHELL_VOLUMES_TOKEN || "dev-volumes-token",
    FAKE_LLM_KEY: "fake-llm-key", CELLD_ESBUILD: join(ROOT, "platform/node_modules/.bin/esbuild"),
    ...(s.definition.mode === "dev" ? { CELLD_TTL_MS: process.env.CELLD_TTL_MS || "60000" } : {}),
    CELLD_OTEL: "0", DO_NOT_TRACK: "1", CELLD_FETCH_TIMEOUT_S: "3600", CELLD_V8_HEAP_LIMIT_MB: "1024",
    AWS_ACCESS_KEY_ID: "osdev", AWS_SECRET_ACCESS_KEY: "osdev-only-secret", AWS_REGION: "us-east-1",
  };
  const pending = { OPENSHELL_GATEWAY: "127.0.0.1:${DEV_GATEWAY_PORT}", OPENSHELL_VOLUMES_URL: "http://127.0.0.1:${DEV_VOLUMES_PORT}", ...s.definition.env, ...s.overrides };
  const resolving = new Set();
  const resolveValue = (key) => {
    if (resolving.has(key)) throw new Error(`Profile environment has a cycle at ${key}.`);
    if (!(key in pending)) return base[key];
    resolving.add(key);
    const value = interpolate(pending[key], new Proxy(base, { get: (_, name) => resolveValue(name) }));
    resolving.delete(key);
    delete pending[key];
    return base[key] = value;
  };
  for (const key of Object.keys(pending)) resolveValue(key);
  base.COMPUTERD_INSTANCE = s.id;
  return base;
}
function persist(s) {
  if (existsSync(s.worktree)) save(join(s.worktree, ".run/stack/stack.json"), s);
  save(join(REGISTRY, `${s.id}.json`), s);
}
function registry() {
  mkdirSync(REGISTRY, { recursive: true });
  return readdirSync(REGISTRY).filter((f) => f.endsWith(".json")).map((file) => {
    try {
      const s = load(join(REGISTRY, file));
      if (typeof s.id !== "string" || typeof s.worktree !== "string" || !s.processes || !s.definition) throw new Error("invalid stack state");
      return s;
    } catch (error) {
      notice(`Keeping unreadable registry ${file}: ${error.message}. Repair it before retrying gc.`);
      return { id: file.slice(0, -5), invalid: true, worktree: "(unreadable registry)" };
    }
  });
}
async function stopService(s, name) {
  const p = s.processes[name];
  if (!p) return;
  // celld dev's listener has its own process group. Capture descendants and verify PID start times.
  const members = [...descendants(p), ...(p.children || []).filter(alive)];
  for (const m of members) {
    if (!owned(m, s.worktree)) throw new Error(`Refusing to stop ${name}: process ${m.pid} ownership changed.`);
  }
  const signal = (sig) => {
    for (const m of members) if (alive(m)) {
      try { process.kill(m.pid, sig); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
  };
  signal("SIGTERM");
  try { await until(`${name} exit`, () => members.every((m) => !alive(m)), 10_000); }
  catch { signal("SIGKILL"); await until(`${name} forced exit`, () => members.every((m) => !alive(m)), 5000); }
  delete s.processes[name];
}
function owned(p, worktree) {
  try { const cwd = readlinkSync(`/proc/${p.pid}/cwd`).replace(/ \(deleted\)$/, ""); return cwd === worktree || cwd.startsWith(`${worktree}/`); }
  catch { return false; }
}
async function prune() {
  const removed = [];
  for (const s of registry()) {
    if (s.invalid) continue;
    try {
      if (existsSync(s.worktree) && (alive(s.launcher) || (s.phase === "running" && Object.values(s.processes).length > 0 && Object.values(s.processes).every(alive)))) continue;
      for (const name of Object.keys(s.processes).reverse()) await stopService(s, name);
      await cleanupComputers(s, !existsSync(s.worktree));
      if (!existsSync(s.worktree) && s.definition.mode === "rustfs") purgeBucket(s);
      removeAlias(s);
      rmSync(join(REGISTRY, `${s.id}.json`), { force: true });
      s.phase = "stopped";
      const local = join(s.worktree, ".run/stack/stack.json");
      if (existsSync(local)) save(local, s);
      removed.push(s.id);
    } catch (error) { notice(`Kept stack ${s.id}: ${error.message}. Retry scripts/stack gc after resolving this error.`); }
  }
  return removed;
}
function trustBrowserCA() {
  const ca = join(process.env.PORTLESS_STATE_DIR || join(homedir(), ".portless"), "ca.pem");
  const legacy = join(homedir(), ".pki/nssdb");
  // Chrome M146+ prefers XDG data unless the legacy NSS directory already exists.
  const database = existsSync(legacy) ? legacy : join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "pki/nssdb");
  if (spawnSync("certutil", ["-H"], { stdio: "ignore" }).error) throw new Error("Chromium CA trust requires certutil. Install libnss3-tools, then retry scripts/stack up.");
  mkdirSync(database, { recursive: true, mode: 0o700 });
  const db = `sql:${database}`, nickname = "osdev-portless";
  if (!existsSync(join(database, "cert9.db"))) run("certutil", ["-N", "--empty-password", "-d", db]);
  const current = spawnSync("certutil", ["-L", "-a", "-d", db, "-n", nickname], { encoding: "utf8" });
  const same = current.status === 0 && new X509Certificate(current.stdout).fingerprint256 === new X509Certificate(readFileSync(ca)).fingerprint256;
  if (!same) {
    if (current.status === 0) run("certutil", ["-D", "-d", db, "-n", nickname]);
    run("certutil", ["-A", "-d", db, "-n", nickname, "-t", "C,,", "-i", ca]);
  } else run("certutil", ["-M", "-d", db, "-n", nickname, "-t", "C,,"]);
  notice(`Portless CA trusted for Chromium: ${database}`);
  return { ca, database };
}
async function sharedServices(s) {
  for (const service of s.definition.shared || []) {
    if (service === "gateway") {
      run(join(ROOT, "openshell/dev-up.sh"), [], { env: environment(s), stdio: ["ignore", 2, 2] });
      continue;
    }
    const release = await lock(`stack-shared-${service}`);
    try {
      if (service === "rustfs") {
        const running = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", "osdev-rustfs"], { encoding: "utf8" });
        if (running.stdout?.trim() !== "true") {
          if (running.status === 0) run("docker", ["start", "osdev-rustfs"]);
          else run("docker", ["run", "-d", "--name", "osdev-rustfs", "-p", "127.0.0.1:47490:9000", "-v", "osdev-rustfs:/data", "-e", "RUSTFS_ADDRESS=0.0.0.0:9000", "-e", "RUSTFS_CONSOLE_ENABLE=false", "-e", "RUSTFS_ACCESS_KEY=osdev", "-e", "RUSTFS_SECRET_KEY=osdev-only-secret", "rustfs/rustfs:latest", "/data"]);
        }
        await until("shared RustFS", () => probe("http://127.0.0.1:47490/health/ready"));
        run("node", ["platform/dev/s3-mkbucket.mjs", "http://127.0.0.1:47490", "osdev"], { env: environment(s), stdio: ["ignore", 2, 2] });
      }
    } finally { release(); }
  }
  if (process.env.BASKULE_STACK_PROXY === "0") return;
  const release = await lock("stack-shared-portless");
  try {
    run("portless", ["proxy", "start"], { stdio: ["ignore", 2, 2] });
    s.browserTrust = trustBrowserCA();
  }
  finally { release(); }
}

function webKey(env) {
  const hash = createHash("sha256").update("hosted-web-v2\0");
  const configEnv = Object.entries(env).filter(([k]) => /^(VITE_|EXPO_PUBLIC_|VERCEL_|T3CODE_(CLERK_|RELAY_|WEB_|BUNDLED_DEV|DESKTOP_UPDATE_)|APP_VERSION$|GITHUB_REPOSITORY$)/.test(k)).sort(([a], [b]) => a.localeCompare(b));
  hash.update(JSON.stringify(configEnv));
  for (const path of ["app/.env", "app/.env.local", "app/apps/web/.env", "app/apps/web/.env.local", "app/apps/web/.env.production", "app/apps/web/.env.production.local"]) {
    if (existsSync(join(ROOT, path))) hash.update(path).update(readFileSync(join(ROOT, path)));
  }
  // Hash file contents, including dirty/untracked inputs; never cache a dirty build under HEAD's key.
  const paths = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "app"], { encoding: "buffer" });
  for (const p of paths.toString().split("\0").filter(Boolean).sort()) {
    if (p.endsWith(".md") || !existsSync(join(ROOT, p))) continue;
    if (!statSync(join(ROOT, p)).isFile()) continue;
    hash.update(p).update("\0").update(readFileSync(join(ROOT, p))).update("\0");
  }
  return hash.digest("hex");
}
async function build(s) {
  run(join(ROOT, "scripts/worktree"), ["setup"], { env: { ...process.env, CI: "1" }, stdio: ["ignore", 2, 2] });
  const env = environment(s);
  const webEnv = { ...env, VITE_BASKULE_HOSTED: "1", T3CODE_SINGLE_ORIGIN_DEV: "1", VITE_HTTP_URL: "", VITE_WS_URL: "" };
  const key = webKey(webEnv);
  const cached = join(CACHE, `hosted-web-${key}`);
  const release = await lock(`stack-web-${key}`);
  try {
    if (!existsSync(join(cached, "index.html"))) {
      notice(`Building hosted web client (${key.slice(0, 12)}); log: ${RUN}/build.log`);
      const temp = `${cached}.${process.pid}`;
      const fd = openSync(join(RUN, "build.log"), "a");
      try {
        // The mock web check serves dist while this stack builds in another check lane.
        run("nice", ["-n", "10", join(ROOT, "app/node_modules/.bin/vp"), "build", "--outDir", temp], { cwd: join(ROOT, "app/apps/web"), env: webEnv, stdio: ["ignore", fd, fd] });
        renameSync(temp, cached);
      } finally { closeSync(fd); rmSync(temp, { recursive: true, force: true }); }
    } else notice(`Reusing hosted web client ${key.slice(0, 12)}`);
    run("node", ["scripts/build.mjs"], { cwd: join(ROOT, "platform"), env: { ...env, BASKULE_OUT: join(RUN, "app"), BASKULE_WEB_DIR: cached }, stdio: ["ignore", 2, 2] });
    const w = load(join(ROOT, "platform/wrangler.json"));
    w.name = `osdev-${s.id}`;
    w.main = "worker.js"; w.assets.directory = "web";
    Object.assign(w.vars, {
      PUBLIC_ORIGINS: `${s.urls.front},${s.urls.loopback}`, ADMIN_EMAIL: s.admin.email, ADMIN_PASSWORD: s.admin.password,
      AUTH_SECRET: s.authSecret, COMPUTERD_URL: s.ports.computerd ? `http://127.0.0.1:${s.ports.computerd}` : "http://127.0.0.1:1",
      COMPUTERD_TOKEN: s.computerdToken, ...Object.fromEntries(Object.keys({ ...s.definition.env, ...s.overrides }).map((key) => [key, env[key]])),
    });
    save(join(RUN, "app/wrangler.json"), w);
    s.webBuildKey = key;
    utimesSync(cached, new Date(), new Date());
  } finally { release(); }
}
function celldRecipe(s) {
  const cmd = process.env.CELLD_BIN || join(ROOT, "scripts/celld.sh");
  if (s.definition.mode === "dev") return { command: cmd, args: ["dev", ".", "--port", String(s.ports.celld), "--no-watch", "--logs"], cwd: join(RUN, "app") };
  const env = environment(s);
  const bucket = `s3://osdev/${s.bucketPrefix}`;
  run(cmd, ["deploy", join(RUN, "app/wrangler.json"), "--bucket", bucket, "--endpoint", "http://127.0.0.1:47490"], { env, stdio: ["ignore", 2, 2] });
  mkdirSync(join(RUN, "node"), { recursive: true });
  return { command: cmd, args: ["--bucket", bucket, "--endpoint", "http://127.0.0.1:47490", "--listen", `127.0.0.1:${s.ports.celld}`, "--internal-listen", `127.0.0.1:${s.ports.internal}`, "--advertise", `127.0.0.1:${s.ports.internal}`], cwd: join(RUN, "app"), env: { CELLD_WATCH: join(RUN, "node"), CELLD_NODE: `osdev-${s.id}` } };
}
async function startService(s, name) {
  const env = environment(s);
  const recipe = name === "celld" ? { ...s.definition.services[name], ...celldRecipe(s) } : s.definition.services[name];
  const r = interpolate(recipe, env);
  const fd = openSync(s.logs[name], "a", 0o600);
  let child;
  try {
    child = spawn(r.command, r.args || [], { cwd: resolve(ROOT, r.cwd || "."), env: { ...env, ...r.env, COMPUTERD_INSTANCE: s.id }, detached: true, stdio: ["ignore", fd, fd] });
    await new Promise((yes, no) => { child.once("spawn", yes); child.once("error", no); });
    s.processes[name] = identity(child.pid);
    child.unref();
    persist(s);
  } finally { closeSync(fd); }
  if (r.health) await until(`${name} ready (${r.health})`, async () => {
    if (!alive(s.processes[name])) throw Object.assign(new Error(`${name} exited; inspect ${s.logs[name]}`), { code: "STACK_SERVICE_EXITED" });
    return probe(r.health);
  });
  s.processes[name].children = descendants(s.processes[name]).filter((p) => p.pid !== s.processes[name].pid);
  persist(s);
}
async function login(s) {
  const r = await http(`${s.urls.loopback}/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: s.urls.loopback }, body: JSON.stringify(s.admin), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Admin sign-in returned ${r.status}: ${await r.text()}`);
  await r.arrayBuffer();
  return r;
}
async function cleanupComputers(s, purge) {
  if (!s.definition.shared?.includes("gateway")) return;
  const running = run("docker", ["ps", "-q", "--filter", "name=^/osdev-openshell$"]);
  if (!running) {
    if (!s.volumes?.length && !run("docker", ["ps", "-aq", "--filter", "name=^/osdev-openshell$"])) return;
    run(join(ROOT, "openshell/dev-up.sh"), [], { env: environment(s), stdio: ["ignore", 2, 2] });
  }
  const { Gateway } = await import("../computerd/v2/src/gateway.ts");
  const env = environment(s);
  const gw = new Gateway(env.OPENSHELL_GATEWAY);
  try {
    const computers = await gw.list(`baskule.managed=true,baskule.instance=${s.id}`);
    for (const computer of computers) {
      if (computer.labels["baskule.instance"] !== s.id || !/^os-[a-f0-9]{16}$/.test(computer.name)) throw new Error(`Cannot establish ownership of ${computer.name}.`);
      // U2a's namesFor gives the sandbox and volume the same instance/space hash.
      s.volumes = [...new Set([...(s.volumes || []), `baskule-space-${computer.name.slice(3)}`])];
      persist(s);
      await gw.remove(computer.name);
      await until(`${computer.name} removal`, async () => !(await gw.get(computer.name)), 150_000);
    }
  } finally { gw.close(); }
  if (purge) for (const volume of [...(s.volumes || [])]) {
    await until(`${volume} removal`, async () => {
      const response = await http(`${env.OPENSHELL_VOLUMES_URL}/volumes/${volume}`, { method: "DELETE", headers: { authorization: `Bearer ${env.OPENSHELL_VOLUMES_TOKEN}` } });
      if (response.status === 409) { await response.arrayBuffer(); return false; }
      if (!response.ok) throw new Error(`Volume cleanup ${volume}: ${response.status} ${await response.text()}`);
      await response.arrayBuffer(); return true;
    }, 90_000);
    s.volumes = s.volumes.filter((name) => name !== volume);
    persist(s);
  }
}
function purgeBucket(s) {
  const env = environment(s);
  const curl = ["--fail", "--silent", "--show-error", "--max-time", "120", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${env.AWS_ACCESS_KEY_ID}:${env.AWS_SECRET_ACCESS_KEY}`];
  const base = "http://127.0.0.1:47490/osdev";
  for (;;) {
    const listing = run("curl", [...curl, `${base}?encoding-type=url&list-type=2&max-keys=100&prefix=${encodeURIComponent(s.bucketPrefix + "/")}`]);
    const keys = [...listing.matchAll(/<Key>(.*?)<\/Key>/g)].map((m) => decodeURIComponent(m[1]));
    if (!keys.length) return;
    const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const body = `<Delete><Quiet>true</Quiet>${keys.map((key) => `<Object><Key>${xml(key)}</Key></Object>`).join("")}</Delete>`;
    const result = run("curl", [...curl, "-H", "content-type: application/xml", "-H", `content-md5: ${createHash("md5").update(body).digest("base64")}`, "-H", `x-amz-content-sha256: ${createHash("sha256").update(body).digest("hex")}`, "--data-binary", "@-", `${base}?delete`], { input: body });
    if (result.includes("<Error>")) throw new Error(`RustFS prefix purge failed: ${result}. Retry scripts/stack down --purge.`);
  }
}
async function down(s, purge = false) {
  s.phase = "stopping"; s.launcher = identity(process.pid); persist(s);
  // Stop cell alarms before stopping computers, so a scheduled task cannot wake one during teardown.
  await stopService(s, "celld"); persist(s);
  for (const name of Object.keys(s.processes).reverse()) { await stopService(s, name); persist(s); }
  await cleanupComputers(s, purge);
  removeAlias(s);
  rmSync(join(REGISTRY, `${s.id}.json`), { force: true });
  s.phase = "stopped"; save(STATE, s);
  if (purge) {
    if (s.definition.mode === "rustfs") purgeBucket(s);
    rmSync(RUN, { recursive: true, force: true });
  }
}
function state() {
  if (!existsSync(STATE)) throw new Error("No stack in this worktree. Run scripts/stack up first.");
  const s = load(STATE);
  if (s.worktree !== ROOT) throw new Error("Stack state belongs to another worktree. Remove the copied .run/stack directory first.");
  return s;
}
async function seed(s) {
  const env = environment(s);
  const auth = await login(s);
  const headers = { authorization: `Bearer ${auth.headers.get("set-auth-token")}`, "content-type": "application/json" };
  const currentResponse = await http(`${s.urls.loopback}/api/baskule/admin/settings`, { headers });
  if (!currentResponse.ok) throw new Error(`Read model settings: ${currentResponse.status}`);
  const { apiKeyConfigured: _apiKeyConfigured, transcriptionApiKeyConfigured: _transcriptionApiKeyConfigured, authentication: _authentication, ...settings } = await currentResponse.json();
  const model = env.LLM_MODEL || "fake-model";
  const r = await http(`${s.urls.loopback}/api/baskule/admin/settings`, { method: "PATCH", headers, body: JSON.stringify({
    ...settings, apiKey: env.LLM_API_KEY || "fake-llm-key",
    ai: { providerId: "custom", baseUrl: env.LLM_BASE_URL || `http://127.0.0.1:${s.ports["fake-llm"]}/v1`, model: { id: model, name: model, image: true, pdf: true, limit: { context: 200_000, output: 16_000 }, settings: {} } },
  }) });
  if (!r.ok) throw new Error(`Save model settings: ${r.status} ${await r.text()}`);
}
function portOwner(port, p) {
  const owners = listeners(port);
  const children = descendants(p);
  return owners.length > 0 && owners.every((owner) => children.some((child) => child.pid === owner.pid && child.start === owner.start) && owned(owner, ROOT));
}
async function doctor(s) {
  const checks = [];
  for (const service of s.definition.shared || []) {
    if (service === "gateway") {
      const r = spawnSync("docker", ["exec", "osdev-openshell", "curl", "-sf", "--max-time", "5", "http://127.0.0.1:47097/readyz"], { stdio: "ignore" });
      checks.push({ name: "shared OpenShell gateway", ok: r.status === 0 });
    }
    if (service === "rustfs") checks.push({ name: "shared RustFS", ok: await probe("http://127.0.0.1:47490/health/ready").catch(() => false) });
  }
  for (const name of Object.keys(s.definition.services)) {
    const p = s.processes[name];
    checks.push({ name: `${name} process`, ok: !!alive(p) });
    checks.push({ name: `${name} port ${s.ports[name]}`, ok: portOwner(s.ports[name], p) });
    const health = interpolate(s.definition.services[name].health, environment(s));
    if (health) checks.push({ name: `${name} health`, ok: await probe(health).catch(() => false) });
  }
  if (s.ports.internal) checks.push({ name: `celld internal port ${s.ports.internal}`, ok: portOwner(s.ports.internal, s.processes.celld) });
  // curl uses the host CA store; Node callers can use ~/.portless/ca.pem with NODE_EXTRA_CA_CERTS.
  const front = spawnSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", s.urls.front], { encoding: "utf8" });
  checks.push({ name: "front serves hosted web client", ok: front.status === 0 && front.stdout === readFileSync(join(RUN, "app/web/index.html"), "utf8") });
  checks.push({ name: "admin sign-in", ok: await login(s).then(() => true, () => false) });
  return { ok: checks.every((c) => c.ok), url: s.urls.front, checks };
}
function print(value, text) { console.log(json ? JSON.stringify(value) : text); }
export function stackIdentity(branch, worktree) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "worktree";
  return { id: `${slug}-${createHash("sha256").update(worktree).digest("hex").slice(0, 8)}`, alias: `${slug}.baskule` };
}

async function up() {
  const proxy = process.env.BASKULE_STACK_PROXY !== "0";
  if (proxy && process.getuid() !== 0) throw new Error("Non-root stacks require BASKULE_STACK_PROXY=0 (direct loopback HTTP).");
  const portless = spawnSync("portless", ["--version"], { encoding: "utf8", env: portlessEnvironment() });
  if (proxy && portless.error) throw new Error("portless is missing. With scripts/env.sh sourced, run pnpm add -g portless, then scripts/stack up.");
  const requested = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : null;
  const old = existsSync(STATE) ? state() : null;
  const selected = requested || old?.profile || "full";
  const definition = profile(selected);
  const settings = overrides();
  if (old && Object.values(old.processes).length && Object.values(old.processes).every(alive) && !args.includes("--clean")) {
    if (selected !== old.profile || Object.keys(settings).length) throw new Error("Stack already running with its saved configuration. Run scripts/stack down, then up with the new profile/overrides.");
    const result = await doctor(old);
    if (!result.ok) throw new Error(`Running stack is unhealthy: ${result.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}. Inspect logs or run down and up.`);
    old.phase = "running"; persist(old);
    print(old, old.urls.front); return;
  }
  if (old) await down(old, args.includes("--clean"));
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const branch = run("git", ["branch", "--show-current"]) || ROOT.split("/").pop();
  const { id, alias } = stackIdentity(branch, ROOT);
  const ports = {};
  const names = [...Object.keys(definition.services), ...(definition.mode === "rustfs" ? ["internal"] : [])];
  for (const name of names) { do { ports[name] = await freePort(); } while (Object.entries(ports).some(([k, p]) => k !== name && p === ports[name])); }
  const s = { id, worktree: ROOT, branch, profile: selected, definition, overrides: settings, ports,
    alias, aliasRegistered: false, urls: { front: proxy ? `https://${alias}.localhost` : `http://127.0.0.1:${ports.celld}`, loopback: `http://127.0.0.1:${ports.celld}` },
    admin: old && !args.includes("--clean") ? old.admin : { email: `admin@${id}.test`, password: randomBytes(24).toString("base64url") },
    authSecret: old?.authSecret || randomBytes(32).toString("hex"), computerdToken: old?.computerdToken || randomBytes(24).toString("hex"),
    bucketPrefix: old && !args.includes("--clean") ? old.bucketPrefix : `${id}/${randomBytes(8).toString("hex")}`,
    volumes: old && !args.includes("--clean") ? old.volumes || [] : [],
    processes: {}, logs: Object.fromEntries(Object.keys(definition.services).map((n) => [n, join(RUN, `${n}.log`)])),
    phase: "starting", launcher: identity(process.pid), startedAt: new Date().toISOString() };
  const release = await lock("stack-registry");
  try {
    await prune();
    const stacks = registry();
    if (stacks.some((r) => (r.id === id || r.alias === alias) && r.worktree !== ROOT)) throw new Error(`Instance or alias ${alias} belongs to another worktree. Use a distinct branch slug.`);
    const max = Number(process.env.BASKULE_MAX_STACKS || 6);
    if (!Number.isInteger(max) || max < 1) throw new Error("BASKULE_MAX_STACKS must be a positive integer.");
    if (stacks.length >= max) throw new Error(`Stack capacity ${stacks.length}/${max} reached (BASKULE_MAX_STACKS). Run scripts/stack down in one of:\n${stacks.map((r) => `  ${r.id}: ${r.worktree}`).join("\n")}`);
    persist(s);
  } finally { release(); }
  try {
    await sharedServices(s);
    await build(s);
    for (const name of Object.keys(definition.services)) await startService(s, name);
    if (ports["fake-llm"] || environment(s).LLM_BASE_URL) await seed(s);
    if (proxy) {
      run("portless", ["alias", s.alias, String(ports.celld)], { stdio: ["ignore", 2, 2] });
      s.aliasRegistered = true;
    }
    s.phase = "running"; persist(s);
    const result = await doctor(s);
    if (!result.ok) throw new Error(`Doctor failed: ${result.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
    print(s, s.urls.front);
  } catch (error) {
    for (const name of Object.keys(s.processes).reverse()) await stopService(s, name);
    removeAlias(s);
    rmSync(join(REGISTRY, `${s.id}.json`), { force: true });
    s.phase = "failed"; save(STATE, s);
    throw error;
  }
}

async function pruneCache() {
  const removed = [];
  for (const name of existsSync(CACHE) ? readdirSync(CACHE) : []) {
    const match = /^hosted-web-([a-f0-9]{64})(?:\.(\d+))?$/.exec(name);
    if (!match) continue;
    const path = join(CACHE, name);
    if (Date.now() - statSync(path).mtimeMs < 7 * 86400_000) continue;
    const unlock = await lock(`stack-web-${match[1]}`);
    try {
      if (existsSync(path) && Date.now() - statSync(path).mtimeMs >= 7 * 86400_000 && (!match[2] || !identity(Number(match[2])))) { rmSync(path, { recursive: true }); removed.push(name); }
    } finally { unlock(); }
  }
  return removed;
}

async function changeRunning(s, change) {
  if (s.phase !== "running" || !Object.keys(s.definition.services).every((name) => alive(s.processes[name]))) throw new Error("No running stack. Run scripts/stack up.");
  s.phase = "starting"; s.launcher = identity(process.pid); persist(s);
  try { await change(); }
  finally {
    s.phase = Object.keys(s.definition.services).every((name) => alive(s.processes[name])) ? "running" : "failed";
    persist(s);
  }
  if (s.phase !== "running") throw new Error("Stack operation left services down. Inspect logs, then run scripts/stack up.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let release;
  try {
    const allowed = new Set(["--json", "--clean", "--purge", "--profile", "--set"]);
    for (let i = 0; i < args.length; i++) {
      if (["--profile", "--set"].includes(args[i])) { if (!args[++i]) throw new Error("Option needs a value."); }
      else if (args[i].startsWith("-") && !allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}. Run scripts/stack help.`);
    }
    if (["up", "down", "reload", "restart"].includes(command)) release = await lock(`stack-worktree-${createHash("sha256").update(ROOT).digest("hex").slice(0, 16)}`);
    switch (command) {
      case "up": await up(); break;
      case "url": { const s = state(); print({ url: s.urls.front }, s.urls.front); break; }
      case "status": {
        if (!existsSync(STATE)) { print({ phase: "absent", worktree: ROOT }, "No stack. Run scripts/stack up."); break; }
        const s = state(); const services = Object.fromEntries(Object.entries(s.processes).map(([n, p]) => [n, { ...p, alive: alive(p) }]));
        print({ ...s, processes: services }, `${s.phase}: ${s.urls.front}\n${Object.entries(services).map(([n, p]) => `${n}: ${p.alive ? "up" : "down"} (pid ${p.pid}, port ${s.ports[n]})`).join("\n")}`); break;
      }
      case "doctor": { const result = await doctor(state()); print(result, result.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n")); if (!result.ok) process.exitCode = 1; break; }
      case "logs": {
        const s = state(), name = args.find((a) => !a.startsWith("--"));
        if (!s.logs[name]) throw new Error(`Choose a service: ${Object.keys(s.logs).join(", ")}`);
        const log = existsSync(s.logs[name]) ? readFileSync(s.logs[name], "utf8") : "";
        print({ service: name, path: s.logs[name], log }, log); break;
      }
      case "reload": { const s = state(); await changeRunning(s, async () => { await build(s); await stopService(s, "celld"); await startService(s, "celld"); }); print(s, s.urls.front); break; }
      case "restart": {
        const s = state(), name = args.find((a) => !a.startsWith("--"));
        if (!s.definition.services[name]) throw new Error(`Choose a service: ${Object.keys(s.definition.services).join(", ")}`);
        await changeRunning(s, async () => { await stopService(s, name); await startService(s, name); }); print(s, `${name} restarted`); break;
      }
      case "down": { if (existsSync(STATE)) await down(state(), args.includes("--purge")); print({ phase: "stopped" }, "Stack stopped (shared services kept)."); break; }
      case "gc": { const unlock = await lock("stack-registry"); try { const removed = await prune(); const builds = await pruneCache(); print({ removed, builds }, `Removed ${removed.length} dead stack(s): ${removed.join(", ")}; ${builds.length} old build(s)`); } finally { unlock(); } break; }
      case "help": case "--help": console.log("scripts/stack up [--profile full|light|rustfs] [--clean] [--set K=V]\nscripts/stack doctor | url | status | logs <service> | reload | restart <service> | down [--purge] | gc\nAdd --json for machine-readable state. Profiles: stack/profiles/<name>.json"); break;
      default: throw new Error(`Unknown command ${command}. Run scripts/stack help.`);
    }
  } catch (error) {
    if (json) console.log(JSON.stringify({ error: error.message })); else console.error(`stack: ${error.message}`);
    process.exitCode = 1;
  } finally { release?.(); }

}
