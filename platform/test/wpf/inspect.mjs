// Debug helper: node test/wpf/inspect.mjs <spaceId> [title-substring]  (as admin's view? no: as the run's Alice)
import { Person, watchShell, waitFor, projection } from "./lib.mjs";
const [spaceId, title = "", email, password] = process.argv.slice(2);
const p = await Person.signIn(email, password);
const c = await p.rpc(spaceId);
const shell = watchShell(c);
await waitFor("shell snapshot", () => shell.ready, 20_000);
for (const t of shell.threads.values()) {
  if (!t.title.includes(title)) continue;
  console.log("THREAD", t.id, t.title, t.status, JSON.stringify(t.lineage));
  const pr = await projection(c, t.id);
  for (const m of pr.messages ?? []) console.log("  ", m.role, JSON.stringify(m.text).slice(0, 160));
  for (const r of pr.runs ?? []) console.log("   run", r.status, r.id.slice(-30));
}
c.close();
process.exit(0);
