import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { createBaskule080 } from "../persistence/fixtures/baskule080.ts";
import { setupInjected } from "./BaskulePersistence.ts";

describe("hosted migration fast path", () => {
  it.effect(
    "upgrades frozen 080 through 081, skips current history, and rejects a missing V2 entry",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* createBaskule080;
        expect(
          (yield* sql<{ sql: string }>`
          SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_message_search_update'
        `)[0]?.sql,
        ).toContain("AFTER UPDATE OF payload_json, streaming, role ON");
        yield* setupInjected(runMigrations());
        expect(
          (yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 81`)[0]?.name,
        ).toBe("ProjectionMessageSearchText");
        yield* setupInjected(Effect.die("current history must skip the migrator"));
        expect((yield* sql`PRAGMA foreign_keys`)[0]?.foreign_keys).toBe(1);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 55`;
        expect(Exit.isFailure(yield* Effect.exit(setupInjected(runMigrations())))).toBe(true);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
