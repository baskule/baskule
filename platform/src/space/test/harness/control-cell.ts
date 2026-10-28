// Test stand-in for ControlCell's `/_baskule/check` (the 60 s socket recheck): sessions listed in
// `revoked` (set through `POST /_test/revoked`) are invalid, every other one is valid.
import { UsageService } from "../../../control/usage";
import usageSchema from "../../../control/migrations/0002_complex_moondragon.sql";
import { DurableObject } from "cloudflare:workers";
import type { SpacePlugins } from "../../../../../app/packages/contracts/src/baskule-plugins";
import { Effect, Fiber } from "effect";

export class TestControlCell extends DurableObject<{ TEST_PRODUCT_SETTINGS: string; SPACE: DurableObjectNamespace }> {
  private continuations = new Map<string, {
    phase: "starting" | "first" | "second" | "fetching" | "completed" | "failed" | "cleaning" | "interrupted";
    release?: () => void;
    releaseCleanup?: () => void;
    output?: string;
    error?: string;
    timer: ReturnType<typeof setInterval>;
    fiber?: Fiber.Fiber<void>;
  }>();
  private usage = new UsageService(this.ctx.storage, (id, path, init) => this.env.SPACE.getByName(id).fetch(new Request(`http://space${path}`, init)));
  private ready = this.ctx.blockConcurrencyWhile(async () => {
    for (const q of ["create table if not exists space(id text primary key,name text)", "create table if not exists user(id text primary key,name text,email text)", "create table if not exists kv(key text primary key,value text)",
      ...usageSchema.split("--> statement-breakpoint").map(q => q.trim().replace(/CREATE TABLE /g, "CREATE TABLE IF NOT EXISTS ").replace(/CREATE INDEX /g, "CREATE INDEX IF NOT EXISTS ")).filter(Boolean)]) this.ctx.storage.sql.exec(q).toArray();
  });
  async fetch(req: Request): Promise<Response> {
    await this.ready;
    const url = new URL(req.url);
    if (url.pathname.startsWith("/_test/continuation/")) {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing_id" }, { status: 400 });
      const operation = url.pathname.split("/").at(-1);
      if (operation === "start") {
        const entry: NonNullable<ReturnType<typeof this.continuations.get>> = {
          phase: "starting", timer: setInterval(() => {}, 1000),
        };
        this.continuations.set(id, entry);
        const program = url.searchParams.get("mode") === "cancel" ? Effect.callback<void>(resume => {
          entry.phase = "first";
          entry.release = () => resume(Effect.void);
        }).pipe(
          Effect.andThen(Effect.sync(() => { entry.output = "unexpected continuation"; })),
          Effect.ensuring(Effect.gen(function* () {
            yield* Effect.promise(() => new Promise<void>(resolve => {
              entry.phase = "cleaning";
              entry.releaseCleanup = resolve;
            }));
            entry.output = (entry.output ?? "") + "cleanup";
            entry.phase = "interrupted";
          })),
        ) : Effect.gen(function* () {
          if (url.searchParams.get("mode") === "promise") {
            yield* Effect.promise(() => new Promise<void>(resolve => { entry.phase = "first"; entry.release = resolve; }));
          } else {
            yield* Effect.callback<void>(resume => { entry.phase = "first"; entry.release = () => resume(Effect.void); });
          }
          yield* Effect.promise(() => new Promise<void>(resolve => { entry.phase = "second"; entry.release = resolve; }));
          entry.phase = "fetching";
          entry.output = yield* Effect.promise(() => fetch(`${url.origin}/_test/plain`).then(response => response.text()));
          entry.phase = "completed";
        });
        entry.fiber = Effect.runFork(program.pipe(
          Effect.catchCause(cause => Effect.sync(() => { entry.phase = "failed"; entry.error = String(cause); })),
          Effect.ensuring(Effect.sync(() => clearInterval(entry.timer))),
        ));
      }
      const entry = this.continuations.get(id);
      if (operation === "release") {
        entry?.release?.();
        if (url.searchParams.get("mode") === "cancel") entry?.fiber?.interruptUnsafe();
      }
      if (operation === "finish-cleanup") entry?.releaseCleanup?.();
      if (operation === "stop" && entry) {
        clearInterval(entry.timer);
        entry.releaseCleanup?.();
        if (entry.fiber) await Effect.runPromise(Fiber.interrupt(entry.fiber));
        this.continuations.delete(id);
      }
      return Response.json({ phase: entry?.phase, output: entry?.output, error: entry?.error });
    }
    if (url.pathname.startsWith("/_baskule/usage")) {
      const input = await req.clone().json() as { spaceId: string };
      this.ctx.storage.sql.exec("insert into space(id) values(?) on conflict do nothing", input.spaceId).toArray();
      return this.usage.privateRoute(req);
    }
    if (url.pathname === "/_test/usage") return Response.json(this.usage.me(url.searchParams.get("userId") ?? "u-alice"));
    if (url.pathname === "/_test/usage/limits") return this.usage.adminRoute(req, "/usage/limits", url);
    // This harness registers no push devices; delivery succeeds without a provider call.
    if (url.pathname === "/_baskule/push/deliver" && req.method === "POST") return Response.json({ ok: true });
    if (url.pathname === "/_test/plugins" && req.method === "POST") {
      const { spaceId, plugins } = await req.json() as { spaceId: string; plugins: SpacePlugins };
      this.ctx.storage.sql.exec("insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value", `plugins:${spaceId}`, JSON.stringify(plugins));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/_baskule/plugin-credential") return Response.json({ error: "needs_connection" });
    // This harness has no registered push devices, like an unconfigured installation.
    if (url.pathname === "/_baskule/push/deliver") return Response.json({ ok: true });
    if (url.pathname === "/_baskule/settings") {
      const { spaceId } = await req.json() as { spaceId: string };
      const saved = this.ctx.storage.sql.exec("select value from kv where key=?", `plugins:${spaceId}`).toArray()[0];
      const plugins = saved ? JSON.parse(saved.value as string) as SpacePlugins : { servers: [], skills: [] };
      return Response.json({ ...JSON.parse(this.env.TEST_PRODUCT_SETTINGS), usageLimits: this.usage.settings(), plugins });
    }
    const revoked = new Set((await this.ctx.storage.get<string[]>("revoked")) ?? []);
    if (url.pathname === "/_test/revoked" && req.method === "POST") {
      await this.ctx.storage.put("revoked", (await req.json()) as string[]);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/_baskule/check" && req.method === "POST") {
      const body = (await req.json()) as { sessions: { sessionId: string }[] };
      const checks = ((await this.ctx.storage.get<number>("checks")) ?? 0) + 1;
      await this.ctx.storage.put("checks", checks);
      return Response.json({ valid: body.sessions.map((s) => s.sessionId).filter((id) => !revoked.has(id)) });
    }
    if (url.pathname === "/_test/checks") return Response.json({ checks: (await this.ctx.storage.get<number>("checks")) ?? 0 });
    return new Response("not found", { status: 404 });
  }
}
