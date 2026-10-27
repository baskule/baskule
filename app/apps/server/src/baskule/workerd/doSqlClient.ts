// baskule: an Effect `SqlClient` over Durable Object SQLite (`ctx.storage.sql`) for the
// workerd build of the T3 server (architecture v3, E2/E8).
//
// What DO SQLite refuses or limits, and how this client handles it on celld 0.6.3:
// - `BEGIN`/`SAVEPOINT`/`COMMIT`/`ROLLBACK`/`RELEASE` are "not authorized". Transactions go
//   through `storage.transaction(closure)` instead, which commits when the closure's promise
//   resolves and rolls back when it rejects. A nested `withTransaction` opens a nested
//   `storage.transaction`, which behaves like a savepoint: its failure discards only its rows.
// - At most 100 bound parameters per statement: beyond that, parameters are inlined as literals.
// - At most 5 terms per compound SELECT: on that error the query is regrouped into nested
//   sub-selects of at most 5 terms and retried.
// - Tuning and maintenance PRAGMAs and VACUUM are "not authorized": tuning PRAGMAs become no-ops,
//   size PRAGMAs are answered from `sql.databaseSize`, VACUUM is a no-op.
// - A multi-statement string cannot carry parameters (the bindings count is checked per string).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

/** The part of `DurableObjectStorage` this client uses. */
export interface DoSqlStorage {
  readonly sql: {
    exec(query: string, ...bindings: ReadonlyArray<unknown>): DoSqlCursor;
    readonly databaseSize?: number | undefined;
  };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

export interface DoSqlCursor {
  readonly columnNames: ReadonlyArray<string>;
  raw(): IterableIterator<ReadonlyArray<unknown>>;
}

export const MAX_BOUND_PARAMETERS = 100;
export const MAX_COMPOUND_TERMS = 5;

export interface DoSqlStats {
  statements: number;
  transactions: number;
  rollbacks: number;
  inlinedParameterStatements: number;
  compoundRewrites: number;
  pragmaNoops: number;
}

const DoSqlTransaction = Context.Service<
  SqlClient.TransactionConnection,
  SqlClient.TransactionConnection.Service
>("@baskule/workerd/DoSqlTransaction");

// ---------------------------------------------------------------------------------------------
// SQL text helpers (quote- and comment-aware scanning)

/** Calls `visit(index, depth)` for every character outside quotes and comments. */
const scan = (sql: string, visit: (index: number, depth: number) => boolean | void): void => {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = sql.indexOf(ch, i + 1);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "(") depth++;
    if (visit(i, depth) === true) return;
    if (ch === ")") depth--;
  }
};

