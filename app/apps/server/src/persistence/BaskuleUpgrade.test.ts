import { createUpstream076, upstream076History } from "./fixtures/upstream076.ts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { baskule076History, createBaskule076 } from "./fixtures/baskule076.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    migration_id: number;
    name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  return rows.map(({ migration_id, name }) => [migration_id, name] as const);
});

it.effect(
  "upgrades the actual Baskule 076 history without losing auth, authorship, or schedules",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createBaskule076;
      assert.deepStrictEqual(yield* history, baskule076History);
      assert.isFalse(baskule076History.some(([id]) => [65, 70, 71, 72].includes(id)));
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES ('session-kept', 'person-kept', '["orchestration:read"]', 'baskule', '2026-11-01', '2027-11-01')`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread-kept', 'project-kept', 'Keep this chat', 'opencode', 'full-access', 'default', '2026-11-01', '2026-11-01',
        '{"settledOverride":true,"author":{"id":"person-kept","name":"Person"},"title":"Keep this chat"}')`;
      for (const threadId of ["thread-kept", null]) {
        yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json,
          runtime_mode, interaction_mode, author_json, created_by, creation_source, created_at, updated_at, last_run_status, run_count)
        VALUES (${threadId === null ? "new" : "bound"}, 'Keep schedule', 'Keep prompt', 0, '{}', 'project-kept', ${threadId}, '{}', '{}',
          'full-access', 'default', '{"id":"person-kept","name":"Person"}', 'user', 'web', '2026-11-01', '2026-11-01', 'never', 0)`;
      }
      const authBefore = yield* sql`SELECT * FROM auth_sessions`;
      const schedulesBefore =
        yield* sql`SELECT task_id, prompt, author_json FROM scheduled_tasks ORDER BY task_id`;
      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        [77, 78, 79, 80],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* sql`SELECT * FROM auth_sessions`, authBefore);
      assert.deepStrictEqual(
        yield* sql`SELECT task_id, prompt, author_json FROM scheduled_tasks ORDER BY task_id`,
        schedulesBefore,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT task_id, thread_mode FROM scheduled_tasks ORDER BY task_id`,
        [
          { task_id: "bound", thread_mode: "continue" },
          { task_id: "new", thread_mode: "new_thread" },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(payload_json, '$.settledOverride') AS settled,
      json_extract(payload_json, '$.author.id') AS author, title FROM orchestration_v2_projection_threads`,
        [{ settled: "settled", author: "person-kept", title: "Keep this chat" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'peer_environment_%'`,
        [],
      );
    }).pipe(Effect.provide(database)),
);

it.effect("refuses missing and conflicting supported history without changing it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createBaskule076;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 75`;
    const before = yield* history;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* history, before);
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (75, 'ConflictingLayout')`;
    const conflicting = yield* history;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* history, conflicting);
  }).pipe(Effect.provide(database)),
);

it.effect("creates a fresh Baskule database and starts repeatedly without retired layouts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'peer_environment_%'`,
      [],
    );
    assert.deepStrictEqual(yield* history, migrationManifest);
  }).pipe(Effect.provide(database)),
);

it.effect("preserves genuine upstream history and runs only the supported forward migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createUpstream076;
    assert.deepStrictEqual(yield* history, upstream076History);
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES ('upstream-session', 'person', '[]', 'local', '2026-11-01', '2027-11-01')`;
    const auth = yield* sql`SELECT * FROM auth_sessions`;
    const retiredTables =
      yield* sql`SELECT name, sql FROM sqlite_master WHERE name LIKE 'peer_environment_%' ORDER BY name`;
    assert.isAbove(retiredTables.length, 0);
    assert.deepStrictEqual(
      (yield* runMigrations()).map(([id]) => id),
      [77, 78, 79, 80],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* history, [
      ...upstream076History,
      ...migrationManifest.filter(([id]) => id > 76),
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM auth_sessions`, auth);
    assert.deepStrictEqual(
      yield* sql`SELECT name, sql FROM sqlite_master WHERE name LIKE 'peer_environment_%' ORDER BY name`,
      retiredTables,
    );
  }).pipe(Effect.provide(database)),
);
