// Minimal Worker used to validate the 0.2 infrastructure without the platform bundle:
//   GET /          -> "hello from baskule02" (+ which node answered)
//   GET /count/:id -> a Durable Object (SQLite) counter, to exercise cells, the bucket and failover
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, n INTEGER)");
  }
  async fetch() {
    this.ctx.storage.sql.exec("INSERT INTO c VALUES ('n', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
    const n = this.ctx.storage.sql.exec("SELECT n FROM c WHERE k = 'n'").one().n;
    return Response.json({ n });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/count\/([a-z0-9-]{1,40})$/);
    if (m) return env.COUNTER.getByName(m[1]).fetch(req);
    if (url.pathname === "/") return new Response("hello from baskule02\n");
    return new Response("not found\n", { status: 404 });
  },
};
