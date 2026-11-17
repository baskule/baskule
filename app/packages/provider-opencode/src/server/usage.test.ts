import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import {
  openCodeForkContinuationSessionId,
  openCodeForkMessages,
  openCodeForkSchema,
  openCodeForkSessions,
  openCodeForkSourceAssistantId,
  openCodeForkSourceSessionId,
} from "./usage.fixture.ts";
import { openCodeUsageReader, readOpenCodeUsage } from "./usage.ts";

const readerWorkers = vi.hoisted(() => ({ started: 0, enabled: false }));

// Statement spies only see the main thread, so reader workers fail to start unless a test enables them.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class ReaderWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((readerWorkers.enabled
          ? args
          : [
              "throw new Error('reader workers disabled');",
              { eval: true },
            ]) as ConstructorParameters<typeof actual.Worker>),
      );
      readerWorkers.started++;
    }
  }
  return { ...actual, Worker: ReaderWorker };
});

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

const recordedForkDatabase = Effect.fn(function* (
  sessions: ReadonlyArray<{
    readonly id: string;
    readonly project_id: string;
    readonly fork_session_id: string | null;
    readonly fork_boundary: string | null;
    readonly slug: string;
    readonly directory: string;
    readonly version: string;
    readonly time_created: number;
    readonly time_updated: number;
  }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-fork-test-" });
  const db = yield* openDatabase(path.join(dir, "opencode.db"));
  for (const statement of openCodeForkSchema) yield* db.unsafe(statement);
  for (const session of sessions) {
    yield* db.unsafe(
      "INSERT INTO session_v2 (id, project_id, fork_session_id, fork_boundary, slug, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        session.id,
        session.project_id,
        session.fork_session_id,
        session.fork_boundary,
        session.slug,
        session.directory,
        session.version,
        session.time_created,
        session.time_updated,
      ],
    );
  }
  for (const message of openCodeForkMessages) {
    yield* db.unsafe(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        message.id,
        message.session_id,
        message.type,
        message.seq,
        message.time_created,
        message.time_updated,
        message.data,
      ],
    );
  }
  return { dir, db };
});

