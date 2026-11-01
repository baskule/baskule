#!/usr/bin/env node
// One entry point for Baskule's feedback loops: pick the smallest loop that proves a change.
// Usage and the loop inventory: docs/development-workflow.md. `scripts/check help` prints the summary.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { features, touchedFeatures } from "./feature-map.mjs";
import { acquireHostLock } from "./check-lock.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Test workers have their own IPC channel; inherited launcher metadata describes the parent app.
const checkEnv = { ...process.env };
delete checkEnv.T3_SERVICE_LAUNCHER_CONTEXT;
delete checkEnv.T3_BOOT_SERVICE_UNIT;
const env = { ...checkEnv, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", T3CODE_TELEMETRY_ENABLED: "false", CI: "1" };

const HELP = `scripts/check [target ...] [options]

Tiers
  feature:<name>    feature journeys and declared extra checks
  journey[:filter]  worktree Playwright journeys, by filename or grep
  fast (default)    changed files (vs the merge-base with main, plus uncommitted/untracked) → their Baskule
                    unit tests and scoped typechecks; docs → link check; shell → syntax. Seconds to ~1 min. No services.
  unit              every Baskule unit suite and typecheck (no services, ~2-3 min)
  release           unit + every component loop + desktop; fresh, fake LLM only, no deployed stack
  upstream          T3's own unit suites in the fork (server ~2 200 tests, web): before a public release only
  plan              print what fast runs and which component loop(s) the diff needs next (runs nothing)
  acceptance        wide local verification: unit + every component loop, in two parallel lanes (~10 min);
                    --live adds the full live suite incl. @slow (release candidates, when the owner asks)

Component loops (local, no live stack; wait for a host lock, then check ports)
  worker    Worker + ControlCell on celld dev, stub SpaceCell: auth, sessions, origin, routing, revocation   ~30 s
  space     merged SpaceCell + embedded OpenCode, fake computerd + fake LLM: files, webhook,
            schedule alarm, restart persistence, isolation                                                  ~1.5 min
  agent     embedded agent runtime through the SpaceCell, real computerd + shared OpenShell gateway           ~2 min
  features  real platform app (wpf) + real computers: queue/steer, inbox, snooze, questions, delegation,
            webhook schedules, MCP app                                                                      ~6 min
  computerd computerd against the shared OpenShell gateway: exec, kill, files, CDP, idle, delete         ~40 s
  web       hosted web client: unit tests, (build), mock stack page checks + screenshots                    ~1.5-3.5 min
  <loop>:<checks>   only some checks of worker, space, agent or features, e.g. worker:transcriptions

Live end-to-end: the owner's deployed stack (deploy). Only when the owner asks, or for a seam that exists only
there (edge, two-node fleet, deploy config, computer image). Takes the stack lock, swaps in the fake LLM, tests the
DEPLOYED build (BUILD=1 deploys first)
  e2e                      every non-@slow scenario (parallel phase)
  e2e:<tag>[,<tag>...]     one area, e.g. e2e:chat, e2e:security,files, e2e:lifecycle (tags: auth security chat
                           team files browser computer admin ui phone lifecycle slow real perf)
  infra                    deployed infrastructure smoke: fleet probes, computerd suite inside the stack network,
                           computer network isolation probes, edge failover (e2e/infra-smoke.sh --no-up, ~2-4 min)

Areas (the component loops that own an area; --live also runs its live e2e tags)
  auth security chat team files browser computer agent schedules admin ui lifecycle

Options
  --base <ref>   diff base for fast/plan (default: merge-base with main)
  --live         areas and acceptance: also run the live e2e selection
  --keep-gateway leave the shared OpenShell gateway running for the next loop
  --fresh        run every step even when a pass for the same inputs is on record (see "Evidence" below)
  --dry-run      print the steps without running them

Evidence: a step that passed is not run again while its inputs are unchanged. Its key is the committed tree of
its input directories (Markdown excluded, except the feature map) and scripts/; a pass is recorded as the ref refs/evidence/<id>/<key> on
origin, so passes on the CI runner count locally and the other way round. Inputs with uncommitted changes are
always run and never recorded. Inputs changed during a run are not recorded either.
`;

// ---- areas ------------------------------------------------------------------------------------------------------
const AREAS = {
  auth: { loops: ["worker"], tags: ["auth"] },
  security: { loops: ["worker"], tags: ["security"] },
  chat: { loops: [], features: ["personal-chat", "conversation-controls"], tags: ["chat"] },
  team: { loops: [], features: ["team-chat"], tags: ["team"] },
  files: { loops: ["computerd", "space"], tags: ["files"] },
  browser: { loops: ["computerd"], tags: ["browser"] },
  computer: { loops: ["computerd", "agent"], tags: ["computer"] },
  agent: { loops: ["agent"], tags: [] },
  schedules: { loops: ["space:schedules", "features:3-schedules"], tags: [] },
  admin: { loops: ["worker"], tags: ["admin"] },
  ui: { loops: ["web"], tags: ["ui", "phone"] },
  lifecycle: { loops: ["space:lifecycle", "agent:lifecycle"], tags: ["lifecycle"] },
};

// ---- component loops --------------------------------------------------------------------------------------------
const LOOPS = {
  worker: { ports: [47620], run: (only) => [["bash", ["test/integration.sh", ...(only ? ["--only", only] : [])], "platform"]] },
  space: { ports: [47550, 47551, 47552], run: (only) => [["node", ["src/space/test/run.mjs", ...(only ? ["--only", only] : [])], "platform"]] },
  agent: { ports: [47650, 47651, 47652], gateway: true, run: (only) => [["src/agent/test/run.sh", ["--keep", ...(only ? ["--", "--only", only] : [])], "platform"]] },
  features: {
    ports: [], isolated: true,
    run: (only) => [
      ["scripts/stack", ["up", "--profile", "full", "--clean"], "."],
      ["node", ["test/wpf/run.mjs", ...(only ? ["--only", only] : [])], "platform", { env: process.env.BASKULE_STACK_PROXY === "0" ? {} : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || join(process.env.PORTLESS_STATE_DIR || join(homedir(), ".portless"), "ca.pem") }, always: ["bash", ["-c", 'mkdir -p .run/check/feature-stack; for log in .run/stack/*.log; do [ ! -f "$log" ] || cp "$log" .run/check/feature-stack/; done; scripts/stack down --purge'], "."] }],
    ],
  },
  computerd: { ports: [47502], gateway: true, run: () => [["test/integration.sh", [], "computerd", { env: { KEEP_DEV: "1" } }]] },
  web: {
    ports: [47700, 47702, 47703],
    run: () => {
      const dist = join(ROOT, "app/apps/web/dist/index.html");
      const fresh = existsSync(dist) && !newerThan(join(ROOT, "app/apps/web/src"), statSync(dist).mtimeMs);
      return [["baskule-dev/check.sh", [], "app/apps/web", { env: fresh ? { SKIP_BUILD: "1" } : {} }]];
    },
  },
};
const LOOP_ONLY = {
  "space:schedules": ["space", "webhook,schedule-fires-via-alarm"],
  "space:lifecycle": ["space", "persistence-across-restart,status-without-boot"],
  "agent:lifecycle": ["agent", "plain-chat-no-computer,persistence-across-celld-restart,restart-mid-chat-keeps-toolset,heartbeat-and-idle-dispose"],
  "features:3-schedules": ["features", "3-schedules"],
};