const literal = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot inline non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) {
    return `X'${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
};

/** Replaces `?` placeholders (outside quotes/comments) with SQL literals. */
export const inlineParameters = (sql: string, params: ReadonlyArray<unknown>): string => {
  const positions: Array<number> = [];
  scan(sql, (i) => {
    if (sql[i] === "?") positions.push(i);
  });
  if (positions.length !== params.length) {
    throw new Error(
      `Cannot inline parameters: ${positions.length} placeholders for ${params.length} values`,
    );
  }
  let out = "";
  let last = 0;
  positions.forEach((pos, index) => {
    out += sql.slice(last, pos) + literal(params[index]);
    last = pos + 1;
  });
  return out + sql.slice(last);
};

const COMPOUND = /^(UNION\s+ALL|UNION|INTERSECT|EXCEPT)\b/i;
const TAIL = /^(ORDER\s+BY|LIMIT)\b/i;
const isWordBoundary = (sql: string, i: number) => i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]!);

interface CompoundSplit {
  readonly terms: ReadonlyArray<string>;
  readonly operators: ReadonlyArray<string>;
  readonly tail: string;
}

/** Splits the top level of `sql` (depth 0) into compound terms. */
const splitCompound = (sql: string): CompoundSplit => {
  const cuts: Array<{ start: number; end: number; op: string }> = [];
  let tailAt = -1;
  scan(sql, (i, depth) => {
    if (depth !== 0 || sql[i] === "(" || !isWordBoundary(sql, i)) return;
    const rest = sql.slice(i, i + 16);
    const m = COMPOUND.exec(rest);
    if (m) {
      cuts.push({ start: i, end: i + m[0].length, op: m[1]!.toUpperCase().replace(/\s+/, " ") });
      return;
    }
    if (cuts.length > 0 && TAIL.test(rest)) {
      tailAt = i;
      return true;
    }
  });
  const body = tailAt === -1 ? sql : sql.slice(0, tailAt);
  const terms: Array<string> = [];
  let last = 0;
  for (const cut of cuts) {
    terms.push(body.slice(last, cut.start).trim());
    last = cut.end;
  }
  terms.push(body.slice(last).trim());
  return { terms, operators: cuts.map((c) => c.op), tail: tailAt === -1 ? "" : sql.slice(tailAt) };
};

/** Nests `terms` (joined by `op`) into sub-selects until at most `maxTerms` remain. */
const nestTerms = (
  terms: ReadonlyArray<string>,
  op: string,
  maxTerms: number,
): ReadonlyArray<string> => {
  let level = terms;
  while (level.length > maxTerms) {
    const grouped: Array<string> = [];
    for (let i = 0; i < level.length; i += maxTerms) {
      const chunk = level.slice(i, i + maxTerms);
      grouped.push(chunk.length === 1 ? chunk[0]! : `SELECT * FROM (${chunk.join(` ${op} `)})`);
    }
    level = grouped;
  }
  return level;
};

/**
 * `recursiveName` is set for the body of a recursive CTE: its recursive terms (those naming the
 * CTE) must stay top-level terms of that body, so only the other terms are nested.
 */
const regroupLevel = (sql: string, maxTerms: number, recursiveName?: string): string => {
  // A leading WITH clause stays outside the regrouped compound.
  let prefix = "";
  let body = sql;
  if (/^\s*WITH\b/i.test(sql)) {
    let selectAt = -1;
    scan(sql, (i, depth) => {
      if (depth === 0 && isWordBoundary(sql, i) && /^SELECT\b/i.test(sql.slice(i, i + 7))) {
        selectAt = i;
        return true;
      }
    });
    if (selectAt === -1) return sql;
    prefix = sql.slice(0, selectAt);
    body = sql.slice(selectAt);
  }
  const { terms, operators, tail } = splitCompound(body);
  if (terms.length <= maxTerms) return sql;
  // Regrouping is only equivalent when every operator at this level is the same UNION kind.
  const op = operators[0]!;
  if (!operators.every((o) => o === op) || (op !== "UNION" && op !== "UNION ALL")) return sql;
  const names = recursiveName ? new RegExp(`\\b${recursiveName}\\b`, "i") : undefined;
  const recursive = names ? terms.filter((t) => names.test(t)) : [];
  const plain = names ? terms.filter((t) => !names.test(t)) : terms;
  if (recursive.length + 1 > maxTerms) return sql;
  let level: ReadonlyArray<string>;
  if (recursive.length === 0) {
    level = nestTerms(plain, op, maxTerms);
  } else {
    const nested = nestTerms(plain, op, maxTerms);
    const seed = nested.length === 1 ? nested[0]! : `SELECT * FROM (${nested.join(` ${op} `)})`;
    level = [...(plain.length > 0 ? [seed] : []), ...recursive];
  }
  return `${prefix}${level.join(` ${op} `)}${tail ? ` ${tail}` : ""}`;
};

const CTE_HEAD =
  /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^()]*\))?\s+AS\s+(?:NOT\s+MATERIALIZED\s+|MATERIALIZED\s+)?$/i;

/**
 * Rewrites every compound SELECT with more than `maxTerms` terms (at any nesting level) into
 * nested sub-selects. Mixed operators and INTERSECT/EXCEPT are left untouched.
 */
export const regroupCompoundSelects = (
  sql: string,
  maxTerms = MAX_COMPOUND_TERMS,
  recursiveName?: string,
): string => {
  const isRecursiveWith = /^\s*WITH\s+RECURSIVE\b/i.test(sql);
  // Recurse into parenthesized groups first, innermost out.
  let out = "";
  let groupStart = -1;
  let last = 0;
  scan(sql, (i, depth) => {
    const ch = sql[i];
    if (ch === "(" && depth === 1) groupStart = i;
    if (ch === ")" && depth === 1 && groupStart !== -1) {
      const cte = isRecursiveWith ? CTE_HEAD.exec(sql.slice(0, groupStart))?.[1] : undefined;
      out +=
        sql.slice(last, groupStart + 1) +
        regroupCompoundSelects(sql.slice(groupStart + 1, i), maxTerms, cte);
      last = i;
      groupStart = -1;
    }
  });
  out += sql.slice(last);
  return regroupLevel(out, maxTerms, recursiveName);
};

// ---------------------------------------------------------------------------------------------
// Statement policy

type Policy =
  | { readonly _tag: "run" }
  | { readonly _tag: "noop" }
  | {
      readonly _tag: "rows";
      readonly rows: (storage: DoSqlStorage) => Array<Record<string, unknown>>;
    }
  | { readonly _tag: "refuse"; readonly reason: string };

const NOOP_PRAGMAS = new Set([
  "busy_timeout",
  "journal_mode",
  "synchronous",
  "checkpoint_fullfsync",
  "journal_size_limit",
  "auto_vacuum",
  "wal_checkpoint",
  "wal_autocheckpoint",
  "incremental_vacuum",
  "cache_size",
  "mmap_size",
  "temp_store",
  "locking_mode",
]);

const PAGE_SIZE = 4096;
const SIZE_PRAGMAS: Record<string, (storage: DoSqlStorage) => number> = {
  page_size: () => PAGE_SIZE,
  page_count: (storage) => Math.ceil((storage.sql.databaseSize ?? 0) / PAGE_SIZE),
  freelist_count: () => 0,
};

export const classifyStatement = (sql: string): Policy => {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const pragma = /^PRAGMA\s+(?:main\.)?([a-z_]+)\s*(=|\()?/i.exec(trimmed);
  if (pragma) {
    const name = pragma[1]!.toLowerCase();
    if (NOOP_PRAGMAS.has(name)) return { _tag: "noop" };
    const size = SIZE_PRAGMAS[name];
    if (size && pragma[2] === undefined) {
      return { _tag: "rows", rows: (storage) => [{ [name]: size(storage) }] };
    }
    return { _tag: "run" };
  }
  if (/^VACUUM\b/i.test(trimmed)) return { _tag: "noop" };
  if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(trimmed)) {
    return {
      _tag: "refuse",
      reason:
        "Durable Object SQLite refuses transaction control statements; use sql.withTransaction",
    };
  }
  return { _tag: "run" };
};

// ---------------------------------------------------------------------------------------------
// Client

const toError = (cause: unknown, sql: string, operation: string) =>
  new SqlError({
    reason: new UnknownError({
      cause,
      message: `Durable Object SQL failed: ${cause instanceof Error ? cause.message : String(cause)} :: ${sql.slice(0, 200)}`,
      operation,
    }),
  });

const normalizeParam = (value: unknown): unknown =>
  typeof value === "boolean" ? (value ? 1 : 0) : value === undefined ? null : value;

const normalizeValue = (value: unknown): unknown =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

const ROLLBACK = Symbol("baskule/DoSqlClient/rollback");

export interface DoSqlClient {
  readonly client: SqlClient.SqlClient;
  readonly stats: DoSqlStats;
}

export const make = (storage: DoSqlStorage) =>
  Effect.gen(function* () {
    const stats: DoSqlStats = {
      statements: 0,
      transactions: 0,
      rollbacks: 0,
      inlinedParameterStatements: 0,
      compoundRewrites: 0,
      pragmaNoops: 0,
    };

    const execRaw = (sql: string, params: ReadonlyArray<unknown>) => {
      stats.statements++;
      let bound = params.map(normalizeParam);
      let text = sql;
      if (bound.length > MAX_BOUND_PARAMETERS) {
        stats.inlinedParameterStatements++;
        text = inlineParameters(text, bound);
        bound = [];
      }
      try {
        return storage.sql.exec(text, ...bound);
      } catch (cause) {
        if (!/too many terms in compound SELECT/i.test(String(cause))) throw cause;
        const rewritten = regroupCompoundSelects(text);
        if (rewritten === text) throw cause;
        stats.compoundRewrites++;
        return storage.sql.exec(rewritten, ...bound);
      }
    };

    const runRows = (
      sql: string,
      params: ReadonlyArray<unknown>,
    ): Array<Record<string, unknown>> => {
      const policy = classifyStatement(sql);
      switch (policy._tag) {
        case "noop":
          stats.pragmaNoops++;
          return [];
        case "rows":
          return policy.rows(storage);
        case "refuse":
          throw new Error(policy.reason);
        case "run": {
          const cursor = execRaw(sql, params);
          const columns = cursor.columnNames;
          const rows: Array<Record<string, unknown>> = [];
          for (const raw of cursor.raw()) {
            const row: Record<string, unknown> = {};
            for (let i = 0; i < columns.length; i++) row[columns[i]!] = normalizeValue(raw[i]);
            rows.push(row);
          }
          return rows;
        }
      }
    };

    const run = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.try({
        try: () => runRows(sql, params),
        catch: (cause) => toError(cause, sql, "execute"),
      });

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(run(sql, params), (rows) => rows.map((row) => Object.values(row)));

    const withTransform = <A>(
      effect: Effect.Effect<ReadonlyArray<A>, SqlError>,
      transform: ((rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined,
    ) => (transform ? Effect.map(effect, transform) : effect);

    const connection = {
      execute: (
        sql: string,
        params: ReadonlyArray<unknown>,
        transform?: (rows: ReadonlyArray<any>) => ReadonlyArray<any>,
      ) => withTransform(run(sql, params), transform),
      executeRaw: (sql: string, params: ReadonlyArray<unknown>) => run(sql, params),
      executeStream: (
        sql: string,
        params: ReadonlyArray<unknown>,
        transform?: (rows: ReadonlyArray<any>) => ReadonlyArray<any>,
      ) => Stream.fromIterableEffect(withTransform(run(sql, params), transform)),
      executeValues: runValues,
      executeUnprepared: (
        sql: string,
        params: ReadonlyArray<unknown>,
        transform?: (rows: ReadonlyArray<any>) => ReadonlyArray<any>,
      ) => withTransform(run(sql, params), transform),
    } as unknown as SqlConnection.Connection;

    // One permit: a statement outside a transaction waits while a transaction is open, so no
    // other fiber's write lands inside it (DO SQLite is a single connection).
    const semaphore = yield* Semaphore.make(1);
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () =>
          Scope.addFinalizer(scope, semaphore.release(1)),
        ),
        connection,
      );
    });

    const runInStorageTransaction = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        return yield* Effect.callback<A, E | SqlError>((resume) => {
          const controller = new AbortController();
          let started = false;
          let rollback: Exit.Failure<A, E> | undefined;
          stats.transactions++;
          // The transaction body owns the native gate. Resume the caller only after the native promise commits,
          // so its later callbacks retain the caller's event rather than the short-lived transaction event.
          const committed = storage.transaction(async () => {
            started = true;
            const exit = controller.signal.aborted ? Exit.interrupt()
              : await Effect.runPromiseExitWith(context)(effect, { signal: controller.signal });
            if (Exit.isFailure(exit)) {
              stats.rollbacks++;
              rollback = exit;
              throw ROLLBACK;
            }
            return exit;
          });
          committed.then(exit => resume(exit), cause => {
            if (cause === ROLLBACK && rollback) resume(rollback);
            else resume(Effect.fail(toError(cause, started ? "COMMIT" : "BEGIN", started ? "commit" : "transaction")));
          });
          return Effect.promise(async () => {
            controller.abort();
            await committed.catch(() => undefined);
          });
        });
      });

    const withTransaction = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      Effect.withFiber((fiber) => {
        const current = Context.getOption(fiber.context, DoSqlTransaction);
        const depth = current._tag === "Some" ? current.value[1] + 1 : 0;
        const inner = Effect.provideContext(
          effect,
          Context.add(fiber.context, DoSqlTransaction, [connection, depth] as const),
        );
        const transaction = runInStorageTransaction(inner);
        // Nested transactions already hold the permit through their outermost transaction.
        return depth === 0 ? semaphore.withPermits(1)(transaction) : transaction;
      });

    const base = yield* SqlClient.make({
      acquirer,
      transactionAcquirer,
      transactionService: DoSqlTransaction,
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [["db.system.name", "sqlite"]],
    });
    const client = Object.assign(base, {
      withTransaction,
      transactionStatements: false,
    }) as SqlClient.SqlClient;
    (client as { safe: unknown }).safe = client;
    return { client, stats } satisfies DoSqlClient;
  }).pipe(Effect.provide(Reactivity.layer));

/** `SqlClient` layer over the given storage; `stats` is filled as statements run. */
export const layer = (storage: DoSqlStorage) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(make(storage), ({ client }) => client),
  );
