#!/usr/bin/env node
// WP-F feature runner: the thin-server capabilities (docs/development-workflow.md)
// end to end on the real platform app (scripts/stack: celld dev + real computers + fake LLM).
//   node test/wpf/run.mjs [--only a,b] [--list]
// Every check prints PASS/FAIL with evidence; the summary is written to test/wpf/.run/results.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminSession, log, scheduledTasks } from "./lib.mjs";
import { checks } from "./checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
if (args.includes("--list")) {
  for (const c of checks) console.log(`${c.name}\t${c.capability}`);
  process.exit(0);
}

const run = process.env.WPF_RUN ?? Date.now().toString(36);
const ctx = { run, state: {} };
const results = [];
for (const c of checks) {
  if (only && !only.has(c.name) && !only.has(c.capability)) continue;
  const t0 = Date.now();
  try {
    const detail = await c.fn(ctx);
    results.push({ name: c.name, capability: c.capability, ok: true, ms: Date.now() - t0, detail });
    log(`PASS ${c.name} (${Date.now() - t0} ms)${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name: c.name, capability: c.capability, ok: false, ms: Date.now() - t0, detail: String(e?.stack ?? e).slice(0, 3000) });
    log(`FAIL ${c.name}: ${String(e?.stack ?? e).slice(0, 2000)}`);
  }
}
// This run owns its newly created team space. Do not leave timers/runs waking old test cells.
if (ctx.state.ca) {
  try {
    const tasks = await scheduledTasks(ctx.state.ca);
    for (const task of tasks) await ctx.state.ca.ok("scheduledTasks.delete", { id: task.id });
    log(`cleanup schedules: deleted ${tasks.length}`);
  } catch (e) { log("cleanup schedules:", String(e)); }
}
for (const close of ctx.closers ?? []) try { close(); } catch {}
if (ctx.state.team) {
  try { const admin = await adminSession(); await admin.http("POST", `/api/baskule/admin/spaces/${ctx.state.team}/stop`, {}); }
  catch (e) { log("cleanup space:", String(e)); }
}
mkdirSync(join(HERE, ".run"), { recursive: true });
writeFileSync(join(HERE, ".run/results.json"), JSON.stringify({ run, at: new Date().toISOString(), results }, null, 2));
writeFileSync(join(HERE, `.run/results-${run}.json`), JSON.stringify({ run, results }, null, 2));
const passed = results.filter((r) => r.ok).length;
log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