function newerThan(dir, ms) {
  const r = spawnSync("find", [dir, "-newermt", `@${Math.floor(ms / 1000)}`, "-type", "f", "-print", "-quit"], { encoding: "utf8" });
  return r.stdout.trim() !== "";
}

// ---- change-based selection -------------------------------------------------------------------------------------
function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}
function changedFiles(base) {
  const files = new Set();
  for (const out of [git(["diff", "--name-only", `${base}...HEAD`]), git(["diff", "--name-only", "HEAD"]), git(["ls-files", "--others", "--exclude-standard"])])
    for (const f of out.split("\n").filter(Boolean)) files.add(f);
  return [...files].sort();
}

// The Baskule code inside the T3 fork, and how its tests are selected (vitest filters).
const BASKULE_TESTS = {
  "app/apps/server": ["src/baskule"],
  "app/apps/web": ["--project", "unit", "src/baskule"],
  "app/apps/mobile": ["--project", "unit", "--project", "react"],
  "app/packages/client-runtime": [],
};

/** Maps changed paths to fast steps, suggested component loops and e2e tags. */
function plan(files, base) {
  const steps = [];
  const loops = new Set();
  const tags = new Set();
  // Documentation never selects code checks; it gets the link check only.
  const code = files.filter((f) => !/\.md$/.test(f));
  const has = (re) => code.some((f) => re.test(f));
  const pick = (re) => code.filter((f) => re.test(f));
  const add = (label, cmd, args, cwd, opts = {}) => steps.push({ label, cmd, args, cwd, ...opts });

  if (has(/^platform\/(src|test|dev|scripts)\/|^platform\/[^/]+\.(ts|json)$|^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/)) {
    add("platform: unit tests related to the change", "pnpm", ["exec", "vitest", "run", "--changed", base, "--passWithNoTests"], "platform", { evidence: ev(PLATFORM_IN, ["platform-unit"]) });
    add("platform: typecheck", "pnpm", ["exec", "tsc", "--noEmit", "-p", "."], "platform", { evidence: ev(PLATFORM_IN, ["platform-tsc"], "platform-tsc") });
  }
  if (has(/^platform\/src\/(control|shared)\/|^platform\/src\/worker\.ts$/)) { loops.add("worker"); tags.add("auth").add("security"); }
  if (has(/^platform\/test\/integration/)) loops.add("worker");
  if (has(/^platform\/src\/space\//)) { loops.add("space"); tags.add("chat"); }
  if (has(/^platform\/src\/space\/(index|alarms)\.ts$/)) tags.add("lifecycle");
  if (has(/^platform\/src\/agent\//)) { loops.add("agent"); tags.add("chat").add("computer"); }
  if (has(/^platform\/src\/agent\/index\.ts$/)) tags.add("lifecycle");
  if (has(/^platform\/test\/wpf\/|^scripts\/stack(?:[.-]|$)|^stack\//)) loops.add("features");
  if (has(/^computerd\/|^(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/)) {
    add("computerd: unit tests (fake gateway)", "pnpm", ["test"], "computerd", { evidence: ev(COMPUTERD_IN, ["computerd-unit"], "computerd-unit") });
    add("computerd: typecheck", "pnpm", ["exec", "tsc", "--noEmit"], "computerd", { evidence: ev(COMPUTERD_IN, ["computerd-tsc"], "computerd-tsc") });
    if (has(/^computerd\/src\//)) { loops.add("computerd"); tags.add("files").add("browser").add("computer"); }
  }
  if (has(/^(computer|openshell)\//)) { loops.add("computerd"); tags.add("computer").add("browser"); }
  if (has(/^desktop\/|^app\/apps\/desktop\//)) {
    add("desktop: connection and shell regression tests", "bash", ["desktop/check.sh"], ".", { evidence: ev(["app", "desktop"], ["desktop"], "desktop") });
  }
  if (has(/^deploy\/runner\//)) add("deployment: privilege boundary", "python3", ["-B", "-m", "unittest", "discover", "-s", "deploy/runner"], ".");
  if (has(/^e2e\/|^(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/)) add("e2e: typecheck (live run: the changed specs)", join(ROOT, "e2e/node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], "e2e", { evidence: ev(E2E_IN, ["e2e-tsc"], "e2e-tsc") });
  for (const spec of pick(/^e2e\/tests\/.*\.spec\.ts$/).filter((f) => existsSync(join(ROOT, f)))) tags.add(`file:${spec.replace(/^e2e\//, "")}`);
  // T3 fork: per package, the related unit tests; web and server get their typecheck (server: changed files only,
  // because its baseline carries Effect language-service diagnostics).
  const pkgs = new Set(pick(/^app\/(apps|packages)\/[^/]+\//).map((f) => f.split("/").slice(0, 3).join("/")));
  for (const pkg of pkgs) {
    if (!existsSync(join(ROOT, pkg, "package.json"))) continue;
    const pj = JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8"));
    // Baskule-owned tests only: on a wide fork diff, "related" pulls in T3's whole upstream suite (2 174 server
    // tests, ~30 min on nas). Upstream suites run in `scripts/check upstream`, before a public release.
    const short = pkg.split("/").pop();
    if (pj.scripts?.test && BASKULE_TESTS[pkg]) add(`${pkg}: Baskule unit tests related to the change`, join(ROOT, "app/node_modules/.bin/vp"), ["test", "run", "--changed", base, "--passWithNoTests", ...BASKULE_TESTS[pkg]], pkg, { evidence: ev(["app"], [`${short}-baskule`]) });
    if (pkg === "app/apps/web") add("app/apps/web: typecheck", join(ROOT, "app/node_modules/.bin/tsc"), ["--noEmit"], pkg, { evidence: ev(["app"], ["web-tsc"], "web-tsc") });
    if (pkg === "app/apps/mobile" || pkg === "app/packages/client-runtime") add(`${pkg}: typecheck`, join(ROOT, "app/node_modules/.bin/tsc"), ["--noEmit"], pkg, { evidence: ev(["app"], [`${short}-tsc`], `${short}-tsc`) });
    if (pkg === "app/apps/server") steps.push({ label: "app/apps/server: typecheck (diagnostics in changed files)", fn: () => serverTypecheck(pick(/^app\/apps\/server\/src\//)) });
  }
  steps.unshift({ label: "feature map: coverage", cmd: "node", args: ["scripts/feature-map.mjs"], cwd: "." });
  steps.unshift({ label: "Baskule: blocking lint and no-fixed-sleep", cmd: "node", args: ["scripts/lint.mjs"], cwd: "." });
  if (has(/^app\/apps\/web\//)) { loops.add("web"); tags.add("ui"); }
  if (has(/^app\/apps\/server\/src\/baskule\//)) { loops.add("space"); tags.add("chat").add("files"); }
  const shells = pick(/\.sh$/).filter((f) => existsSync(join(ROOT, f)) && !f.startsWith("vendor/") && !f.startsWith("app/"));
  if (shells.length) add("shell scripts: syntax", "bash", ["-c", shells.map((f) => `bash -n '${f}'`).join(" && ")], ".");
  const mjs = pick(/\.mjs$/).filter((f) => existsSync(join(ROOT, f)) && !f.startsWith("vendor/") && !f.startsWith("app/") && !f.startsWith("platform/"));
  if (mjs.length) add("scripts: syntax", "bash", ["-c", mjs.map((f) => `node --check '${f}'`).join(" && ")], ".");
  if (has(/^scripts\/worktree(?:[.-]|$)/)) add("worktree: setup regression tests", "node", ["--test", "scripts/worktree.test.mjs"], ".");
  if (has(/^scripts\/(?:check(?:[.-]|$)|stack(?:[.-]|$)|celld(?:[.-]|$)|lint(?:[.-]|$)|feature-map(?:[.-]|$)|run-feature\.mjs$|no-fixed-sleep\.mjs$)|^platform\/dev\/fake-llm\/|^\.oxlintrc\.json$/)) add("scripts/check: harness tests", "node", ["--test", "scripts/check-lock.test.mjs", "scripts/check-evidence.test.mjs", "scripts/celld.test.mjs", "scripts/lint.test.mjs", "scripts/stack.test.mjs", "scripts/feature-map.test.mjs", "platform/dev/fake-llm/server.test.mjs"], ".");
  if (has(/^openshell\/dev-down\.sh$/)) add("stack: shared gateway teardown", "node", ["--test", "scripts/stack.test.mjs"], ".");
  if (has(/^deploy\/docker-compose\.yml$/)) add("deploy: compose config", "docker", ["compose", "-f", "deploy/docker-compose.yml", "--project-directory", "deploy", "config", "-q"], ".");
  if (has(/^deploy\/(celld|docker-compose)/)) tags.add("lifecycle");
  if (has(/^(deploy|openshell|computer)\//)) tags.add("infra");
  const docs = files.filter((f) => /\.md$/.test(f)).filter((f) => existsSync(join(ROOT, f)) && !f.startsWith("vendor/") && !f.startsWith("app/"));
  if (docs.length) steps.push({ label: `docs: relative links in ${docs.length} changed file(s)`, fn: () => checkLinks(docs) });
  return { steps, loops: [...loops], tags: [...tags] };
}

/** What a diff needs after fast: its component loop(s); the live stack only for what exists nowhere else. */
function nextHint(p) {
  const lines = [];
  if (p.loops.length) lines.push(`next, if the change crosses a boundary: scripts/check ${p.loops.join(" ")}`);
  const f = p.tags.filter((x) => x.startsWith("file:")).map((x) => x.slice(5));
  if (f.length > 3) lines.push(`${f.length} specs changed: the live suite in the next release acceptance (scripts/check acceptance --live)`);
  else if (f.length) lines.push(`changed specs, alone, against the deployed build: e2e/run.sh ${f.join(" ")}`);
  if (p.tags.includes("infra")) lines.push("deploy-only seam: after the owner agrees to a deploy, scripts/check infra");
  const t = p.tags.filter((x) => !x.startsWith("file:") && x !== "infra");
  if (t.length) lines.push(`live coverage of this area (only when the owner asks): scripts/check e2e:${t.join(",")}`);
  return lines.join("\n");
}

function serverTypecheck(files) {
  const r = spawnSync(join(ROOT, "app/node_modules/.bin/tsc"), ["--noEmit"], { cwd: join(ROOT, "app/apps/server"), env, encoding: "utf8", maxBuffer: 256 << 20 });
  const rel = new Set(files.map((f) => f.replace(/^app\/apps\/server\//, "")));
  const lines = (r.stdout + r.stderr).split("\n").filter((l) => /error TS\d+/.test(l) && rel.has(l.split("(")[0]));
  const hard = lines.filter((l) => !/error TS377\d{3}/.test(l));
  for (const l of lines) console.log(`  ${l}`);
  console.log(`  ${hard.length} type error(s), ${lines.length - hard.length} Effect advisory diagnostic(s) in the changed files`);
  return hard.length === 0;
}

function checkLinks(docs) {
  let bad = 0;
  for (const f of docs) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(ROOT, dirname(f), decodeURIComponent(target)))) { console.log(`  ${f}: broken link ${target}`); bad++; }
    }
  }
  console.log(`  ${bad} broken relative link(s)`);
  return bad === 0;
}

// ---- evidence: a pass is not re-run while its inputs are unchanged ---------------------------------------------------
const WORKSPACE_IN = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
const COMPUTERD_IN = ["computerd", ...WORKSPACE_IN];
const E2E_IN = ["e2e", ...WORKSPACE_IN];
const PLATFORM_IN = ["platform", "app", ...WORKSPACE_IN]; // platform bundles T3's SpaceCell code from the fork
const COMPUTER_IN = [...COMPUTERD_IN, "computer", "openshell", "vendor/openshell"];
const LOOP_INPUTS = { worker: PLATFORM_IN, space: PLATFORM_IN, agent: [...PLATFORM_IN, ...COMPUTER_IN], features: [...PLATFORM_IN, ...COMPUTER_IN, "stack"], computerd: COMPUTER_IN, web: ["app"] };
/** inputs: directories; check: ids whose pass covers this step; record: the id a pass of this step proves. */
function ev(inputs, check, record = null) { return { inputs, check, record }; }
let FRESH = false;
const treeKeys = new Map();
/** The committed tree of the inputs (Markdown excluded) plus scripts/, or null when an input has uncommitted changes. */
function inputsKey(inputs) {
  const dirs = [...inputs, "scripts"];
  const k = dirs.join(" ");
  if (!treeKeys.has(k)) {
    const dirty = git(["status", "--porcelain", "--", ...dirs]) !== "";
    const tree = spawnSync("git", ["ls-tree", "-r", "HEAD", "--", ...dirs], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? "";
    treeKeys.set(k, dirty ? null : createHash("sha256").update(tree.split("\n").filter((l) => l && (!l.endsWith(".md") || l.includes(".agents/skills/verify-baskule/"))).join("\n")).digest("hex").slice(0, 20));
  }
  return treeKeys.get(k);
}
let evidenceRefs = null;
const recorded = [];
const recordEvidence = process.env.BASKULE_CHECK_RECORD !== "0";
function onRecord(ref) {
  if (!recordEvidence) return false;
  if (evidenceRefs === null) {
    const r = spawnSync("git", ["ls-remote", "origin", "refs/evidence/*"], { cwd: ROOT, encoding: "utf8", timeout: 20000 });
    evidenceRefs = new Set((r.status === 0 ? r.stdout : "").split("\n").map((l) => l.split("\t")[1]).filter(Boolean));
  }
  return evidenceRefs.has(ref);
}
/** The evidence ref that already covers this step, if any. */
function priorPass(e) {
  if (!e || !recordEvidence) return null;
  treeKeys.delete([...e.inputs, "scripts"].join(" "));
  const key = inputsKey(e.inputs);
  if (FRESH || !key) return null;
  return e.check.map((id) => `refs/evidence/${id}/${key}`).find(onRecord) ?? null;
}
function record(e) {
  if (!recordEvidence) return;
  const key = e?.record && inputsKey(e.inputs);
  if (!key) return;
  treeKeys.delete([...e.inputs, "scripts"].join(" "));
  if (inputsKey(e.inputs) !== key) {
    console.log("note: inputs changed during this check; pass not recorded");
    return;
  }
  const ref = `refs/evidence/${e.record}/${key}`;
  if (!onRecord(ref)) { evidenceRefs.add(ref); recorded.push({ ref, commit: git(["rev-parse", "HEAD"]) }); }
}
function reuse(label, e) {
  const ref = priorPass(e);
  if (!ref) return false;
  console.log(`\n\x1b[1m▶ ${label}\x1b[0m: passed before for the same inputs (${ref}); not run (--fresh runs it)`);
  results.push({ label, ok: true, ms: 0, kept: true });
  return true;
}
// Forced: another run may have recorded the same key from another commit meanwhile; either pass is the evidence.
function pushEvidence() {
  if (!recordEvidence || !recorded.length || DRY) return;
  const r = spawnSync("git", ["push", "-q", "--no-verify", "origin", ...recorded.map(({ ref, commit }) => `+${commit}:${ref}`)], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  console.log(r.status === 0 ? `\nrecorded ${recorded.length} pass(es) on origin (refs/evidence/)` : `\nnote: could not record the passes on origin: ${(r.stderr || "").trim().split("\n").pop()}`);
  if (r.status === 0) recorded.length = 0;
}

// ---- running ------------------------------------------------------------------------------------------------------
const results = [];
let DRY = false;
function run(step) {
  if (reuse(step.label, step.evidence)) return;
  const t0 = Date.now();
  console.log(`\n\x1b[1m▶ ${step.label}\x1b[0m${step.cmd ? `   (${step.cwd}: ${[step.cmd.replace(ROOT + "/", ""), ...step.args].join(" ")})` : ""}`);
  if (DRY) return results.push({ label: step.label, ok: true, ms: 0, dry: true });
  let ok;
  if (step.fn) ok = step.fn();
  else {
    const r = spawnSync(step.cmd, step.args, { cwd: join(ROOT, step.cwd), env: { ...env, ...(step.env ?? {}) }, stdio: "inherit" });
    ok = r.status === 0;
  }
  if (step.always) { const [c, a, cwd] = step.always; if (spawnSync(c, a, { cwd: join(ROOT, cwd), env, stdio: "inherit" }).status !== 0) ok = false; }
  results.push({ label: step.label, ok, ms: Date.now() - t0 });
  if (ok) record(step.evidence);
}

function portBusy(port) {
  return new Promise((res) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("error", () => res(false));
  });
}

let gatewayUsed = false;
const gatewayWasUp = () => spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", "osdev-openshell"], { encoding: "utf8" }).stdout.trim() === "true";
let gatewayInitiallyUp = null;
let releaseGatewayLock = null;

async function runLoop(spec, exec = async (step) => run(step), checks = null) {
  const [name, only] = LOOP_ONLY[spec] ?? [spec, checks];
  const loop = LOOPS[name];
  if (!loop) throw new Error(`unknown loop ${spec}`);
  const id = only ? `loop-${name}-${createHash("sha256").update(only).digest("hex").slice(0, 8)}` : `loop-${name}`;
  const e = ev(LOOP_INPUTS[name], only ? [`loop-${name}`, id] : [id], id);
  if (reuse(only ? `${name}:${only}` : spec, e)) return;
  let releaseLock;
  if (!DRY && !loop.isolated) {
    try {
      if (loop.gateway) releaseGatewayLock ??= await acquireHostLock("gateway");
      else releaseLock = await acquireHostLock(name);
    } catch (error) {
      console.error(error.message);
      return results.push({ label: `${spec} (host lock failed)`, ok: false, ms: 0 });
    }
  }
  try {
    const busy = [];
    for (const p of loop.ports) if (await portBusy(p)) busy.push(p);
    if (busy.length && !DRY) {
      console.log(`\n\x1b[1m▶ ${spec}\x1b[0m: ports ${busy.join(", ")} are in use (another loop or agent?). Stop it first; not run.`);
      return results.push({ label: `${spec} (ports busy)`, ok: false, ms: 0 });
    }
    if (loop.gateway) { gatewayUsed = true; if (gatewayInitiallyUp === null) gatewayInitiallyUp = gatewayWasUp(); }
    const before = results.length;
    for (const [cmd, args, cwd, opts = {}] of loop.run(only)) await exec({ label: `${spec}: ${[cmd, ...args].join(" ")}`, cmd, args, cwd, ...opts });
    if (!DRY && results.length > before && results.slice(before).every((r) => r.ok)) record(e);
  } finally {
    releaseLock?.();
  }
}

/** Runs one step in the background, its output in a log file; on failure prints the log's tail. */
function runLogged(step, logPath) {
  return new Promise((done) => {
    const t0 = Date.now();
    console.log(`▶ ${step.label}   (log: ${relative(ROOT, logPath)})`);
    if (DRY) { results.push({ label: step.label, ok: true, ms: 0, dry: true }); return done(); }
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`\n▶ ${step.label}\n`);
    const c = spawn(step.cmd, step.args, { cwd: join(ROOT, step.cwd), env: { ...env, ...(step.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.pipe(log, { end: false });
    c.stderr.pipe(log, { end: false });
    c.on("close", (code) => {
      let cleanupOk = true;
      if (step.always) { const [a, b, cwd] = step.always; cleanupOk = spawnSync(a, b, { cwd: join(ROOT, cwd), env, stdio: "ignore" }).status === 0; }
      log.end(() => {
        const ok = code === 0 && cleanupOk;
        results.push({ label: step.label, ok, ms: Date.now() - t0 });
        console.log(`${ok ? "✓" : "✗"} ${step.label} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        if (!ok) console.log(readFileSync(logPath, "utf8").split("\n").slice(-40).map((l) => `    ${l}`).join("\n"));
        done();
      });
    });
  });
}

/** Component loops in parallel lanes: each lane runs its loops in order (their ports never overlap). */
async function runLanes(lanes) {
  const dir = join(ROOT, ".run/check");
  mkdirSync(dir, { recursive: true });
  await Promise.all(lanes.map(async (lane) => {
    for (const spec of lane) await runLoop(spec, (step) => runLogged(step, join(dir, `${spec}.log`)));
  }));
}

function runE2e(tags, { slow = true } = {}) {
  const files = tags.filter((t) => t.startsWith("file:")).map((t) => t.slice(5));
  const real = tags.filter((t) => !t.startsWith("file:"));
  const args = [...files];
  if (real.length) args.push("--grep", real.map((t) => `@${t.replace(/^@/, "")}`).join("|"));
  run({ label: `live e2e ${real.length ? real.map((t) => "@" + t).join(" ") : files.length ? files.join(" ") : "(all)"}`, cmd: "e2e/run.sh", args, cwd: ".", env: slow ? {} : { E2E_SLOW: "0" } });
}

function warnStaleDeploy() {
  const r = spawnSync("curl", ["-s", "-m", "5", `${process.env.E2E_BASE_URL ?? "http://127.0.0.1:47090"}/version.json`], { encoding: "utf8" });
  let v; try { v = JSON.parse(r.stdout); } catch { return; }
  const sha = String(v.umbrella ?? "").replace(/-dirty$/, "");
  if (!sha || !git(["cat-file", "-t", sha])) { console.log(`note: the stack runs umbrella ${v.umbrella}, not in this history; e2e tests that build (BUILD=1) or not is your call.`); return; }
  const src = git(["diff", "--name-only", sha, "--", "platform/src", "computerd/src", "computer", "openshell", "deploy", "app/apps", "app/packages"]).split("\n").filter((f) => f && !/(\/test\/|\.test\.)/.test(f));
  if (src.length) console.log(`note: ${src.length} product file(s) changed since the deployed build ${v.umbrella}; the live suite tests the deployed build. Deploy first (BUILD=1 or deploy/build.sh) if those changes are under test.`);
}

/** Every unit suite and typecheck, no services. */
function unitSteps() {
  const vp = join(ROOT, "app/node_modules/.bin/vp");
  return [
    { label: "scripts/check: harness tests", cmd: "node", args: ["--test", "scripts/check-lock.test.mjs", "scripts/check-evidence.test.mjs", "scripts/celld.test.mjs", "scripts/lint.test.mjs", "scripts/stack.test.mjs", "scripts/worktree.test.mjs", "scripts/feature-map.test.mjs", "platform/dev/fake-llm/server.test.mjs"], cwd: "." },
    ...plan(["platform/src/x.ts", "computerd/src/x.ts", "desktop/x", "e2e/x.ts", "deploy/runner/x.py"], "HEAD").steps
      .map((s) => (s.label.startsWith("platform: unit") ? { ...s, label: "platform: all unit tests", args: ["exec", "vitest", "run"], evidence: ev(PLATFORM_IN, ["platform-unit"], "platform-unit") } : s)),
    { label: "app/apps/server: Baskule unit tests", cmd: vp, args: ["test", "run", ...BASKULE_TESTS["app/apps/server"]], cwd: "app/apps/server", evidence: ev(["app"], ["server-baskule"], "server-baskule") },
    { label: "app/apps/web: Baskule unit tests", cmd: vp, args: ["test", "run", ...BASKULE_TESTS["app/apps/web"]], cwd: "app/apps/web", evidence: ev(["app"], ["web-baskule"], "web-baskule") },
    { label: "app/apps/web: typecheck", cmd: join(ROOT, "app/node_modules/.bin/tsc"), args: ["--noEmit"], cwd: "app/apps/web", evidence: ev(["app"], ["web-tsc"], "web-tsc") },
    ...["app/apps/mobile", "app/packages/client-runtime"].flatMap((pkg) => {
      const short = pkg.split("/").pop();
      return [
        { label: `${pkg}: unit tests`, cmd: vp, args: ["test", "run", ...BASKULE_TESTS[pkg]], cwd: pkg, evidence: ev(["app"], [`${short}-baskule`], `${short}-baskule`) },
        { label: `${pkg}: typecheck`, cmd: join(ROOT, "app/node_modules/.bin/tsc"), args: ["--noEmit"], cwd: pkg, evidence: ev(["app"], [`${short}-tsc`], `${short}-tsc`) },
      ];
    }),
  ];
}

/** T3's own suites (the fork's upstream code): not Baskule's feedback loop; before a public release only. */
function upstreamSteps() {
  const vp = join(ROOT, "app/node_modules/.bin/vp");
  return [
    { label: "app/apps/server: every unit test (upstream T3 included)", cmd: vp, args: ["test", "run"], cwd: "app/apps/server", evidence: ev(["app"], ["upstream-server"], "upstream-server") },
    { label: "app/apps/web: every unit test (upstream T3 included)", cmd: vp, args: ["test", "run", "--project", "unit"], cwd: "app/apps/web", evidence: ev(["app"], ["upstream-web"], "upstream-web") },
  ];
}

function runFeature(name) {
  // Custom checks may nest this CLI: share completed evidence and hand off its gateway lock first.
  pushEvidence();
  releaseGatewayLock?.();
  releaseGatewayLock = null;
  const target = `feature:${name}`;
  const feature = features().find((f) => f.name === name);
  if (!feature) throw new Error(`Unknown feature ${target}`);
  const evidence = ev(["platform", "app", "computerd", "computer", "openshell", "vendor/openshell", "desktop", "deploy", "stack", "e2e", ".agents/skills/verify-baskule", ...WORKSPACE_IN], [target.replace(":", "-")], target.replace(":", "-"));
  run({ label: target, cmd: "node", args: ["scripts/run-feature.mjs", feature.name, ...(live ? ["--live"] : [])], cwd: ".", evidence });
}

// ---- main -------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
const baseArg = opt("--base");
const live = flag("--live"), keepGateway = flag("--keep-gateway");
DRY = flag("--dry-run");
FRESH = flag("--fresh");
if (argv.includes("release")) {
  FRESH = true;
  if (live) { console.error("release never targets the live stack; remove --live"); process.exit(2); }
}
const targets = argv.length ? argv : ["fast"];
if (targets.includes("help") || targets.includes("--help") || targets.includes("-h")) { console.log(HELP); process.exit(0); }
const base = baseArg ?? (git(["merge-base", "HEAD", "main"]) || "HEAD");
const t0 = Date.now();

for (const target of targets) {
  if (target === "fast" || target === "plan") {
    const files = changedFiles(base);
    const p = plan(files, base);
    console.log(`${files.length} changed file(s) vs ${base.slice(0, 10)}${files.length ? ":\n  " + files.slice(0, 40).join("\n  ") + (files.length > 40 ? "\n  …" : "") : ""}`);
    if (target === "plan") {
      console.log(`\nfast steps:\n${p.steps.map((s) => `  - ${s.label}`).join("\n") || "  (none)"}`);
      console.log(`features: ${touchedFeatures(files).map((f) => `feature:${f.name}`).join(" ") || "(none)"}`);
      console.log(nextHint(p) || "nothing beyond fast");
      continue;
    }
    if (!p.steps.length) console.log("nothing to check for these changes");
    for (const s of p.steps) run(s);
    if (p.loops.length || p.tags.length) console.log(`\n${nextHint(p)}`);
  } else if (target.startsWith("feature:")) {
    runFeature(target.slice(8));
  } else if (target === "journey" || target.startsWith("journey:")) {
    const filter = target.slice(8);
    const args = ["exec", "playwright", "test", "-c", "journeys/playwright.config.ts"];
    if (filter) {
      const files = readdirSync(join(ROOT, "e2e/journeys"), { recursive: true }).filter((f) => /\.spec\.(mjs|ts)$/.test(f));
      args.push(...(files.some((f) => f.includes(filter)) ? [filter] : ["--grep", filter]));
    }
    run({ label: target, cmd: "pnpm", args, cwd: "e2e" });
  } else if (target === "unit") {
    for (const s of unitSteps()) run(s);
  } else if (target === "upstream") {
    for (const s of upstreamSteps()) run(s);
  } else if (target === "acceptance" || target === "release") {
    const before = results.length;
    for (const s of unitSteps()) run(s);
    if (results.slice(before).some((r) => !r.ok)) { console.log("\nunit tier failed: fix it before spending the acceptance run"); break; }
    // No-Docker loops in one lane, the loops on the shared OpenShell gateway in the other.
    await runLanes([["worker", "space", "web"], ["computerd", "agent", "features"]]);
    if (target === "release") {
      if (results.slice(before).some((r) => !r.ok)) break;
      for (const feature of features()) {
        if (feature.ownerRun) continue;
        try { runFeature(feature.name); }
        finally {
          run({ label: `release stack cleanup: ${feature.name}`, cmd: "scripts/stack", args: ["down", "--purge"], cwd: "." });
        }
      }
    } else if (live) { warnStaleDeploy(); runE2e([]); }
    else console.log("\nlive suite not run (it tests the owner's deployed stack): add --live for a release candidate");
  } else if (target === "infra") {
    run({ label: "live infrastructure smoke", cmd: "e2e/infra-smoke.sh", args: ["--no-up"], cwd: "." });
  } else if (target === "e2e") {
    warnStaleDeploy();
    runE2e([], { slow: false });
  } else if (target.startsWith("e2e:")) {
    warnStaleDeploy();
    runE2e(target.slice(4).split(",").filter(Boolean));
  } else if (AREAS[target]) {
    const a = AREAS[target];
    for (const name of a.features ?? []) runFeature(name);
    for (const l of a.loops) await runLoop(l);
    if (live && a.tags.length) { warnStaleDeploy(); runE2e(a.tags); }
  } else if (LOOPS[target] || LOOP_ONLY[target]) {
    await runLoop(target);
  } else if (LOOPS[target.split(":")[0]] && target.includes(":")) {
    const [name, only] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];
    await runLoop(name, undefined, only);
  } else {
    console.error(`unknown target ${target}\n\n${HELP}`);
    process.exit(2);
  }
}

if (gatewayUsed && !keepGateway && gatewayInitiallyUp === false && !DRY) {
  releaseGatewayLock ??= await acquireHostLock("gateway");
  console.log("\nremoving the shared OpenShell gateway this run started (--keep-gateway keeps it)");
  spawnSync(join(ROOT, "openshell/dev-down.sh"), [], { stdio: "inherit" });
}
releaseGatewayLock?.();
if (results.length) {
  console.log(`\n\x1b[1msummary\x1b[0m (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  for (const r of results) console.log(`  ${r.dry ? "-   " : r.kept ? "kept" : r.ok ? "ok  " : "FAIL"}  ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.label}`);
}
pushEvidence();
process.exit(results.every((r) => r.ok) ? 0 : 1);
