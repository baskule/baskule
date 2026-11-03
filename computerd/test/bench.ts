import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Client } from "./client.ts";

const { COMPUTERD_URL, COMPUTERD_TOKEN, BENCH_OUT } = process.env;
assert(COMPUTERD_URL && COMPUTERD_TOKEN, "COMPUTERD_URL and COMPUTERD_TOKEN required");
const runs = Number(process.env.BENCH_RUNS ?? 5);
assert(Number.isInteger(runs) && runs > 0, "BENCH_RUNS must be a positive integer");
const client = new Client(COMPUTERD_URL, COMPUTERD_TOKEN);
const samples: { space: string; ms: Record<string, number[]>; checks: string[] }[] = [];
let failure: string | undefined;
try {
  for (let run = 0; run < runs; run++) {
    const space = `bench-${randomUUID()}`;
    const base = `/v1/spaces/${space}`;
    const sample = { space, ms: {} as Record<string, number[]>, checks: [] as string[] };
    samples.push(sample);
    const request = (path: string, body: unknown = {}) => client.json("POST", base + path, body);
    const exec = async (argv: string[]) => {
      const result = await client.exec(space, { argv, timeoutMs: 30000 });
      assert.equal(result.err, null, result.err ?? "exec transport");
      assert.equal(result.code, 0, result.stderr);
      return result.stdout;
    };
    const timed = async (name: string, operation: () => Promise<unknown>) => {
      const start = performance.now();
      await operation();
      (sample.ms[name] ??= []).push(performance.now() - start);
    };
    const pass = (name: string) => { sample.checks.push(name); console.error(`PASS ${space}: ${name}`); };
    try {
      await timed("coldEnsure", () => request("/computer/ensure", { keep: true }));
      await timed("coldFirstExec", () => exec(["true"]));
      for (let i = 0; i < 20; i++) await timed("warmExec", () => exec(["true"]));
      await timed("stdin8MiB", async () => {
        const result = await client.exec(space, { argv: ["wc", "-c"], stdin: Buffer.alloc(8 * 1024 * 1024, 120).toString("base64"), timeoutMs: 30000 });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.err, null);
        assert.equal(result.stdout.trim(), "8388608");
      });
      await exec(["sh", "-c", "printf persisted > /sandbox/space/home/bench-marker"]);
      await timed("stop", () => request("/computer/stop"));
      await timed("hotEnsure", () => request("/computer/ensure", { keep: true }));
      await timed("hotFirstExec", () => exec(["true"]));
      assert.equal(await exec(["cat", "/sandbox/space/home/bench-marker"]), "persisted");
      pass("home persists across stop/start");
      for (const name of ["browserFirst", "browserSecond"]) {
        await timed(name, async () => {
          const version = await client.json("GET", `${base}/cdp/json/version`);
          assert.equal(typeof version.webSocketDebuggerUrl, "string", "browser discovery has a WebSocket endpoint");
        });
      }
      const id = randomUUID();
      const sleeping = client.exec(space, { id, argv: ["sh", "-c", "echo $$ > /tmp/bench-pid; exec sleep 1000"], timeoutMs: 30000 });
      const deadline = performance.now() + 10000;
      let pid = "";
      while (!pid && performance.now() < deadline) pid = (await exec(["sh", "-c", "cat /tmp/bench-pid 2>/dev/null || true"])).trim();
      assert.match(pid, /^\d+$/, "sleep publishes its PID before kill");
      const killed = await request("/kill", { id, signal: "KILL" });
      assert.equal(killed.killed, true, "kill acknowledges running exec");
      const result = await sleeping;
      assert.equal(result.err, null);
      assert.notEqual(result.code, null);
      assert.notEqual(result.code, 0);
      await exec(["sh", "-c", `! kill -0 ${pid} 2>/dev/null`]);
      pass("kill terminates sleep and removes process");
      await timed("delete", () => request("/computer/delete", { confirm: space }));
      await request("/computer/ensure", { keep: true });
      assert.equal(await exec(["sh", "-c", "find /sandbox/space/home -mindepth 1 -maxdepth 1 -print"]), "", "deleted home is empty on recreation");
      pass("delete removes home data");
    } finally {
      await request("/computer/delete", { confirm: space });
    }
  }
} catch (error) {
  failure = String(error);
  console.error(`FAIL ${failure}`);
  process.exitCode = 1;
}
const metrics = [...new Set(samples.flatMap(sample => Object.keys(sample.ms)))];
const summary = Object.fromEntries(metrics.map(name => {
  const values = samples.flatMap(sample => sample.ms[name] ?? []).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return [name, { n: values.length, median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, p95: values[Math.ceil(values.length * 0.95) - 1] }];
}));
const json = JSON.stringify({ at: new Date().toISOString(), node: process.version, runs, unit: "ms", percentile: "nearest-rank", samples, summary, failure }, null, 2) + "\n";
if (BENCH_OUT) await writeFile(BENCH_OUT, json);
process.stdout.write(json);
