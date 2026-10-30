// baskule: an in-memory stand-in for Durable Object `ctx.storage` (SQL + transaction + alarm),
// on node:sqlite, with the limits DO SQLite enforces in celld 0.6.3 (see doSqlClient.ts).
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { MAX_BOUND_PARAMETERS, MAX_COMPOUND_TERMS, type DoSqlCursor } from "../doSqlClient.ts";

const REFUSED_PRAGMAS =
  /^\s*PRAGMA\s+(busy_timeout|journal_mode|synchronous|checkpoint_fullfsync|journal_size_limit|auto_vacuum|wal_checkpoint|page_count|page_size|freelist_count|incremental_vacuum|user_version|integrity_check)\b/i;
const REFUSED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM)\b/i;

const stripLiterals = (sql: string) =>
  sql.replace(/'(?:[^']|'')*'|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\//g, "''");

/** Largest number of terms in any single compound SELECT (approximation by parenthesis level). */
const maxCompoundTerms = (sql: string): number => {
  const text = stripLiterals(sql);
  const counts = new Map<number, number>();
  const stack: Array<number> = [0];
  let id = 0;
  let max = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") stack.push(++id);
    else if (ch === ")") stack.pop();
    else if (
      /^(UNION|INTERSECT|EXCEPT)\b/i.test(text.slice(i, i + 9)) &&
      !/\w/.test(text[i - 1] ?? " ")
    ) {
      const level = stack.at(-1)!;
      const n = (counts.get(level) ?? 1) + 1;
      counts.set(level, n);
      max = Math.max(max, n);
    }
  }
  return max;
};

const splitStatements = (sql: string): Array<string> => {
  const parts: Array<string> = [];
  let last = 0;
  const text = stripLiterals(sql);
  // stripLiterals keeps positions only when literals contain no ';', which holds for tests.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ";") {
      parts.push(sql.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(sql.slice(last));
  return parts.filter((p) => p.trim().length > 0);
};

export interface FakeDoStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: ReadonlyArray<unknown>
    ): DoSqlCursor & { toArray(): Array<Record<string, unknown>> };
    readonly databaseSize: number;
  };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
  readonly db: NodeSqlite.DatabaseSync;
}

/** `path`: a SQLite file to keep the space across processes (perf/bootBench.mjs); in memory by default. */
export const makeFakeDoStorage = (path = ":memory:"): FakeDoStorage => {
  let db = new NodeSqlite.DatabaseSync(path);
  let depth = 0;
  let gate: Promise<unknown> = Promise.resolve();
  let alarm: number | null = null;

  const exec = (query: string, ...bindings: ReadonlyArray<unknown>) => {
    if (REFUSED.test(query) || REFUSED_PRAGMAS.test(query)) {
      throw new Error("SQL error: prepare SQL cursor: not authorized");
    }
    if (bindings.length > MAX_BOUND_PARAMETERS) {
      throw new Error("SQL error: prepare SQL cursor: too many SQL variables");
    }
    if (maxCompoundTerms(query) > MAX_COMPOUND_TERMS) {
      throw new Error("SQL error: prepare SQL cursor: too many terms in compound SELECT");
    }
    const statements = splitStatements(query);
    if (statements.length > 1 && bindings.length > 0) {
      throw new Error("SQL error: Wrong number of parameter bindings for SQL query.");
    }
    for (const s of statements.slice(0, -1)) db.exec(s);
    const last = statements.at(-1) ?? "SELECT 1 WHERE 0";
    const stmt = db.prepare(last);
    const columns = stmt.columns().map((c) => c.name);
    const params = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as Array<
      null | number | bigint | string | Uint8Array
    >;
    let rows: Array<Record<string, unknown>>;
    if (columns.length === 0) {
      stmt.run(...params);
      rows = [];
    } else {
      rows = stmt.all(...params) as Array<Record<string, unknown>>;
    }
    const toBuffer = (v: unknown) =>
      v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
    const raw = rows.map((r) => columns.map((c) => toBuffer(r[c])));
    return {
      columnNames: columns,
      raw: () => raw[Symbol.iterator](),
      toArray: () => rows,
    };
  };

  const transaction = <T>(closure: () => Promise<T>): Promise<T> => {
    const runNested = async () => {
      const name = `fake_sp_${depth}`;
      depth++;
      db.exec(depth === 1 ? "BEGIN" : `SAVEPOINT ${name}`);
      try {
        const result = await closure();
        db.exec(depth === 1 ? "COMMIT" : `RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    };
    if (depth > 0) return runNested();
    // Top-level transactions are serialized, like the DO input gate does across events.
    const run = gate.then(runNested, runNested);
    gate = run.catch(() => undefined);
    return run;
  };

  return {
    sql: {
      exec,
      get databaseSize() {
        return (
          4096 *
          Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count)
        );
      },
    },
    transaction,
    getAlarm: async () => alarm,
    setAlarm: async (time) => {
      alarm = typeof time === "number" ? time : time.getTime();
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    deleteAll: async () => {
      db.close();
      if (path !== ":memory:") NodeFS.rmSync(path, { force: true });
      db = new NodeSqlite.DatabaseSync(path);
      alarm = null;
    },
    get db() {
      return db;
    },
  };
};
