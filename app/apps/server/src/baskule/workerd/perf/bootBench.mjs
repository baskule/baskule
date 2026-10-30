// baskule: compare cold bundle boots in fresh Node processes, without celld or a live stack.
// node src/baskule/workerd/perf/bootBench.mjs [--runs 5] [--profile <dir>] <bundle.js>...
// Each bundle gets a prepared database; reports import, cold/warm createSpaceServer and medians.
// --profile writes CPU profiles; use the umbrella e2e/v2/perf harness for actual celld costs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const runs = Number(flag("--runs", "5"));
const profileDir = flag("--profile", undefined);
const bundles = args.map((b) => NodePath.resolve(b));
if (process.env.BASKULE_BOOT_CHILD) {
  // Child: one cold boot of BASKULE_BOOT_CHILD on the database BASKULE_BOOT_DB.
  const { createRequire } = await import("node:module");
  globalThis.require = createRequire(import.meta.url); // the bundle's require() shim (celld provides one)
  const { makeFakeDoStorage } = await import("../testing/fakeDoStorage.ts");
  const cpu = () => process.cpuUsage().user / 1000;
  const t0 = performance.now();
  const bundle = await import(process.env.BASKULE_BOOT_CHILD);
  const importMs = performance.now() - t0;
  const storage = makeFakeDoStorage(process.env.BASKULE_BOOT_DB);
  const agentFetch = async () => new Response("{}", { status: 404 });
  const config = { spaceId: "bench", storage, agentFetch, logLevel: "Error" };
  let session;
  if (process.env.BASKULE_BOOT_PROFILE) {
    const { Session } = await import("node:inspector/promises");
    session = new Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
  }
  const c1 = cpu();
  const t1 = performance.now();
  const server = await bundle.createSpaceServer(config);
  const bootMs = performance.now() - t1;
  const bootCpuMs = cpu() - c1;
  if (session) {
    const { profile } = await session.post("Profiler.stop");
    NodeFS.writeFileSync(process.env.BASKULE_BOOT_PROFILE, JSON.stringify(profile));
  }
  await server.dispose();
  const t2 = performance.now();
  await (await bundle.createSpaceServer(config)).dispose();
  const secondMs = performance.now() - t2;
  console.log(JSON.stringify({ importMs, bootMs, bootCpuMs, secondMs }));
  process.exit(0);
}

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baskule-bootbench-"));
const child = (bundle, db, extra = {}) => {
  const r = NodeChildProcess.spawnSync(process.execPath, [import.meta.filename], {
    env: { ...process.env, BASKULE_BOOT_CHILD: bundle, BASKULE_BOOT_DB: db, ...extra },
    encoding: "utf8",
  });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  if (r.status !== 0 || !line.startsWith("{"))
    throw new Error(`boot failed (${bundle}):\n${r.stderr.slice(-2000)}`);
  return JSON.parse(line);
};
const dbs = bundles.map((bundle, i) => {
  const db = NodePath.join(work, `space-${i}.db`);
  child(bundle, db); // first boot: migrations, managed settings
  return db;
});
const results = bundles.map(() => []);
for (let run = 0; run < runs; run++) {
  // Interleaved, so host load affects every bundle alike.
  bundles.forEach((bundle, i) => results[i].push(child(bundle, dbs[i])));
}
if (profileDir) {
  NodeFS.mkdirSync(profileDir, { recursive: true });
  bundles.forEach((bundle, i) =>
    child(bundle, dbs[i], {
      BASKULE_BOOT_PROFILE: NodePath.join(profileDir, `boot-${i}.cpuprofile`),
    }),
  );
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
bundles.forEach((bundle, i) => {
  const m = (k) => Math.round(median(results[i].map((r) => r[k])));
  console.log(
    `${bundle}: import ${m("importMs")} ms, cold boot ${m("bootMs")} ms (cpu ${m("bootCpuMs")} ms), warm boot ${m("secondMs")} ms (median of ${runs})`,
  );
});
