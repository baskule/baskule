// baskule: a host (the workerd SpaceCell) supplies its own SqlClient, here DO SQLite.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export class InjectedSqlClient extends Context.Reference<
  Layer.Layer<SqlClient.SqlClient> | undefined
>("baskule/persistence/InjectedSqlClient", { defaultValue: () => undefined }) {}

/**
 * Setup for an injected database: DO SQLite refuses the WAL/tuning pragmas and has no planner
 * statistics to clear, so only foreign keys and the migrations remain.
 */
export const setupInjected = (
  runMigrations: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations;
  });
