import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";

import * as DoSql from "./doSqlClient.ts";
import { makeFakeDoStorage } from "./testing/fakeDoStorage.ts";

const withClient = <A, E>(
  f: (
    sql: SqlClient.SqlClient,
    storage: ReturnType<typeof makeFakeDoStorage>,
  ) => Effect.Effect<A, E, never>,
) => {
  const storage = makeFakeDoStorage();
  return Effect.flatMap(DoSql.make(storage), ({ client }) => f(client, storage));
};

const keys = (sql: SqlClient.SqlClient) =>
  sql<{ k: string }>`SELECT k FROM t ORDER BY rowid`.pipe(
    Effect.map((rows) => rows.map((r) => r.k).join(",")),
  );

describe("DoSqlClient", () => {
  it.live("cancellation before native entry skips the body and holds isolation until settlement", () =>
    Effect.gen(function* () {
      const storage = makeFakeDoStorage();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { client: sql } = yield* DoSql.make({
        sql: storage.sql,
        async transaction<T>(body: () => Promise<T>) {
          entered.resolve();
          await release.promise;
          return storage.transaction(body);
        },
      });
      yield* sql`CREATE TABLE t (k TEXT)`;
      let bodyCalls = 0;
      const transaction = yield* Effect.forkChild(sql.withTransaction(
        Effect.sync(() => { bodyCalls++; }).pipe(Effect.andThen(sql`INSERT INTO t VALUES ('cancelled')`)),
      ));
      yield* Effect.promise(() => entered.promise);
      yield* Effect.gen(function* () {
        const cancelled = yield* Effect.forkChild(Fiber.interrupt(transaction), { startImmediately: true });
        const other = yield* Effect.forkChild(sql`INSERT INTO t VALUES ('preserved')`);
        yield* Effect.yieldNow;
        expect(storage.db.prepare("SELECT k FROM t").all()).toEqual([]);
        release.resolve();
        yield* Fiber.join(cancelled);
        yield* Fiber.join(other);
        expect(bodyCalls).toBe(0);
        expect(yield* keys(sql)).toBe("preserved");
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
    }),
  );

  it.live("two embedded consumers share transaction isolation across rollback", () =>
    withClient((shared) =>
      Effect.gen(function* () {
        const t3 = shared;
        const openCode = shared;
        yield* shared`CREATE TABLE t (k TEXT)`;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const transaction = yield* Effect.forkChild(
          t3
            .withTransaction(
              Effect.gen(function* () {
                yield* t3`INSERT INTO t VALUES ('rolled-back')`;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* Effect.fail("rollback");
              }),
            )
            .pipe(Effect.ignore),
        );
        yield* Deferred.await(entered);
        const other = yield* Effect.forkChild(openCode`INSERT INTO t VALUES ('preserved')`);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(transaction);
        yield* Fiber.join(other);
        expect(yield* keys(shared)).toBe("preserved");
      }),
    ),
  );

  it.live("commits a transaction and rolls one back", () =>
    withClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE t (k TEXT)`;
        yield* sql.withTransaction(
          Effect.andThen(sql`INSERT INTO t VALUES ('a')`, Effect.sleep(1)),
        );
        const failed = yield* sql
          .withTransaction(
            sql`INSERT INTO t VALUES ('b')`.pipe(Effect.andThen(Effect.fail("boom" as const))),
          )
          .pipe(Effect.flip);
        expect(failed).toBe("boom");
        expect(yield* keys(sql)).toBe("a");
      }),
    ),
  );

  it.effect("nested transactions behave like savepoints", () =>
    withClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE t (k TEXT)`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO t VALUES ('a')`;
            yield* sql
              .withTransaction(
                sql`INSERT INTO t VALUES ('x')`.pipe(Effect.andThen(Effect.fail("inner"))),
              )
              .pipe(Effect.ignore);
            yield* sql`INSERT INTO t VALUES ('b')`;
          }),
        );
        expect(yield* keys(sql)).toBe("a,b");
        // An outer failure discards the committed inner savepoint too.
        yield* sql
          .withTransaction(
            sql
              .withTransaction(sql`INSERT INTO t VALUES ('c')`)
              .pipe(Effect.andThen(Effect.fail("outer"))),
          )
          .pipe(Effect.ignore);
        expect(yield* keys(sql)).toBe("a,b");
      }),
    ),
  );

  it.live("statements from other fibers wait for an open transaction", () =>
    withClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE t (k TEXT)`;
        const tx = yield* Effect.forkChild(
          sql.withTransaction(
            sql`INSERT INTO t VALUES ('in')`.pipe(
              Effect.andThen(Effect.sleep(20)),
              Effect.andThen(Effect.fail("rollback")),
            ),
          ),
        );
        yield* Effect.sleep(5);
        // Without the permit this insert would land inside the transaction and be rolled back.
        yield* sql`INSERT INTO t VALUES ('out')`;
        yield* Fiber.await(tx);
        expect(yield* keys(sql)).toBe("out");
      }),
    ),
  );

  it.effect("inlines parameters beyond the 100-parameter limit", () =>
    withClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE t (k TEXT)`;
        const values = Array.from({ length: 150 }, (_, i) => ({ k: `v'${i}?` }));
        yield* sql`INSERT INTO t ${sql.insert(values)}`;
        const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM t WHERE k LIKE 'v''%?'`;
        expect(rows[0]!.n).toBe(150);
      }),
    ),
  );

  it.effect("regroups compound selects beyond 5 terms", () =>
    withClient((sql) =>
      Effect.gen(function* () {
        const query =
          Array.from({ length: 12 }, (_, i) => `SELECT ${i} AS x`).join(" UNION ALL ") +
          " ORDER BY x DESC LIMIT 3";
        const rows = yield* sql.unsafe<{ x: number }>(query);
        expect(rows.map((r) => r.x)).toEqual([11, 10, 9]);
        const nested = yield* sql.unsafe<{ n: number }>(
          `SELECT count(*) AS n FROM (${Array.from({ length: 7 }, (_, i) => `SELECT ${i % 3} AS x`).join(" UNION ")})`,
        );
        expect(nested[0]!.n).toBe(3);
      }),
    ),
  );

  it.effect("answers tuning and size pragmas without touching DO SQLite", () =>
    withClient((sql) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA busy_timeout = 5000;`;
        yield* sql`PRAGMA journal_mode = WAL;`;
        yield* sql`PRAGMA foreign_keys = ON;`;
        const pages = yield* sql<{ page_size: number }>`PRAGMA page_size`;
        expect(pages[0]!.page_size).toBe(4096);
        yield* sql`VACUUM`;
        const refused = yield* sql`BEGIN EXCLUSIVE`.pipe(Effect.flip);
        expect(String(refused.message)).toMatch(/withTransaction/);
      }),
    ),
  );

  it.effect("keeps recursive CTE terms at the top of their CTE", () =>
    withClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE n (id INTEGER, parent INTEGER)`;
        yield* sql`INSERT INTO n VALUES (1, NULL), (2, 1), (3, 2), (10, NULL)`;
        const seeds = Array.from({ length: 7 }, (_, i) => `SELECT ${i === 0 ? 3 : 100 + i}`).join(
          " UNION ",
        );
        const rows = yield* sql.unsafe<{ id: number }>(
          `WITH RECURSIVE kept(id) AS (${seeds} UNION SELECT n.parent FROM n INNER JOIN kept ON n.id = kept.id WHERE n.parent IS NOT NULL) SELECT id FROM kept WHERE id < 100 ORDER BY id`,
        );
        expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
      }),
    ),
  );

  it("regroups only same-operator unions", () => {
    const mixed =
      "SELECT 1 UNION SELECT 2 UNION ALL SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6";
    expect(DoSql.regroupCompoundSelects(mixed)).toBe(mixed);
    expect(DoSql.inlineParameters("SELECT ?, '?', ? -- ?\n", [1, "a'b"])).toBe(
      "SELECT 1, '?', 'a''b' -- ?\n",
    );
  });
});
