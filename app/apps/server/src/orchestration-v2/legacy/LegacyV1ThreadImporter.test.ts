import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionReplay from "../testkit/ProjectionReplay.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

import { layerReaderDatabase, traceSqlRouting } from "../../persistence/testkit/SqliteRouting.ts";

const layerDatabase = layerReaderDatabase;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);
const layerProjectionReplayProvided = ProjectionReplay.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
  layerProjectionReplayProvided,
);

const seedPendingTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadIds = [ThreadId.make("thread:first"), ThreadId.make("thread:later")];
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:background', 'Legacy project', '/tmp/legacy-background', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  for (const threadId of threadIds) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:background', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES
        (${`${threadId}:old`}, ${threadId}, 'user', 'Old question', 0,
          '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        (${`${threadId}:latest`}, ${threadId}, 'user', 'Latest question', 0,
          '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z')
    `;
  }
  yield* importer.reconcileShells;
});

it.effect("routes shell selectors to readers while imports stay writable", () =>
  Effect.gen(function* () {
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const sql = yield* SqlClient.SqlClient;
    const { queries, trace } = traceSqlRouting();
    yield* seedPendingTranscripts.pipe(trace);
    const selectors = queries.filter(
      ({ query }) =>
        query.includes("FROM projection_threads AS thread") ||
        query.includes("FROM orchestration_v2_legacy_imports AS legacy_import") ||
        query.includes("FROM projection_thread_messages AS message"),
    );
    assert.lengthOf(selectors, 6);
    assert.deepEqual([...new Set(selectors.map((row) => row.connection))], ["reader"]);
    assert.deepEqual(yield* importer.reconcileShells, {
      importedThreadCount: 0,
      importedMessageCount: 0,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'thread:uncommitted', 'project:background', 'Uncommitted legacy title',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            'message:uncommitted', 'thread:uncommitted', 'user', 'Uncommitted preview', 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          )
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_remove(payload_json, '$.pinnedAt')
          WHERE thread_id = 'thread:first'
        `;
        yield* sql`
          UPDATE projection_threads SET pinned_at = '2026-01-01T00:00:00.000Z'
          WHERE thread_id = 'thread:first'
        `;
        const result = yield* importer.reconcileShells;
        assert.deepEqual(result, { importedThreadCount: 2, importedMessageCount: 1 });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const repaired = yield* projections.getThreadProjection(ThreadId.make("thread:first"));
        assert.equal(DateTime.formatIso(repaired.thread.pinnedAt!), "2026-01-01T00:00:00.000Z");
        const imported = yield* projections.getThreadProjection(
          ThreadId.make("thread:uncommitted"),
        );
        assert.equal(imported.messages[0]?.text, "Uncommitted preview");
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("thread:uncommitted"))).thread
            .title,
          "Uncommitted legacy title",
        );
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps hydrating later transcripts after a defect and leaves the failed thread pending",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedPendingTranscripts;

      yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, params] = statement.compile();
          return query.includes("FROM projection_thread_messages") &&
            params.includes("thread:first")
            ? Effect.die("transcript read failed")
            : Effect.succeed(statement);
        }),
      );

      const later = yield* projections.getThreadProjection(ThreadId.make("thread:later"));
      assert.deepStrictEqual(
        later.messages.map((message) => message.text),
        ["Old question", "Latest question"],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT thread_id, transcript_imported_at, last_error FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL
        `,
        [
          {
            thread_id: "thread:first",
            transcript_imported_at: null,
            last_error: "Transcript hydration failed; retry on next open.",
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

// regression: #15920 one bad legacy message stopped the server from starting
it.effect("propagates interruption from transcript reads and retry-marker writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* seedPendingTranscripts;
    const interrupted = [];
    for (const phase of ["transcript", "retry-marker"]) {
      const exit = yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query] = statement.compile();
          const readingTranscript = query.includes("FROM projection_thread_messages");
          const writingRetryMarker = query.includes("SET last_error =");
          if (phase === "retry-marker" && readingTranscript) {
            return Effect.die("transcript read failed");
          }
          if (phase === "transcript" ? readingTranscript : writingRetryMarker) {
            return Effect.interrupt;
          }
          return Effect.succeed(statement);
        }),
        Effect.exit,
      );
      interrupted.push(Exit.hasInterrupts(exit));
    }
    assert.deepStrictEqual(interrupted, [true, true]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id FROM orchestration_v2_legacy_imports
        WHERE transcript_imported_at IS NOT NULL OR last_error IS NOT NULL
      `,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

// regression: #30813 a malformed V1 timestamp stopped the server from starting
it.effect("imports legacy rows with malformed timestamps and keeps the archive marker", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const malformed = "2026-07-13T14:13:00.3NZ";
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        'project:malformed', 'Legacy project', '/tmp/legacy-malformed', '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at
      ) VALUES (
        'thread:malformed', 'project:malformed', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-07-13T14:00:00.000Z', ${malformed}, ${malformed}
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (
        'message:malformed', 'thread:malformed', 'user', 'Question', 0,
        ${malformed}, '2026-07-13T14:13:00.000Z'
      )
    `;

    assert.deepStrictEqual(yield* importer.reconcileShells, {
      importedThreadCount: 1,
      importedMessageCount: 1,
    });
    const projection = yield* projections.getThreadProjection(ThreadId.make("thread:malformed"));
    assert.isNotNull(projection.thread.archivedAt);
    assert.deepStrictEqual(
      projection.messages.map((message) => message.text),
      ["Question"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("caches the absent legacy transcript for a native V2 thread", () =>
  Effect.gen(function* () {
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:v2-born");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:v2-born"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: ProjectId.make("project:v2-born"),
            title: "Native V2 thread",
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
            createdBy: "user",
            creationSource: "web",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
      ],
    });
    const before = yield* projections.getThreadProjection(threadId);
    let legacyLookups = 0;
    for (let read = 0; read < 3; read++) {
      const summary = yield* importer.ensureTranscript(threadId).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, parameters] = statement.compile();
          if (
            query.includes("FROM orchestration_v2_legacy_imports") &&
            parameters[0] === threadId
          ) {
            legacyLookups++;
          }
          return Effect.succeed(statement);
        }),
      );
      assert.deepStrictEqual(summary, { importedThreadCount: 0, importedMessageCount: 0 });
    }
    assert.equal(legacyLookups, 1);
    assert.deepStrictEqual(yield* projections.getThreadProjection(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);
