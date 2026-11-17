import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createBaskule025, createBaskule081, baskule081History } from "./fixtures/baskule081.ts";
import { createBaskule080, baskule080History } from "./fixtures/baskule080.ts";
import * as DoSql from "../baskule/workerd/doSqlClient.ts";
import { makeFakeDoStorage } from "../baskule/workerd/testing/fakeDoStorage.ts";
import * as Layer from "effect/Layer";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { createUpstream076, upstream076History } from "./fixtures/upstream076.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { baskule076History, createBaskule076 } from "./fixtures/baskule076.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    migration_id: number;
    name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  return rows.map(({ migration_id, name }) => [migration_id, name] as const);
});

describe.each([
  ["Node SQLite", NodeSqliteClient.layer({ filename: ":memory:" })],
  ["hosted SQL adapter", Layer.unwrap(Effect.sync(() => DoSql.layer(makeFakeDoStorage())))],
] as const)("%s", (_name, database) => {
  it.effect(
    "upgrades frozen 081 atomically, retains authored data, and resumes after failure",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* createBaskule025;
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
          VALUES ('options-project', 'Historical options', '/workspace',
            '{"provider":"opencode","model":"opencode/big-pickle","options":{"variant":"high","thinking":true}}',
            '[]', '2026-01-01', '2026-01-01')`;
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, created_at, updated_at, runtime_mode, interaction_mode)
          VALUES ('options-thread', 'options-project', 'Historical options',
            '{"provider":"opencode","model":"opencode/big-pickle","options":{"variant":"high","thinking":true}}',
            '2026-01-01', '2026-01-01', 'full-access', 'default')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES ('options-event', 'thread', 'options-thread', 1, 'thread.meta-updated', '2026-01-01', 'user',
            '{"threadId":"options-thread","modelSelection":{"provider":"opencode","model":"opencode/big-pickle","options":{"variant":"high","thinking":true}}}', '{}')`;
        yield* createBaskule081;
        const historicalOptions = yield* sql`
          SELECT 'thread' AS source, json_type(model_selection_json, '$.options') AS type,
            json_extract(model_selection_json, '$.options') AS options FROM projection_threads
          UNION ALL
          SELECT 'project', json_type(default_model_selection_json, '$.options'),
            json_extract(default_model_selection_json, '$.options') FROM projection_projects
          UNION ALL
          SELECT 'event', json_type(payload_json, '$.modelSelection.options'),
            json_extract(payload_json, '$.modelSelection.options') FROM orchestration_events`;
        assert.deepStrictEqual(
          historicalOptions
            .filter((row) => row.type !== null)
            .map((row) => ({
              source: row.source,
              type: row.type,
              options: JSON.parse(String(row.options)),
            })),
          ["thread", "project", "event"].map((source) => ({
            source,
            type: "array",
            options: [
              { id: "variant", value: "high" },
              { id: "thinking", value: true },
            ],
          })),
        );
        assert.deepStrictEqual(yield* history, baskule081History);
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('frozen-session', 'member', '["orchestration:read"]', 'baskule', '2026-11-01', '2027-11-01')`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('frozen-thread', 'frozen-project', 'Kept title', 'opencode', 'full-access', 'default', '2026-11-01', '2026-11-01',
          '{"title":"Kept title","author":{"id":"member","name":"Member"}}')`;
        yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json,
          runtime_mode, interaction_mode, author_json, created_by, creation_source, created_at, updated_at, last_run_status, run_count)
        VALUES ('frozen-schedule', 'Kept schedule', 'Kept prompt', 0, '{}', 'frozen-project', 'frozen-thread', '{}', '{}',
          'full-access', 'default', '{"id":"member","name":"Member"}', 'user', 'web', '2026-11-01', '2026-11-01', 'never', 0)`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('frozen-message', 'frozen-thread', 'user', 0, '2026-11-01', '2026-11-01',
          '{"text":"Keep message","author":{"id":"member","name":"Member"},"attachments":[{"id":"kept-file","name":"kept.txt"}]}')`;
        const sessions = yield* sql`SELECT * FROM auth_sessions`.unprepared;
        const schedules = yield* sql`SELECT * FROM scheduled_tasks`;
        const threads =
          yield* sql`SELECT thread_id, project_id, title, payload_json FROM orchestration_v2_projection_threads`;
        const messages = yield* sql`SELECT * FROM orchestration_v2_projection_messages`;
        yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (fixture_obstruction TEXT)`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* history,
          migrationManifest.filter(([id]) => id <= 84),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_turn_item_counts_insert'`,
          [],
        );
        yield* sql`DROP TABLE orchestration_v2_projection_turn_item_counts`;
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id >= 85),
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM auth_sessions`.unprepared,
          sessions.map((row) => ({ ...row, proof_key_thumbprint: null })),
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM scheduled_tasks`, schedules);
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id, project_id, title, payload_json FROM orchestration_v2_projection_threads`,
          threads,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM orchestration_v2_projection_messages`,
          messages,
        );
        assert.deepStrictEqual(
          yield* sql`
          SELECT 'thread' AS source, json_type(model_selection_json, '$.options') AS type,
            json_extract(model_selection_json, '$.options') AS options FROM projection_threads
          UNION ALL
          SELECT 'project', json_type(default_model_selection_json, '$.options'),
            json_extract(default_model_selection_json, '$.options') FROM projection_projects
          UNION ALL
          SELECT 'event', json_type(payload_json, '$.modelSelection.options'),
            json_extract(payload_json, '$.modelSelection.options') FROM orchestration_events`,
          historicalOptions,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'peer_environment_%'`,
          [],
        );
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    `upgrades the actual Baskule 076 history without losing auth, authorship, or schedules`,
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
        const authBefore = yield* sql`SELECT * FROM auth_sessions`.unprepared;
        const schedulesBefore =
          yield* sql`SELECT task_id, prompt, author_json FROM scheduled_tasks ORDER BY task_id`;
        assert.deepStrictEqual(
          (yield* runMigrations()).map(([id]) => id),
          migrationManifest.filter(([id]) => id > 76).map(([id]) => id),
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM auth_sessions`.unprepared,
          authBefore.map((row) => ({ ...row, proof_key_thumbprint: null })),
        );
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

  it.effect(`refuses missing and conflicting supported history without changing it`, () =>
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

  it.effect(`creates a fresh Baskule database and starts repeatedly without retired layouts`, () =>
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

  it.effect(
    `preserves genuine upstream history and runs only the supported forward migrations`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* createUpstream076;
        assert.deepStrictEqual(yield* history, upstream076History);
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES ('upstream-session', 'person', '[]', 'local', '2026-11-01', '2027-11-01')`;
        const auth = yield* sql`SELECT * FROM auth_sessions`.unprepared;
        const retiredTables =
          yield* sql`SELECT name, sql FROM sqlite_master WHERE name LIKE 'peer_environment_%' ORDER BY name`;
        assert.isAbove(retiredTables.length, 0);
        assert.deepStrictEqual(
          (yield* runMigrations()).map(([id]) => id),
          migrationManifest.filter(([id]) => id > 76).map(([id]) => id),
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* history, [
          ...upstream076History,
          ...migrationManifest.filter(([id]) => id > 76),
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM auth_sessions`.unprepared,
          auth.map((row) => ({ ...row, proof_key_thumbprint: null })),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, sql FROM sqlite_master WHERE name LIKE 'peer_environment_%' ORDER BY name`,
          retiredTables,
        );
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    `upgrades frozen Baskule main 080, preserves records and backfills readable citations`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* createBaskule080;
        assert.deepStrictEqual(yield* history, baskule080History);
        const triggers = yield* sql<{ sql: string }>`
          SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_message_search_update'
        `;
        assert.include(triggers[0]?.sql, "AFTER UPDATE OF payload_json, streaming, role ON");
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES ('session-main', 'person-main', '[]', 'baskule', '2026-11-01', '2027-11-01')`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread-main', 'project-main', 'Keep main', 'opencode', 'full-access', 'default', '2026-11-01', '2026-11-01',
        '{"author":{"id":"person-main","name":"Person"},"title":"Keep main"}')`;
        const citation = serializeAssistantCitation({
          version: 1,
          environmentId: EnvironmentId.make("environment:main"),
          threadId: ThreadId.make("thread-main"),
          messageId: MessageId.make("quoted-main"),
          text: "A kittiwake's résumé",
          comment: "Keep citation search",
          start: 0,
          end: 19,
          prefix: "encoded-marker",
          suffix: "suffix",
        });
        for (let index = 0; index < 502; index++) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${`message-${String(index).padStart(3, "0")}`}, 'thread-main', 'user', 0, '2026-11-01', '2026-11-01',
          ${JSON.stringify({ text: index === 501 ? "Plain preserved text" : citation, author: { id: "person-main", name: "Person" } })})`;
        }
        const before = yield* sql`SELECT * FROM auth_sessions`.unprepared;
        const messages =
          yield* sql`SELECT message_id, thread_id, payload_json FROM orchestration_v2_projection_messages ORDER BY message_id`;
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id > 80),
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM auth_sessions`.unprepared,
          before.map((row) => ({ ...row, proof_key_thumbprint: null })),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT message_id, thread_id, payload_json FROM orchestration_v2_projection_messages ORDER BY message_id`,
          messages,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT json_extract(payload_json, '$.author.id') AS author FROM orchestration_v2_projection_threads`,
          [{ author: "person-main" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT search_text FROM orchestration_v2_projection_messages WHERE message_id = 'message-500'`,
          [{ search_text: "A kittiwake's résumé\nComment: Keep citation search" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT search_text FROM orchestration_v2_projection_messages WHERE message_id = 'message-501'`,
          [{ search_text: null }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT COUNT(*) AS n FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH '"résumé"'`,
          [{ n: 501 }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT COUNT(*) AS n FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH '"encoded-marker"'`,
          [{ n: 0 }],
        );
      }).pipe(Effect.provide(database)),
  );
});

it.effect(
  "reopens upgraded Node and hosted databases without repeating migrations or losing sessions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "baskule-081-reopen-" }),
        "state.sqlite",
      );
      const storage = makeFakeDoStorage();
      for (const open of [() => NodeSqliteClient.layer({ filename }), () => DoSql.layer(storage)]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* createBaskule081;
            yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
          VALUES ('reopen-session', 'reopen-member', '["orchestration:read"]', 'baskule', '2026-11-01', '2027-11-01')`;
          }).pipe(Effect.provide(open())),
        );
        yield* Effect.scoped(runMigrations().pipe(Effect.provide(open())));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* runMigrations(), []);
            assert.deepStrictEqual(yield* history, migrationManifest);
            assert.deepStrictEqual(
              yield* sql`SELECT session_id, subject, scopes, revoked_at, proof_key_thumbprint FROM auth_sessions`,
              [
                {
                  session_id: "reopen-session",
                  subject: "reopen-member",
                  scopes: '["orchestration:read"]',
                  revoked_at: null,
                  proof_key_thumbprint: null,
                },
              ],
            );
          }).pipe(Effect.provide(open())),
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
