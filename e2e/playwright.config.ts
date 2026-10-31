import { defineConfig } from "@playwright/test";

// The stack is the real stack (deploy); run.sh holds the stack lock and exports E2E_* coordinates.
// One run id for every worker process (each worker slot derives its own fixture world from it: tests/lib.ts).
process.env.E2E_RUN ??= new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");

const workers = Number(process.env.E2E_WORKERS ?? 2);

// Projects (run.sh runs `main`, then `lifecycle`, as two phases so a lifecycle test never overlaps another test):
//   main       every independent scenario, in parallel worker slots (E2E_WORKERS, default 2), each with its own world;
//   lifecycle  @slow: idle stop, full-stack restart, node failover, same-chat restart. They stop or restart shared
//              services, so they run one at a time and after `main`;
//   perf       @perf: measurements (cold/warm timings), on request only: `run.sh --project perf`.
// Opt-in real-provider checks (@real) skip themselves unless E2E_REAL=1 / E2E_DIRECT_REAL=1.
export default defineConfig({
  testDir: "./tests",
  outputDir: "./artifacts/test-results",
  workers,
  retries: 0, // no blanket retries: only known host artifacts are retried, in the helpers (ERR_NETWORK_CHANGED)
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["json", { outputFile: process.env.E2E_RESULTS_FILE ?? "artifacts/results.json" }]],
  projects: [
    { name: "main", grepInvert: /@slow|@perf/, fullyParallel: true },
    { name: "lifecycle", grep: /@slow/, grepInvert: /@perf/, workers: 1, fullyParallel: false },
    { name: "perf", grep: /@perf/, workers: 1, fullyParallel: false },
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:47090",
    headless: true,
    launchOptions: { executablePath: process.env.E2E_CHROME ?? "/usr/bin/google-chrome" },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
