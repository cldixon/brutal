#!/usr/bin/env bun
/**
 * The operator's commands for the hosted app's accounts database (D1 `brutal-accounts`), through
 * the `cf` CLI and its sign-in. Sign-up is invite-only in production (Tempra's way in).
 *
 *   bun run admin invite --email <email>     lets an email sign up (not emailed: tell them)
 *   bun run admin uninvite --email <email>   withdraws an invite (an account stays)
 *   bun run admin waitlist                   invites and the waitlist, newest first
 *   bun run admin users                      accounts, newest first
 */
import { $ } from "bun";

const DATABASE = "brutal-accounts";
const [command, ...rest] = process.argv.slice(2);
process.env.CF_SEND_TELEMETRY ??= "false";

const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};

async function databaseId(): Promise<string> {
  const out = (await $`bunx cf d1 list`.quiet()).stdout.toString();
  const start = out.indexOf("[");
  const list = JSON.parse(start === -1 ? "[]" : out.slice(start)) as {
    uuid: string;
    name: string;
  }[];
  const db = list.find((d) => d.name === DATABASE);
  if (!db) throw new Error(`No D1 database named ${DATABASE} on this account (deploy first).`);
  return db.uuid;
}

/** Runs one statement with bound parameters; returns its rows. */
async function query<T>(sql: string, params: string[] = []): Promise<T[]> {
  const id = await databaseId();
  const args = params.flatMap((p) => ["--params", p]);
  const out = (await $`bunx cf d1 query ${id} --sql ${sql} ${args}`.quiet()).stdout.toString();
  const start = out.indexOf("[");
  const parsed = JSON.parse(start === -1 ? "[]" : out.slice(start)) as { results?: T[] }[];
  return parsed[0]?.results ?? [];
}

function email(): string {
  const value = flag("--email")?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    console.error("Give an email: --email someone@example.com");
    process.exit(1);
  }
  return value;
}

switch (command) {
  case "invite": {
    const e = email();
    await query("INSERT OR IGNORE INTO invites (email, created_at) VALUES (?, ?)", [
      e,
      new Date().toISOString(),
    ]);
    console.log(`${e} is invited. They aren't emailed: tell them to sign in at thatsbrutal.fyi.`);
    break;
  }
  case "uninvite": {
    const e = email();
    await query("DELETE FROM invites WHERE email = ?", [e]);
    console.log(`${e} is no longer invited (an account, if they made one, stays).`);
    break;
  }
  case "waitlist": {
    for (const r of await query<{ email: string; created_at: string }>(
      "SELECT email, created_at FROM invites ORDER BY created_at DESC",
    )) {
      console.log(`invited  ${r.created_at}  ${r.email}`);
    }
    for (const r of await query<{ email: string; created_at: string }>(
      `SELECT email, created_at FROM waitlist WHERE email NOT IN (SELECT email FROM invites)
       ORDER BY created_at DESC`,
    )) {
      console.log(`waiting  ${r.created_at}  ${r.email}`);
    }
    break;
  }
  case "users": {
    for (const r of await query<{ email: string; created_at: string }>(
      "SELECT email, created_at FROM users ORDER BY created_at DESC",
    )) {
      console.log(`${r.created_at}  ${r.email}`);
    }
    break;
  }
  default:
    console.log("Usage: bun run admin <invite|uninvite|waitlist|users> [--email <email>]");
    process.exit(command ? 1 : 0);
}
