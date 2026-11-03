import assert from "node:assert/strict";
import { Client } from "./client.ts";
const c = new Client(process.env.COMPUTERD_URL!, process.env.COMPUTERD_TOKEN!);
const rows = [];
for (let i = 0; i < 5; i++) {
  const space = "bench" + i;
  const path = "/v1/spaces/" + space;
  const timed = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return Math.round(performance.now() - t); };
  const exec = async () => { assert.equal((await c.exec(space, { argv: ["true"] })).code, 0); };
  const ensure = async () => { await c.json("POST", path + "/computer/ensure", {}); await exec(); };
  try {
    const cold = await timed(ensure);
    const cdp = await timed(() => c.json("GET", path + "/cdp/json/version"));
    const stop = await timed(() => c.json("POST", path + "/computer/stop"));
    const hot = await timed(ensure);
    const warm = [];
    for (let j = 0; j < 20; j++) warm.push(await timed(exec));
    warm.sort((a,b) => a-b);
    const del = await timed(() => c.json("POST", path + "/computer/delete", { confirm: space }));
    rows.push({ run: i+1, cold, hot, warmP50: warm[9], warmP95: warm[18], cdp, stop, delete: del });
    console.log(JSON.stringify(rows.at(-1)));
  } finally { await c.json("POST", path + "/computer/delete", { confirm: space }); }
}
