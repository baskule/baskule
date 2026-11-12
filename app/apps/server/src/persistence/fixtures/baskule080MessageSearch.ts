import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

// SQLite's ltrim needs the characters matched by isAttachmentOnlyBootstrapPrompt's \s explicitly.
const BOOTSTRAP_PREFIX_WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const nonPlaceholderMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(`
  CASE
    WHEN substr(json_extract(${row}.payload_json, '$.text'), 1, 11) = 'Ultrathink:' COLLATE NOCASE
      THEN ltrim(substr(json_extract(${row}.payload_json, '$.text'), 12), '${BOOTSTRAP_PREFIX_WHITESPACE}')
    ELSE json_extract(${row}.payload_json, '$.text')
  END COLLATE BINARY <> '${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.replaceAll("'", "''")}'
`);

/**
 * Exclude attachment placeholders, generated notices and subagent threads. ACP subagents
 * rewrite their finished answer on every streamed chunk.
 * Migration triggers, backfill, rebuild and scans share this predicate; `row` may be `new`.
 */
export const indexedMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql`
  ${sql.literal(`
  ${row}.streaming = 0
  AND (
    ${row}.role = 'assistant'
    OR (
      ${row}.role = 'user'
      AND COALESCE(json_extract(${row}.payload_json, '$.createdBy'), 'user') = 'user'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
    WHERE subagent_threads.thread_id = ${row}.thread_id
      AND json_extract(subagent_threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'
  )
`)}
  AND ${nonPlaceholderMessageCondition(sql, row)}
`;

/**
 * What the index stores for a message: its text with curly apostrophes
 * straight, as search folds a query, since iOS keyboards type "’" and others
 * type "'". Migration 69's triggers use it too. `payload` is the message's
 * JSON column.
 */
export const indexedMessageText = (sql: SqlClient.SqlClient, payload: string) =>
  sql.literal(`replace(replace(json_extract(${payload}, '$.text'), '’', ''''), '‘', '''')`);

export const createMessageSearchTriggers = Effect.fn("MessageSearchIndex.createTriggers")(
  function* (sql: SqlClient.SqlClient) {
    yield* sql`
      CREATE TRIGGER orchestration_v2_message_search_insert
      AFTER INSERT ON orchestration_v2_projection_messages
      WHEN ${indexedMessageCondition(sql, "new")}
      BEGIN
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT new.rowid, ${indexedMessageText(sql, "new.payload_json")}
        WHERE json_extract(new.payload_json, '$.text') IS NOT NULL;
      END
    `;
    // Streaming deltas rewrite the row many times a second; skip them until the
    // message settles. Upserts rewrite every column, so a finished message
    // re-indexes only when what the index reads changed. Deleting a rowid the
    // index never held is a no-op.
    yield* sql`
      CREATE TRIGGER orchestration_v2_message_search_update
      AFTER UPDATE OF payload_json, streaming, role ON orchestration_v2_projection_messages
      WHEN (old.streaming = 0 OR new.streaming = 0)
        AND (
          old.streaming IS NOT new.streaming
          OR old.role IS NOT new.role
          OR json_extract(old.payload_json, '$.text') IS NOT json_extract(new.payload_json, '$.text')
          OR json_extract(old.payload_json, '$.createdBy')
            IS NOT json_extract(new.payload_json, '$.createdBy')
        )
      BEGIN
        DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid AND old.streaming = 0;
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT new.rowid, ${indexedMessageText(sql, "new.payload_json")}
        WHERE ${indexedMessageCondition(sql, "new")}
          AND json_extract(new.payload_json, '$.text') IS NOT NULL;
      END
    `;
    yield* sql`
      CREATE TRIGGER orchestration_v2_message_search_delete
      AFTER DELETE ON orchestration_v2_projection_messages
      WHEN old.streaming = 0
      BEGIN
        DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;
      END
    `;
  },
);

export const Migration0069 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Older system SQLite builds may lack these FTS5 options; search can scan messages instead.
  // Only SQLITE_ERROR signals unsupported options. Disk and I/O failures must fail the migration
  // so the next startup retries creating the index.
  const created = yield* sql`
    CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram remove_diacritics 1'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning(
          "Message search index unavailable; search will scan messages.",
          cause,
        ).pipe(Effect.as(false)),
    ),
  );
  if (!created) return;
  yield* createMessageSearchTriggers(sql);
  yield* sql`
    INSERT INTO orchestration_v2_message_search (rowid, text)
    SELECT messages.rowid, ${indexedMessageText(sql, "messages.payload_json")}
    FROM orchestration_v2_projection_messages AS messages
    WHERE ${indexedMessageCondition(sql)}
      AND json_extract(messages.payload_json, '$.text') IS NOT NULL
  `;
});

export const Migration0074 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;

  // Legacy placeholders stay indexed until rebuild; FTS deletes can overflow last_insert_rowid at commit.
  yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
  yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
  yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
  yield* createMessageSearchTriggers(sql);
});
