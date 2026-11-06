import { newKey, sha256 } from "./keys";

/**
 * First run. A fresh instance has no keys; whoever presents the setup code gets the first ingest
 * and read keys, once. The code is the SETUP_CODE secret when the deployer set one, otherwise one
 * generated on first use and written only to the Worker's logs, which only the account that
 * deployed it can read.
 */

const CODE = "setup_code";
const CLAIMED = "setup_claimed_at";

async function setting(db: D1Database, key: string): Promise<string | null> {
  return db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<string>("value");
}

/** True once keys exist (a claim, or keys made before setup codes). */
export async function isClaimed(db: D1Database): Promise<boolean> {
  if (await setting(db, CLAIMED)) return true;
  return (await db.prepare("SELECT 1 FROM keys LIMIT 1").first()) !== null;
}

/** The setup code: the secret, or the stored one, made on first call (racing callers agree). */
export async function setupCode(db: D1Database, secret: string | undefined): Promise<string> {
  if (secret) return secret;
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const generated = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .bind(CODE, generated)
    .run();
  return (await setting(db, CODE)) ?? generated;
}

/** Writes the code to the Worker's logs while the instance is unclaimed and the code generated. */
export async function logSetupCode(db: D1Database, secret: string | undefined): Promise<void> {
  if (secret || (await isClaimed(db))) return;
  console.log(`brutal: this instance is unclaimed. Setup code: ${await setupCode(db, secret)}`);
}

/** Compares hashes, so the time taken says nothing about how much of the code was right. */
async function codeMatches(expected: string, given: string): Promise<boolean> {
  return (await sha256(expected)) === (await sha256(given.trim()));
}

export type ClaimResult =
  | { ok: true; ingest: string; read: string }
  | { ok: false; reason: "claimed" | "wrong_code" };

/**
 * Claims the instance with the setup code: one batch records the claim and stores both keys, so
 * of two racing claims the second fails on the claim's primary key and stores nothing.
 */
export async function claim(
  db: D1Database,
  secret: string | undefined,
  given: string,
): Promise<ClaimResult> {
  if (await isClaimed(db)) return { ok: false, reason: "claimed" };
  if (!(await codeMatches(await setupCode(db, secret), given))) {
    return { ok: false, reason: "wrong_code" };
  }
  const ingest = await newKey(db, "ingest");
  const read = await newKey(db, "read");
  try {
    await db.batch([
      db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .bind(CLAIMED, new Date().toISOString()),
      db.prepare("DELETE FROM settings WHERE key = ?").bind(CODE),
      ingest.insert,
      read.insert,
    ]);
  } catch {
    return { ok: false, reason: "claimed" };
  }
  return { ok: true, ingest: ingest.secret, read: read.secret };
}
