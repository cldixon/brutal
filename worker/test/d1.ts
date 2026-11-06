import { Database, type SQLQueryBindings } from "bun:sqlite";

/** Enough of D1 over bun:sqlite for tests, so they run the same SQL production does. */
export function bunD1(): D1Database {
  const db = new Database(":memory:");
  const statement = (sql: string, params: unknown[] = []) => {
    const q = () => db.query(sql);
    const args = params as SQLQueryBindings[];
    return {
      bind: (...p: unknown[]) => statement(sql, p),
      async first<T>(column?: string) {
        const row = (q().get(...args) as Record<string, unknown> | null) ?? null;
        return (row && column ? row[column] : row) as T | null;
      },
      async all<T>() {
        return { results: q().all(...args) as T[], success: true, meta: {} };
      },
      async run() {
        return { results: [], success: true, meta: { changes: q().run(...args).changes } };
      },
      // As D1's batch does: rows for a query, the change count for a write.
      sync: () =>
        /^\s*(SELECT|WITH)\b/i.test(sql)
          ? { results: q().all(...args), success: true, meta: { changes: 0 } }
          : { results: [], success: true, meta: { changes: q().run(...args).changes } },
    };
  };
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: ReturnType<typeof statement>[]) {
      return db.transaction(() => stmts.map((s) => s.sync()))();
    },
  };
  return d1 as unknown as D1Database;
}
