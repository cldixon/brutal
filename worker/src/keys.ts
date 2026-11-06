import { newId } from "./db";

/**
 * API keys. Ingest keys only submit reports, so they are safe in an app's backend; read keys
 * read and triage (the dashboard, the CLI, coding agents over MCP). Only a hash is stored.
 */
export type KeyKind = "ingest" | "read";
export interface Key {
  id: string;
  kind: KeyKind;
}

const PREFIX: Record<KeyKind, string> = { ingest: "brutal_ingest_", read: "brutal_read_" };

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** A new key: its secret (shown once) and the statement that stores its hash. */
export async function newKey(
  db: D1Database,
  kind: KeyKind,
): Promise<{ secret: string; insert: D1PreparedStatement }> {
  const secret = PREFIX[kind] + randomSecret();
  const insert = db
    .prepare("INSERT INTO keys (id, kind, hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(newId("key"), kind, await sha256(secret), new Date().toISOString());
  return { secret, insert };
}

export async function findKey(db: D1Database, secret: string): Promise<Key | null> {
  if (!secret.startsWith("brutal_")) return null;
  return db
    .prepare("SELECT id, kind FROM keys WHERE hash = ?")
    .bind(await sha256(secret))
    .first<Key>();
}

/** The secret from `Authorization: Bearer …`, or Basic auth's password (the dashboard). */
export function secretFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ", 2);
  if (!value) return null;
  if (scheme.toLowerCase() === "bearer") return value.trim();
  if (scheme.toLowerCase() === "basic") {
    try {
      const decoded = atob(value.trim());
      return decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      return null;
    }
  }
  return null;
}
