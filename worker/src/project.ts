import { DurableObject } from "cloudflare:workers";
import type { ReportInput, ReportUpdate } from "@brutal-ai/schema";
import { type ReportFilter, ReportStore, type Sql } from "./reports";

/**
 * One Durable Object per project, holding that project's reports in its own SQLite, so one
 * account's data never shares a database with another's. The Worker reaches it only after
 * checking that the caller may (a key of this project, or its owner's session).
 */
export class Project extends DurableObject {
  private store: ReportStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    const handle: Sql = {
      all: <T>(query: string, ...params: unknown[]) =>
        sql.exec(query, ...params).toArray() as unknown as T[],
      run: (query: string, ...params: unknown[]) => {
        sql.exec(query, ...params);
      },
    };
    this.store = new ReportStore(handle);
  }

  insert(input: ReportInput, keyId: string | null) {
    return this.store.insert(input, keyId);
  }

  get(id: string) {
    return this.store.get(id);
  }

  list(filter: ReportFilter = {}) {
    return this.store.list(filter);
  }

  update(id: string, update: ReportUpdate) {
    return this.store.update(id, update);
  }
}
