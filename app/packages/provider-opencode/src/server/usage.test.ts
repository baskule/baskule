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

import { openCodeUsageReader, readOpenCodeUsage } from "./usage.ts";

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

describe("readOpenCodeUsage", () => {
  it.effect("bounds raw history allocations while counting every eligible message once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-large-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER, type TEXT DEFAULT 'assistant')",
      );
      const sinceMs = 1780000000000;
      const message = {
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: sinceMs },
        tokens: { input: 100, output: 20 },
        body: "x".repeat(64 * 1024),
      };
      const data = JSON.stringify(message);
      const insert = (rowId: number, id: string, payload: string, created = sinceMs) =>
        db.unsafe(
          "INSERT INTO session_message (rowid, id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)",
          [rowId, id, "session-1", payload, created],
        );
      for (let index = 0; index < 130; index++) {
        yield* insert(index * 2 - 10, `msg-${index}`, data);
      }
      yield* insert(300, "old", data, sinceMs - 1);
      yield* insert(301, "user", JSON.stringify({ ...message, role: "user" }));
      yield* insert(302, "invalid", "{invalid");
      yield* insert(303, "msg-0", data);

      let largestRawResult = 0;
      const originalAll = NodeSqlite.StatementSync.prototype.all;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
            this: NodeSqlite.StatementSync,
            ...params
          ) {
            const rows = originalAll.apply(this, params);
            const rawSize = rows.reduce(
              (size, row) => size + (typeof row.data === "string" ? row.data.length : 0),
              0,
            );
            largestRawResult = Math.max(largestRawResult, rawSize);
            return rows;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.error);
      const records = result.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => record.dedupeKey),
        Array.from({ length: 130 }, (_, index) => `opencode:msg-${index}`),
      );
      assert.strictEqual(
        records.reduce((total, record) => total + record.totals.uncachedInputTokens, 0),
        13000,
      );
      assert.isAbove(largestRawResult, 0);
      assert.isBelow(largestRawResult, 6 * 1024 * 1024);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads at most 64 OpenCode rowids per statement however much history is older", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
      const db = yield* openDatabase(path.join(dir, "opencode.db"));
      yield* db.unsafe(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER, type TEXT DEFAULT 'assistant')",
      );
      const sinceMs = 1780000000000;
      const data = JSON.stringify({
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        tokens: { input: 100, output: 20 },
      });
      yield* db.unsafe("BEGIN");
      for (let index = 0; index < 305; index++) {
        yield* db.unsafe(
          "INSERT INTO session_message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)",
          [`msg-${index}`, "session-1", data, sinceMs + index - 300],
        );
      }
      yield* db.unsafe("COMMIT");

      const spans: number[] = [];
      const originalAll = NodeSqlite.StatementSync.prototype.all;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
            this: NodeSqlite.StatementSync,
            ...params
          ) {
            const rows = originalAll.apply(this, params);
            if (this.sourceSQL.includes("FROM session_message WHERE")) {
              const range = /rowid > (-?[\d.]+) AND rowid <= (-?[\d.]+)/.exec(this.expandedSQL);
              spans.push(range ? Number(range[2]) - Number(range[1]) : Infinity);
            }
            return rows;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const result = yield* readOpenCodeUsage(dir, sinceMs);
      assert.isFalse(result.error);
      assert.deepStrictEqual(
        result.files.flatMap((file) => file.records).map((record) => record.dedupeKey),
        Array.from({ length: 5 }, (_, index) => `opencode:msg-${index + 300}`),
      );
      assert.isNotEmpty(spans);
      assert.isAtMost(Math.max(...spans), 64);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
import * as NodeSqlite from "node:sqlite";

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
