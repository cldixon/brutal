#!/usr/bin/env bun
/**
 * Deploys the operator's portal, after Tempra's (cldixon/tempra, admin/scripts/deploy.ts):
 *
 *   1. makes sure of Cloudflare Access for its host (scripts/access.ts): the one-time PIN login, a
 *      policy allowing only OPERATOR_EMAIL, and the application, with 2-hour sessions; stops if it
 *      cannot, so the portal is never deployed unguarded;
 *   2. `cf deploy`, with the Access team and audience tag the Worker checks tokens against;
 *   3. sets OPERATOR_EMAIL as a secret on the portal and on the app (whose Operator entrypoint
 *      checks it again, and which lets it sign in).
 *
 *   OPERATOR_EMAIL=… bun run deploy [--dry-run]
 *
 * Needs CLOUDFLARE_API_TOKEN with "Access: Apps and Policies Write" and "Access: Organizations,
 * Identity Providers, and Groups Write" besides Workers. Deploy the app first.
 */
import { join } from "node:path";
import { DEPLOYMENT } from "../../deploy.config";
import { cloudflareApi, ensureAccess } from "./access";

const dryRun = process.argv.includes("--dry-run");
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const operator = (process.env.OPERATOR_EMAIL ?? "").trim().toLowerCase();
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is needed.");
if (!operator) throw new Error("OPERATOR_EMAIL is needed: the one person Access lets in.");

/** The account: CLOUDFLARE_ACCOUNT_ID, else the one account the token can reach. */
async function accountId(): Promise<string> {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const r = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = ((await r.json()) as { result?: { id: string }[] }).result ?? [];
  if (accounts.length !== 1)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID: the token reaches several accounts.");
  return accounts[0]?.id ?? "";
}

const account = await accountId();
const { admin, app } = DEPLOYMENT;
let ensured: Awaited<ReturnType<typeof ensureAccess>>;
try {
  ensured = await ensureAccess(
    cloudflareApi(account, token),
    { name: admin.name, title: "Brutal admin", host: admin.host, operator, sessionDuration: "2h" },
    dryRun,
  );
} catch (e) {
  console.error(
    `Cloudflare Access for ${admin.host} could not be ensured, so nothing is deployed.`,
  );
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
console.log(
  ensured.changes.length
    ? `Access${dryRun ? " (dry run, would)" : ""}: ${ensured.changes.join("; ")}.`
    : "Access: as configured.",
);
for (const w of ensured.warnings) console.warn(`Access: ${w}.`);
if (!dryRun && !ensured.aud) {
  console.error("Access gave no audience tag for the application; nothing is deployed.");
  process.exit(1);
}

const code = await Bun.spawn(
  ["bunx", "cf", "deploy", "--mode", "production", ...(dryRun ? ["--dry-run"] : [])],
  {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      CF_SEND_TELEMETRY: "false",
      BRUTAL_ACCESS_TEAM: ensured.team,
      BRUTAL_ACCESS_AUD: ensured.aud,
    },
    stdout: "inherit",
    stderr: "inherit",
  },
).exited;
if (code !== 0 || dryRun) process.exit(code);

/** A secret on a Worker, through the API (the value only in the request body). */
async function secret(worker: string, name: string, text: string) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, text, type: "secret_text" }),
    },
  );
  if (!r.ok) throw new Error(`Setting ${name} on ${worker}: ${r.status} ${await r.text()}`);
  console.log(`✓ ${name} set on ${worker}`);
}
await secret(admin.name, "OPERATOR_EMAIL", operator);
await secret(app.name, "OPERATOR_EMAIL", operator);
console.log(
  `\nThe portal is at https://${admin.host} (Cloudflare Access, a code mailed to ${operator}).`,
);
