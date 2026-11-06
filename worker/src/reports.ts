import type { Context, Report, ReportInput, ReportUpdate, Status } from "@brutal-ai/schema";

/**
 * One project's reports, in its own SQLite: the Project Durable Object's storage in production,
 * bun:sqlite in tests. Synchronous throughout, as the DO's SQL API is. Free of Worker APIs.
 */

/** The little of a SQLite handle this needs. */
export interface Sql {
  all<T>(sql: string, ...params: unknown[]): T[];
  run(sql: string, ...params: unknown[]): void;
}

/** A schema change. Never edit or reorder one that has shipped; add a new one. */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT,
      tool_name TEXT,
      impact TEXT,
      user_impact TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      issue_url TEXT,
      -- The integration's context as JSON; the fields people filter on are copied out.
      context TEXT NOT NULL DEFAULT '{}',
      conversation_id TEXT,
      agent_name TEXT,
      app_version TEXT,
      branch TEXT,
      environment TEXT,
      key_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    "CREATE INDEX reports_kind ON reports (kind, id)",
    "CREATE INDEX reports_status ON reports (status, id)",
    "CREATE INDEX reports_tool ON reports (tool_name, id)",
  ],
];

let lastMs = 0;

/** Sortable ids: a millisecond timestamp (bumped so ids never tie), then randomness. */
export function newId(prefix: string): string {
  lastMs = Math.max(Date.now(), lastMs + 1);
  const rand = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${lastMs.toString(36).padStart(9, "0")}${Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface Row {
  id: string;
  kind: Report["kind"];
  title: string;
  summary: string;
  details: string | null;
  tool_name: string | null;
  impact: Report["impact"] | null;
  user_impact: string | null;
  status: Status;
  issue_url: string | null;
  context: string;
  created_at: string;
  updated_at: string;
}

function toReport(row: Row): Report {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    details: row.details ?? undefined,
    tool_name: row.tool_name ?? undefined,
    impact: row.impact ?? undefined,
    user_impact: row.user_impact ?? undefined,
    status: row.status,
    issue_url: row.issue_url,
    context: JSON.parse(row.context) as Context,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ReportFilter {
  kind?: string;
  status?: string;
  tool_name?: string;
  impact?: string;
  agent_name?: string;
  app_version?: string;
  branch?: string;
  /** Only reports older than this report id (the next page's cursor). */
  before?: string;
  limit?: number;
}

const FILTER_COLUMNS = [
  "kind",
  "status",
  "tool_name",
  "impact",
  "agent_name",
  "app_version",
  "branch",
] as const;

export interface ReportPage {
  reports: Report[];
  next: string | null;
}

export class ReportStore {
  constructor(private sql: Sql) {
    this.sql.run("CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)");
    const row = this.sql.all<{ version: number }>("SELECT version FROM _schema")[0];
    let version = row?.version ?? 0;
    if (!row) this.sql.run("INSERT INTO _schema (version) VALUES (0)");
    for (; version < MIGRATIONS.length; version++) {
      for (const statement of MIGRATIONS[version] ?? []) this.sql.run(statement);
      this.sql.run("UPDATE _schema SET version = ?", version + 1);
    }
  }

  insert(input: ReportInput, keyId: string | null): Report {
    const id = newId("rep");
    const now = new Date().toISOString();
    const ctx = input.context ?? {};
    this.sql.run(
      `INSERT INTO reports (id, kind, title, summary, details, tool_name, impact, user_impact,
        context, conversation_id, agent_name, app_version, branch, environment, key_id,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.title,
      input.summary,
      input.details ?? null,
      input.tool_name ?? null,
      input.impact ?? null,
      input.user_impact ?? null,
      JSON.stringify(ctx),
      ctx.conversation_id ?? null,
      ctx.agent_name ?? null,
      ctx.app_version ?? null,
      ctx.branch ?? null,
      ctx.environment ?? null,
      keyId,
      now,
      now,
    );
    const report = this.get(id);
    if (!report) throw new Error("report vanished after insert");
    return report;
  }

  get(id: string): Report | null {
    const row = this.sql.all<Row>("SELECT * FROM reports WHERE id = ?", id)[0];
    return row ? toReport(row) : null;
  }

  /** Newest first. `next` is the cursor for the following page, null on the last. */
  list(filter: ReportFilter = {}): ReportPage {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const col of FILTER_COLUMNS) {
      const value = filter[col];
      if (value) {
        where.push(`${col} = ?`);
        args.push(value);
      }
    }
    if (filter.before) {
      where.push("id < ?");
      args.push(filter.before);
    }
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    const rows = this.sql.all<Row>(
      `SELECT * FROM reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT ?`,
      ...args,
      limit + 1,
    );
    const page = rows.slice(0, limit).map(toReport);
    return { reports: page, next: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
  }

  update(id: string, update: ReportUpdate): Report | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (update.status !== undefined) {
      sets.push("status = ?");
      args.push(update.status);
    }
    if (update.issue_url !== undefined) {
      sets.push("issue_url = ?");
      args.push(update.issue_url);
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      args.push(new Date().toISOString());
      this.sql.run(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`, ...args, id);
    }
    return this.get(id);
  }
}

/** What the app asks of a project's reports: the store's methods, asynchronous (DO RPC). */
export interface ProjectReports {
  insert(input: ReportInput, keyId: string | null): Promise<Report>;
  get(id: string): Promise<Report | null>;
  list(filter?: ReportFilter): Promise<ReportPage>;
  update(id: string, update: ReportUpdate): Promise<Report | null>;
}
