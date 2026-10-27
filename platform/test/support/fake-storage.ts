// A fake DurableObjectStorage (`sql.exec` + `transactionSync`) over node:sqlite, close enough to DO SQLite for
// Drizzle's durable-sqlite driver, its migrator and our raw SQL. Foreign keys are enforced, as in DO SQLite.
import { DatabaseSync } from "node:sqlite";
import type { StorageLike } from "../../src/control/service";

type Val = string | number | bigint | null | Uint8Array;

function cursor(cols: string[], rows: Val[][]) {
  const objs = () => rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  let i = 0;
  const it = {
    columnNames: cols,
    rowsRead: rows.length,
    rowsWritten: 0,
    toArray: objs,
    one() {
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return objs()[0];
    },
    raw() {
      let j = 0;
      return {
        toArray: () => rows.map((r) => [...r]),
        next: () => (j < rows.length ? { value: [...rows[j++]], done: false } : { value: undefined, done: true }),
        [Symbol.iterator]() { return this; },
      };
    },
    next() {
      const o = objs();
      return i < o.length ? { value: o[i++], done: false } : { value: undefined, done: true };
    },
    [Symbol.iterator]() { return this; },
  };
  return it;
}

export function fakeStorage(): StorageLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  let sp = 0;
  return {
    db,
    sql: {
      exec(query: string, ...params: unknown[]) {
        const stmt = db.prepare(query);
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p instanceof ArrayBuffer ? new Uint8Array(p) : p)) as Val[];
        const cols = stmt.columns().map((c) => c.name);
        if (!cols.length) {
          stmt.run(...bound);
          return cursor([], []);
        }
        (stmt as unknown as { setReturnArrays(v: boolean): void }).setReturnArrays(true);
        return cursor(cols, stmt.all(...bound) as unknown as Val[][]);
      },
    },
    transactionSync<T>(fn: () => T): T {
      const name = `sp${++sp}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const r = fn();
        db.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      }
    },
  };
}
