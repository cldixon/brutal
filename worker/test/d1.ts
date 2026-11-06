import { Database, type SQLQueryBindings } from "bun:sqlite";

/** Enough of D1 over bun:sqlite for tests, so they run the same SQL production does. */
export function bunD1(): D1Database {
  const db = new Database(":memory:");
  const statement = (sql: string, params: unknown[] = []) => {
    const q = () => db.query(sql);
    const args = params as SQLQueryBindings[];
    return {
      bind: (...p: unknown[]) => statement(sql, p),
      async first<T>() {
        return (q().get(...args) as T | null) ?? null;
      },
      async all<T>() {
        return { results: q().all(...args) as T[], success: true, meta: {} };
      },
      async run() {
        return { results: [], success: true, meta: { changes: q().run(...args).changes } };
      },
      sync: () => q().run(...args),
    };
  };
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: ReturnType<typeof statement>[]) {
      return db.transaction(() => stmts.map((s) => ({ success: true, meta: s.sync() })))();
    },
  };
  return d1 as unknown as D1Database;
}
