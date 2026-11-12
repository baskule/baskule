// baskule: a host (the workerd SpaceCell) supplies its own SqlClient, here DO SQLite.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { migrationManifest } from "../persistence/Migrations.ts";
import * as SqlClient from "effect/sql/SqlClient";

export class InjectedSqlClient extends Context.Reference<
  Layer.Layer<SqlClient.SqlClient> | undefined
>("baskule/persistence/InjectedSqlClient", { defaultValue: () => undefined }) {}

/**
 * Setup for an injected database: DO SQLite refuses the WAL/tuning pragmas and has no planner
 * statistics to clear, so only foreign keys and the migrations remain.
 */
export const setupInjected = Effect.fn("BaskulePersistence.setupInjected")(function* <A, E>(
  runMigrations: Effect.Effect<A, E, SqlClient.SqlClient>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON;`;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (tables.length > 0) {
    const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    if (
      recorded.length === migrationManifest.length &&
      recorded.every(
        (row, index) =>
          row.migration_id === migrationManifest[index]?.[0] &&
          row.name === migrationManifest[index]?.[1],
      )
    )
      return;
  }
  yield* runMigrations;
});
