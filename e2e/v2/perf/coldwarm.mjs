// Cold/warm timings of the live 0.2 stack (deploy/v2), driven by e2e/v2/perf/run.sh (which holds the stack lock).
//   node e2e/v2/perf/coldwarm.mjs <label> [runs]
// Each run: restart both celld nodes ("cold": fresh isolates, every cell evicted), then
//   - firstRequestMs:   GET /api/baskule/me without a session (401): the Worker's isolate start,
//   - coldSignInMs:     a fresh browser signs in through the UI → the composer is usable (spaces booted),
//   - warmSignInMs:     another fresh browser context does the same right after (isolates and cells resident),
// the memory of each node right after the cold sign-in (celld /state: V8 heap of the isolate holding the cells and
// of the stateless Worker isolate, cell count, cgroup working set), and from the celld logs since the restart: the
// slowest isolate start (`cell_isolate_startup_timing`) and each space's T3 boot (`space.booted` bootMs). The bundle's
// own evaluation cannot be timed inside the cell (time does not advance during synchronous code in workerd/celld);
// it is part of coldSignInMs.
// Person: PERF_EMAIL/PERF_PASSWORD, else alice of PERF_WORLD (default e2e/v2/artifacts/world.json).
// Results: e2e/v2/perf/results/<label>.jsonl (one line per run) and a median summary on stdout.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const HERE = import.meta.dirname;
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:47090";
const label = process.argv[2] ?? "run";
const runs = Number(process.argv[3] ?? 3);
const world = JSON.parse(readFileSync(process.env.PERF_WORLD ?? path.join(HERE, "../artifacts/world.json"), "utf8"));
const who = { email: process.env.PERF_EMAIL ?? world.alice.email, password: process.env.PERF_PASSWORD ?? world.alice.password };
const NODES = ["baskule02-celld-a", "baskule02-celld-b"];
const sh = (cmd, args, timeout = 300_000) => execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitHealthy = async (name) => {
  for (let i = 0; i < 180; i++) {
    if (sh("docker", ["inspect", "-f", "{{.State.Health.Status}}", name]).trim() === "healthy") return;
    await sleep(1000); // no-fixed-sleep-allow: Poll container health with a bounded retry count.
  }
  throw new Error(`${name} not healthy`);
};

const logsSince = (since) => NODES.flatMap((n) => sh("sh", ["-c", `docker logs --since ${since} ${n} 2>&1`]).split("\n"));

const parseLogs = (lines) => {
  const ts = (l) => Date.parse(l.slice(0, 27));
  const isolate = lines.filter((l) => l.includes("cell_isolate_startup_timing")).map((l) => ({ at: ts(l), us: Number(/total_us=(\d+)/.exec(l)?.[1] ?? 0), scope: /scope=(\w+):/.exec(l)?.[1] }));
  const booted = lines.filter((l) => l.includes('"event":"space.booted"')).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
  const firstIsolateMs = isolate.length ? Math.round(Math.max(...isolate.map((i) => i.us)) / 1000) : null;
  const spaces = booted.map((b) => ({ bootMs: b.bootMs }));
  return { firstIsolateMs, spaces };
};

const memory = () =>
  NODES.map((n) => {
    const st = JSON.parse(sh("docker", ["exec", n, "curl", "-s", "127.0.0.1:47092/state"]));
    const iso = st.deployment?.isolates ?? {};
    const mb = (b) => Math.round((b ?? 0) / 2 ** 20);
    return {
      node: n.slice(-1),
      cells: iso.cells?.baskule?.cells ?? 0,
      cellsHeapMiB: mb(iso.cells?.baskule?.heap_bytes),
      workerHeapMiB: mb(iso.stateless?.heap_bytes),
      workingSetMiB: mb(st.cgroup_working_set_bytes),
    };
  });

const signIn = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").waitFor({ timeout: 120_000 });
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator('[contenteditable="true"]').first().waitFor({ state: "visible", timeout: 120_000 });
  const ms = Date.now() - t0;
  await context.close();
  return ms;
};

const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
mkdirSync(path.join(HERE, "results"), { recursive: true });
const out = path.join(HERE, "results", `${label}.jsonl`);
const version = JSON.parse(sh("curl", ["-s", `${BASE}/version.json`]));
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/usr/bin/google-chrome", headless: true });
const rows = [];
for (let run = 0; run < runs; run++) {
  const since = new Date().toISOString();
  sh("docker", ["restart", ...NODES]);
  for (const n of NODES) await waitHealthy(n);
  const t = Date.now();
  const first = await fetch(`${BASE}/api/baskule/me`);
  await first.text();
  const firstRequestMs = Date.now() - t;
  const coldSignInMs = await signIn(browser);
  await sleep(2000); // no-fixed-sleep-allow: Sample memory two seconds after sign-in for comparable perf runs.
  const mem = memory();
  const { firstIsolateMs, spaces } = parseLogs(logsSince(since));
  const warmSignInMs = await signIn(browser);
  const row = { label, run, at: since, fork: version.fork, spaceBundle: version.spaceBundle, firstRequestMs, coldSignInMs, warmSignInMs, firstIsolateMs, spaces, mem, load: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ") };
  rows.push(row);
  appendFileSync(out, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
  await sleep(15_000); // no-fixed-sleep-allow: Pace perf samples below the front sign-in rate limit.
}
await browser.close();
const summary = {
  label, runs: rows.length, fork: version.fork,
  firstRequestMs: median(rows.map((r) => r.firstRequestMs)),
  firstIsolateMs: median(rows.map((r) => r.firstIsolateMs)),
  spaceBootMs: median(rows.flatMap((r) => r.spaces.map((s) => s.bootMs))),
  // The slowest space boot of each run: the first boot in a fresh isolate (cold code), the one sign-in waits for.
  coldestSpaceBootMs: median(rows.map((r) => Math.max(0, ...r.spaces.map((s) => s.bootMs)))),
  coldSignInMs: median(rows.map((r) => r.coldSignInMs)),
  // Node holding the most cells after the cold sign-in: V8 heap of its cell isolate, of its Worker isolate.
  cellsHeapMiB: median(rows.map((r) => Math.max(...r.mem.map((m) => m.cellsHeapMiB)))),
  workerHeapMiB: median(rows.map((r) => Math.max(...r.mem.map((m) => m.workerHeapMiB)))),
  warmSignInMs: median(rows.map((r) => r.warmSignInMs)),
};
console.log("median " + JSON.stringify(summary));
