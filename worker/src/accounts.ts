/**
 * The account layer in D1: people, sign-in codes, sessions, projects and their keys. Each
 * project's reports live in its own Durable Object (src/project.ts), never here. Every query
 * about a project is scoped to its owner. Adapted from Tempra (cldixon/tempra, worker/src).
 */

type Migration = { name: string; statements: string[] };

/** Never edit or reorder one that has shipped; add a new one. One statement per entry. */
const MIGRATIONS: Migration[] = [
  {
    name: "0001_accounts",
    statements: [
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`,
      // One live code per email; the code's hash is bound to the email it went to.
      `CREATE TABLE signin_codes (
        email TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE sessions (
        hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      "CREATE INDEX sessions_user ON sessions (user_id)",
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX projects_owner ON projects (owner_id, created_at)",
      `CREATE TABLE keys (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ingest', 'read')),
        name TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX keys_project ON keys (project_id)",
    ],
  },
  {
    // Invite-only sign-up, as Tempra: who may sign up, and who asked without an invite.
    name: "0002_invites_waitlist",
    statements: [
      "CREATE TABLE invites (email TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
      // decision: null while waiting, then 'invited' or 'dismissed' (the operator's call).
      `CREATE TABLE waitlist (
        email TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        decision TEXT,
        decided_at TEXT
      )`,
    ],
  },
];

/**
 * Brings the database up to date. Each migration is one batch that starts by recording its own
 * name, so if two isolates race, the loser's batch fails and rolls back.
 */
async function migrate(db: D1Database): Promise<void> {
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
      if (!row) throw error;
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

// --- Crypto helpers ---------------------------------------------------------------------------

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomHex(10)}`;
}

const now = () => new Date().toISOString();

// --- People and sign-in codes -----------------------------------------------------------------

export interface User {
  id: string;
  email: string;
}

export const CODE_MINUTES = 15;
export const CODE_TRIES = 5;
/** A new code for the same email waits this long after the last one. */
export const CODE_RESEND_SECONDS = 30;

/** Crockford's base32: no I, L, O or U, so nothing reads as another (Tempra's codes). */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

export function newCode(): string {
  // 32 divides 256, so a byte's low five bits are uniform.
  return Array.from(
    crypto.getRandomValues(new Uint8Array(CODE_LENGTH)),
    (b) => CODE_ALPHABET[b & 31],
  ).join("");
}

/** A code as typed: any case, dashes or spaces; O reads as 0, I and L as 1. Null if it can't be one. */
export function normalizeCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? code : null;
}

const codeHash = (email: string, code: string) => sha256(`${email}\n${code}`);

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Makes a sign-in code for `email`, replacing any earlier one. Null when one was made too
 * recently (the caller says to wait), so a script cannot mail someone repeatedly.
 */
export async function issueCode(db: D1Database, email: string): Promise<string | null> {
  const last = await db
    .prepare("SELECT created_at FROM signin_codes WHERE email = ?")
    .bind(email)
    .first<{ created_at: string }>();
  if (last && Date.now() - Date.parse(last.created_at) < CODE_RESEND_SECONDS * 1000) return null;
  const code = newCode();
  await db
    .prepare(
      `INSERT INTO signin_codes (email, code_hash, tries, created_at, expires_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, tries = 0,
         created_at = excluded.created_at, expires_at = excluded.expires_at`,
    )
    .bind(
      email,
      await codeHash(email, code),
      now(),
      new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
    )
    .run();
  return code;
}

export type CodeCheck = { ok: true; user: User } | { ok: false; why: "wrong" | "expired" };

/**
 * Uses a code: right, unexpired and within its tries, it is consumed and the person's account is
 * found or made. A wrong code counts a try; the last try or an expired code removes it.
 */
export async function useCode(db: D1Database, email: string, typed: string): Promise<CodeCheck> {
  const row = await db
    .prepare("SELECT code_hash, tries, expires_at FROM signin_codes WHERE email = ?")
    .bind(email)
    .first<{ code_hash: string; tries: number; expires_at: string }>();
  if (!row || Date.parse(row.expires_at) < Date.now() || row.tries >= CODE_TRIES) {
    if (row) await db.prepare("DELETE FROM signin_codes WHERE email = ?").bind(email).run();
    return { ok: false, why: "expired" };
  }
  const code = normalizeCode(typed);
  if (!code || (await codeHash(email, code)) !== row.code_hash) {
    await db.prepare("UPDATE signin_codes SET tries = tries + 1 WHERE email = ?").bind(email).run();
    return { ok: false, why: "wrong" };
  }
  await db.prepare("DELETE FROM signin_codes WHERE email = ?").bind(email).run();
  let user = await db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email)
    .first<User>();
  if (!user) {
    user = { id: newId("usr"), email };
    await db
      .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind(user.id, email, now())
      .run();
  }
  return { ok: true, user };
}

// --- Invites and the waitlist ----------------------------------------------------------------

/** Whether `email` may get a sign-in code under invite-only sign-up: an account, or an invite. */
export async function mayGetCode(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM users WHERE email = ?1
       UNION SELECT 1 FROM invites WHERE email = ?1 LIMIT 1`,
    )
    .bind(email)
    .first();
  return row !== null;
}

/** Puts `email` on the waitlist; true the first time, so it is told (and the operator) once. */
export async function joinWaitlist(db: D1Database, email: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)")
    .bind(email, now())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** What the operator's admin page shows: who waits, who's invited, who has an account. */
export interface AdminView {
  waitlist: { email: string; created_at: string }[];
  invites: { email: string; created_at: string; signed_up: number }[];
  users: { email: string; created_at: string; projects: number }[];
}

export async function adminView(db: D1Database): Promise<AdminView> {
  const [waitlist, invites, users] = await db.batch([
    db.prepare(
      "SELECT email, created_at FROM waitlist WHERE decision IS NULL ORDER BY created_at DESC",
    ),
    db.prepare(
      `SELECT invites.email AS email, invites.created_at AS created_at,
         EXISTS (SELECT 1 FROM users WHERE users.email = invites.email) AS signed_up
       FROM invites ORDER BY invites.created_at DESC`,
    ),
    db.prepare(
      `SELECT users.email AS email, users.created_at AS created_at,
         (SELECT COUNT(*) FROM projects WHERE projects.owner_id = users.id) AS projects
       FROM users ORDER BY users.created_at DESC`,
    ),
  ]);
  return {
    waitlist: (waitlist?.results ?? []) as AdminView["waitlist"],
    invites: (invites?.results ?? []) as AdminView["invites"],
    users: (users?.results ?? []) as AdminView["users"],
  };
}

/** Invites `email` (and closes its waitlist entry); true when it wasn't invited already. */
export async function invite(db: D1Database, email: string): Promise<boolean> {
  const [added] = await db.batch([
    db.prepare("INSERT OR IGNORE INTO invites (email, created_at) VALUES (?, ?)").bind(email, now()),
    db
      .prepare(
        "UPDATE waitlist SET decision = 'invited', decided_at = ? WHERE email = ? AND decision IS NULL",
      )
      .bind(now(), email),
  ]);
  return (added?.meta.changes ?? 0) > 0;
}

/** Withdraws an invite; an account made with it stays. */
export async function uninvite(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM invites WHERE email = ?").bind(email).run();
}

/** Dismisses a waiting email: it leaves the list and is not invited. */
export async function dismiss(db: D1Database, email: string): Promise<void> {
  await db
    .prepare(
      "UPDATE waitlist SET decision = 'dismissed', decided_at = ? WHERE email = ? AND decision IS NULL",
    )
    .bind(now(), email)
    .run();
}

// --- Sessions ---------------------------------------------------------------------------------

export const SESSION_COOKIE = "__Host-brutal_session";
export const SESSION_DAYS = 30;

/** A new session for `userId`; returns the secret for the cookie (only its hash is stored). */
export async function newSession(db: D1Database, userId: string): Promise<string> {
  const secret = randomHex(32);
  await db
    .prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(
      await sha256(secret),
      userId,
      now(),
      new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
    )
    .run();
  return secret;
}

export async function sessionUser(db: D1Database, secret: string): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT users.id AS id, users.email AS email, sessions.expires_at AS expires_at
       FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.hash = ?`,
    )
    .bind(await sha256(secret))
    .first<User & { expires_at: string }>();
  if (!row || Date.parse(row.expires_at) < Date.now()) return null;
  return { id: row.id, email: row.email };
}

export async function endSession(db: D1Database, secret: string): Promise<void> {
  await db
    .prepare("DELETE FROM sessions WHERE hash = ?")
    .bind(await sha256(secret))
    .run();
}

// --- Projects and keys ------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export type KeyKind = "ingest" | "read";

export interface KeyInfo {
  id: string;
  kind: KeyKind;
  name: string;
  created_at: string;
}

/** A key as the API finds it from its secret: which project, and what it may do. */
export interface Key {
  id: string;
  kind: KeyKind;
  project_id: string;
}

export async function listProjects(db: D1Database, ownerId: string): Promise<Project[]> {
  const { results } = await db
    .prepare(
      "SELECT id, name, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(ownerId)
    .all<Project>();
  return results;
}

export async function createProject(
  db: D1Database,
  ownerId: string,
  name: string,
): Promise<Project> {
  const project = { id: newId("prj"), name, created_at: now() };
  await db
    .prepare("INSERT INTO projects (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(project.id, ownerId, name, project.created_at)
    .run();
  return project;
}

/** The project if `ownerId` owns it; null otherwise, so a stranger's request is a 404. */
export async function ownedProject(
  db: D1Database,
  ownerId: string,
  projectId: string,
): Promise<Project | null> {
  return db
    .prepare("SELECT id, name, created_at FROM projects WHERE id = ? AND owner_id = ?")
    .bind(projectId, ownerId)
    .first<Project>();
}

const PREFIX: Record<KeyKind, string> = { ingest: "brutal_ingest_", read: "brutal_read_" };

/** A new key for a project; returns the secret, shown once (only its hash is stored). */
export async function createKey(
  db: D1Database,
  projectId: string,
  kind: KeyKind,
  name: string,
): Promise<{ key: KeyInfo; secret: string }> {
  const secret = PREFIX[kind] + randomHex(24);
  const key = { id: newId("key"), kind, name, created_at: now() };
  await db
    .prepare(
      "INSERT INTO keys (id, project_id, kind, name, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(key.id, projectId, kind, name, await sha256(secret), key.created_at)
    .run();
  return { key, secret };
}

export async function listKeys(db: D1Database, projectId: string): Promise<KeyInfo[]> {
  const { results } = await db
    .prepare("SELECT id, kind, name, created_at FROM keys WHERE project_id = ? ORDER BY created_at")
    .bind(projectId)
    .all<KeyInfo>();
  return results;
}

/** Revokes a key of this project; false when it has no such key. */
export async function revokeKey(
  db: D1Database,
  projectId: string,
  keyId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM keys WHERE id = ? AND project_id = ?")
    .bind(keyId, projectId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function findKey(db: D1Database, secret: string): Promise<Key | null> {
  if (!secret.startsWith("brutal_")) return null;
  return db
    .prepare("SELECT id, kind, project_id FROM keys WHERE hash = ?")
    .bind(await sha256(secret))
    .first<Key>();
}

/** The secret from `Authorization: Bearer …`. */
export function bearer(header: string | null | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}
