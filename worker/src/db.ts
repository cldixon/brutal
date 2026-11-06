import type { Context, Report, ReportInput, ReportUpdate, Status } from "@brutal/schema";

/**
 * A schema change. Never edit or reorder one that has shipped; add a new one. One SQL statement
 * per entry (D1 prepares statements one at a time).
 */
type Migration = { name: string; statements: string[] };

const MIGRATIONS: Migration[] = [
  {
    name: "0001_reports_and_keys",
    statements: [
      `CREATE TABLE keys (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('ingest', 'read')),
        hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`,
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
      "CREATE INDEX reports_created ON reports (created_at DESC)",
      "CREATE INDEX reports_kind ON reports (kind, created_at DESC)",
      "CREATE INDEX reports_status ON reports (status, created_at DESC)",
      "CREATE INDEX reports_tool ON reports (tool_name, created_at DESC)",
    ],
  },
  {
    // The setup code and the one-time claim (src/setup.ts).
    name: "0002_settings",
    statements: ["CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"],
  },
];

/**
 * Brings the database up to date. Each migration is one batch (a transaction) that starts by
 * recording its own name, so if two isolates race, the loser's batch fails and rolls back.
 */
export async function migrate(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .run();
  const { results } = await db.prepare("SELECT name FROM _migrations").all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    try {
      await db.batch([
        db
          .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
          .bind(m.name, new Date().toISOString()),
        ...m.statements.map((sql) => db.prepare(sql)),
      ]);
    } catch (error) {
      const row = await db.prepare("SELECT 1 FROM _migrations WHERE name = ?").bind(m.name).first();
      if (!row) throw error; // Anything but another isolate winning the race is a real failure.
    }
  }
}

const ready = new WeakMap<D1Database, Promise<void>>();

/** The migrated database, once per isolate; a failed attempt is forgotten so the next retries. */
export function migrated(db: D1Database): Promise<D1Database> {
  let done = ready.get(db);
  if (!done) {
    done = migrate(db).catch((error) => {
      ready.delete(db);
      throw error;
    });
    ready.set(db, done);
  }
  return done.then(() => db);
}

let lastMs = 0;

/** Sortable ids: a millisecond timestamp (bumped so ids from one isolate never tie), then randomness. */
export function newId(prefix: string): string {
  lastMs = Math.max(Date.now(), lastMs + 1);
  const time = lastMs.toString(36).padStart(9, "0");
  const rand = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${time}${Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface ReportRow {
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

function toReport(row: ReportRow): Report {
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

export async function insertReport(
  db: D1Database,
  input: ReportInput,
  keyId: string | null,
): Promise<Report> {
  const id = newId("rep");
  const now = new Date().toISOString();
  const ctx = input.context ?? {};
  await db
    .prepare(
      `INSERT INTO reports (id, kind, title, summary, details, tool_name, impact, user_impact,
        context, conversation_id, agent_name, app_version, branch, environment, key_id,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
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
    )
    .run();
  const report = await getReport(db, id);
  if (!report) throw new Error("report vanished after insert");
  return report;
}

export async function getReport(db: D1Database, id: string): Promise<Report | null> {
  const row = await db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
  return row ? toReport(row) : null;
}

export interface ReportFilter {
  kind?: string;
  status?: string;
  tool_name?: string;
  impact?: string;
  agent_name?: string;
  app_version?: string;
  branch?: string;
  /** Only reports created before this report id (the next page's cursor). */
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

/** Newest first. `next` is the cursor for the following page, null on the last. */
export async function listReports(
  db: D1Database,
  filter: ReportFilter = {},
): Promise<{ reports: Report[]; next: string | null }> {
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
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const sql = `SELECT * FROM reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...args, limit + 1)
    .all<ReportRow>();
  const page = results.slice(0, limit).map(toReport);
  return { reports: page, next: results.length > limit ? (page.at(-1)?.id ?? null) : null };
}

export async function updateReport(
  db: D1Database,
  id: string,
  update: ReportUpdate,
): Promise<Report | null> {
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
    await db
      .prepare(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...args, id)
      .run();
  }
  return getReport(db, id);
}