describe("readOpenCodeUsage", () => {
  it.effect("counts an OpenCode reply once across the sessions forked from it", () =>
    Effect.gen(function* () {
      const { dir, db } = yield* recordedForkDatabase(openCodeForkSessions);
      // A reply sent after the second fork is a new provider request.
      yield* db.unsafe(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          "msg_continuationassistant00001",
          openCodeForkContinuationSessionId,
          "assistant",
          8,
          1792620090000,
          1792620090500,
          JSON.stringify({
            time: { created: 1792620090000, completed: 1792620090500 },
            agent: "build",
            model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
            content: [{ type: "text", text: "continued" }],
            finish: "stop",
            cost: 0.02,
            tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 1500, write: 0 } },
          }),
        ],
      );

      const result = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(result.error);
      const records = result.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => [record.dedupeKey, record.sessionId]),
        [
          [`opencode:${openCodeForkSourceAssistantId}`, openCodeForkSourceSessionId],
          ["opencode:msg_continuationassistant00001", openCodeForkContinuationSessionId],
        ],
      );
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 1000,
        cachedInputTokens: 300,
        cacheCreationTokens: 0,
        outputTokens: 200,
        reasoningTokens: 0,
      });
      assert.strictEqual(records[0]?.reportedCostUsd, 0.01);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts each OpenCode fork's own replies after its boundary", () =>
    Effect.gen(function* () {
      const [source, fork] = openCodeForkSessions;
      const sibling = { ...fork, id: "ses_siblingfork00000000000000", slug: "quiet-river" };
      const { dir, db } = yield* recordedForkDatabase([...openCodeForkSessions, sibling]);
      const insert = (id: string, sessionId: string, seq: number, created: number, data: string) =>
        db.unsafe(
          "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
          [id, sessionId, seq, created, created, data],
        );
      const copied = openCodeForkMessages.find(
        (message) => message.id === openCodeForkSourceAssistantId,
      )!;
      yield* insert("msg_siblingcopy_2", sibling.id, copied.seq, copied.time_created, copied.data);
      // Sibling forks send identical replies at the same seq and millisecond.
      const created = 1792620090000;
      const reply = JSON.stringify({ ...JSON.parse(copied.data), time: { created } });
      yield* insert("msg_forkreply000000000000003", fork.id, 3, created, reply);
      yield* insert("msg_siblingreply0000000000003", sibling.id, 3, created, reply);

      const records = (yield* readOpenCodeUsage(dir, 0)).files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => record.sessionId),
        [source.id, fork.id, sibling.id],
      );

      // Deleting the source leaves the first fork holding the only copy.
      yield* db.unsafe("DELETE FROM session_message WHERE session_id = ?", [source.id]);
      yield* db.unsafe("DELETE FROM session_v2 WHERE id = ?", [source.id]);
      const remaining = (yield* readOpenCodeUsage(dir, 0)).files.flatMap((file) => file.records);
      assert.includeMembers(
        remaining.map((record) => record.dedupeKey),
        ["opencode:msg_1607ab38e001GxURO0NU4GY4Az_2", "opencode:msg_forkreply000000000000003"],
      );
      assert.notInclude(
        remaining.map((record) => record.dedupeKey),
        "opencode:msg_1607b8a6d001MA7a5GgmyUywMf_2",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts OpenCode 2 compaction requests alongside assistant replies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)",
      );
      const created = 1780000000000;
      const model = { id: "big-pickle", providerID: "opencode" };
      const insert = (seq: number, id: string, type: string, data: object) =>
        db.unsafe("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)", [
          id,
          "session-1",
          type,
          seq,
          created + seq,
          JSON.stringify({ time: { created: created + seq }, ...data }),
        ]);
      yield* insert(1, "user-1", "user", { text: "hello" });
      yield* insert(2, "assistant-1", "assistant", {
        agent: "build",
        model,
        content: [],
        cost: 0.02,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      yield* insert(3, "compaction-1", "compaction", {
        status: "completed",
        reason: "auto",
        model,
        summary: "Summary",
        recent: "",
        cost: 0.5,
        tokens: { input: 40_000, output: 1_500, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      yield* insert(4, "compaction-2", "compaction", {
        status: "running",
        reason: "manual",
        summary: "",
        recent: "",
      });

      const result = yield* readOpenCodeUsage(dir, 0);
      assert.isFalse(result.error);
      const records = result.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => [record.dedupeKey, record.model, record.reportedCostUsd]),
        [
          ["opencode:assistant-1", "big-pickle", 0.02],
          ["opencode:compaction-1", "big-pickle", 0.5],
        ],
      );
      assert.deepStrictEqual(records[1]?.totals, {
        uncachedInputTokens: 40_000,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1_500,
        reasoningTokens: 0,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads only OpenCode 2 SQLite messages and preserves malformed or optional field handling",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-formats-" });
        const db = yield* openDatabase(path.join(dir, "opencode.db"));
        const sinceMs = 1780000000000;
        const message = { model: { id: "m" }, tokens: { input: 10 }, time: { created: sinceMs } };
        const cases = [
          ["assistant", JSON.stringify({ ...message, role: "assistant", cost: 0.25 }), true],
          ["absent-role", JSON.stringify(message), true],
          ["null-role", JSON.stringify({ ...message, role: null }), false],
          ["user", JSON.stringify({ ...message, role: "user" }), false],
          ["malformed", "{broken", false],
          ["json5", "{role:'assistant'}", false],
          ["null", null, false],
          ["blob", new Uint8Array(Buffer.from(JSON.stringify(message))), false],
          ["fallback", JSON.stringify({ modelID: "fallback-model", tokens: { output: 5 } }), true],
        ] as const;
        for (const table of ["message", "session_message"]) {
          yield* db.unsafe(
            `CREATE TABLE ${table} (id TEXT, session_id TEXT, data, type TEXT, time_created INTEGER)`,
          );
          for (const [id, data] of cases) {
            yield* db.unsafe(`INSERT INTO ${table} VALUES (?, 's', ?, 'assistant', ?)`, [
              `${table}-${id}`,
              data,
              sinceMs,
            ]);
          }
          yield* db.unsafe(`INSERT INTO ${table} VALUES (?, 's', ?, 'user', ?)`, [
            `${table}-type-user`,
            JSON.stringify(message),
            sinceMs,
          ]);
        }
        const result = yield* readOpenCodeUsage(dir, sinceMs);
        assert.isFalse(result.error);
        const records = result.files.flatMap((file) => file.records);
        assert.deepStrictEqual(
          records.map((record) => record.dedupeKey),
          cases.filter(([, , valid]) => valid).map(([id]) => `opencode:session_message-${id}`),
        );
        assert.strictEqual(records[0]?.reportedCostUsd, 0.25);
        assert.strictEqual(records[2]?.model, "fallback-model");
        assert.strictEqual(records[2]?.timestampMs, sinceMs);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads only legacy OpenCode messages written since the window opened", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const legacy = path.join(dir, "storage", "message", "session-1");
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      const write = Effect.fn(function* (id: string, mtimeMs: number) {
        const file = path.join(legacy, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      yield* write("msg-old", sinceMs - 60_000);

      const stale = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(stale, { files: [], missing: false, error: false });

      const recent = yield* write("msg-new", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [recent],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-new"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never follows symlinks in the legacy OpenCode store", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const sinceMs = 1780000000000;
      const store = path.join(dir, "storage", "message");
      const session = path.join(store, "session-1");
      yield* fileSystem.makeDirectory(session, { recursive: true });
      const write = Effect.fn(function* (directory: string, id: string, mtimeMs: number) {
        const file = path.join(directory, `${id}.json`);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            id,
            sessionID: "session-1",
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            time: { created: sinceMs + 1000 },
            tokens: { input: 100, output: 20 },
          }),
        );
        yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        return file;
      });
      const target = yield* write(outside, "msg-linked", sinceMs + 60_000);
      const stale = yield* write(outside, "msg-stale", sinceMs - 60_000);
      yield* fileSystem.symlink(target, path.join(session, "msg-linked.json"));
      yield* fileSystem.symlink(stale, path.join(session, "msg-stale.json"));
      yield* fileSystem.symlink(outside, path.join(store, "session-linked"));
      yield* fileSystem.symlink(store, path.join(session, "cycle"));
      yield* fileSystem.symlink(path.join(outside, "gone.json"), path.join(session, "gone.json"));
      yield* fileSystem.symlink(path.join(session, "loop.json"), path.join(session, "loop.json"));

      const linksOnly = yield* readOpenCodeUsage(dir, sinceMs);
      assert.deepStrictEqual(linksOnly, { files: [], missing: true, error: false });

      const real = yield* write(session, "msg-real", sinceMs + 60_000);
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [real],
      );
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        ["opencode:msg-real"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("openCodeUsageReader", () => {
  it.effect("scans canonical instance roots once, including XDG and home defaults", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-instances-test-" });
      const home = yield* fileSystem.realPath(temp);
      const defaultRoot = path.join(home, ".local", "share", "opencode");
      const instanceRoot = path.join(home, "instance");
      const dataHome = path.join(home, "xdg");
      const xdgRoot = path.join(dataHome, "opencode");
      const alias = path.join(home, "default-alias");
      for (const root of [defaultRoot, instanceRoot, xdgRoot]) {
        yield* fileSystem.makeDirectory(root, { recursive: true });
      }
      yield* fileSystem.symlink(defaultRoot, alias);
      const instances = [
        { id: "opencode", environment: {}, configured: false },
        {
          id: "opencode-list",
          environment: { OPENCODE_DATA_DIR: ` ${instanceRoot}, ${alias}, ${defaultRoot}, , ` },
          configured: true,
        },
        {
          id: "opencode-xdg",
          environment: { XDG_DATA_HOME: dataHome },
          configured: true,
        },
      ];
      if (openCodeUsageReader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
      const sources = yield* openCodeUsageReader
        .scan({
          instances: instances.map(({ id, environment, configured }) => ({
            instanceId: ProviderInstanceId.make(id),
            config: undefined,
            environment,
            configured,
          })),
          settings: DEFAULT_SERVER_SETTINGS,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        })
        .pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      assert.deepStrictEqual(
        sources.map((source) => source.dir).sort(),
        [defaultRoot, instanceRoot, xdgRoot].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
