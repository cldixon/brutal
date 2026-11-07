import { DurableObject } from "cloudflare:workers";
import type { ReportInput, ReportUpdate } from "@brutal-ai/schema";
import { type ReportFilter, ReportStore, type Sql } from "./reports";

const DAY_MS = 86_400_000;

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

  delete(id: string) {
    return this.store.delete(id);
  }

  deleteConversation(conversationId: string) {
    return this.store.deleteConversation(conversationId);
  }

  retention() {
    return this.store.retention();
  }

  /** Sets the retention; with one, a daily alarm prunes older reports, and without, none runs. */
  async setRetention(days: number | null) {
    const set = this.store.setRetention(days);
    if (set === null) await this.ctx.storage.deleteAlarm();
    else if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
    return set;
  }

  /** The daily prune: reports past the retention go, and the next run is armed while it's set. */
  async alarm() {
    const now = Date.now();
    const pruned = this.store.prune(now);
    if (pruned) console.log(`brutal: pruned ${pruned} reports past retention`);
    if (this.store.retention() !== null) await this.ctx.storage.setAlarm(now + DAY_MS);
  }
}
