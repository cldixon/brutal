#!/usr/bin/env bun
/**
 * CI's Cloudflare token (`CLOUDFLARE_API_TOKEN`, repo secret), as code: the permissions below are
 * exactly what `.github/workflows/ci.yml` deploys with (three Workers with custom domains, D1, KV,
 * Durable Objects, service bindings, the send_email binding, and Cloudflare Access for the portal
 * through admin/scripts/deploy.ts). A change to them is a change to this file, in a PR.
 *
 *   bun run token:ci              create the token, set the secret, delete the one it replaces
 *   bun run token:ci --dry-run    print the policy it would request; changes nothing
 *   bun run token:ci --repo owner/name
 *
 * The token is account-owned (not tied to a person), named NAME, expires in EXPIRY_DAYS, and goes
 * from cf's output straight into `gh secret set`'s stdin: never printed, never written to disk.
 * Running it again rotates: a new token, the secret set to it, then every older token named NAME
 * deleted. Permission groups are looked up by name with cf, so this file reads as names.
 *
 * Needs, to run for real: cf signed in with a credential that may create account tokens
 * (CLOUDFLARE_API_TOKEN with "Account API Tokens: Edit", from a Super Administrator; cf's OAuth
 * login has no scope for it), and gh signed in with access to the repo's secrets.
 */
import { join } from "node:path";
import { DEPLOYMENT } from "../deploy.config";

const NAME = "brutal-ci";
const EXPIRY_DAYS = 90;
const SECRET = "CLOUDFLARE_API_TOKEN";

/** Account-wide permissions. */
const ACCOUNT_PERMISSIONS = [
  // Upload and configure the three Workers: scripts, static assets, Durable Objects, service
  // bindings, the send_email binding, secrets (OPERATOR_EMAIL), custom-domain attachment.
  "Workers Scripts Write",
  // The accounts database (brutal-accounts): cf resolves or creates it on deploy.
  "D1 Write",
  // OAUTH_KV: cf resolves or creates the namespace on deploy.
  "Workers KV Storage Write",
  // admin/scripts/access.ts: the application and its reusable policy.
  "Access: Apps and Policies Write",
  // admin/scripts/access.ts: the organization (team domain) and the one-time PIN login.
  "Access: Organizations, Identity Providers, and Groups Write",
  // Reading the account itself (cf and admin/scripts/deploy.ts list /accounts).
  "Account Settings Read",
];

/**
 * Permissions on the app's zone alone (never all zones): the custom domains (the app, feedback,
 * review and admin hosts) are Workers routes with DNS records cf creates.
 */
const ZONE_PERMISSIONS = ["Workers Routes Write", "DNS Write"];

const ACCOUNT_SCOPE = "com.cloudflare.api.account";
const ZONE_SCOPE = "com.cloudflare.api.account.zone";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const repoAt = args.indexOf("--repo");
const repo = repoAt === -1 ? "cldixon/brutal" : (args[repoAt + 1] ?? "");
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail("Give the repository as --repo owner/name.");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The zone: the app's host, which every other host is under. */
const zoneName: string = DEPLOYMENT.app.host;
for (const host of [DEPLOYMENT.feedback.host, DEPLOYMENT.review.host, DEPLOYMENT.admin.host]) {
  if (host !== zoneName && !host.endsWith(`.${zoneName}`))
    fail(`${host} is not on the zone ${zoneName}; the token covers that zone only.`);
}

const WORKER_DIR = join(import.meta.dir, "..", "worker");

/**
 * Runs cf (pinned in worker/) and returns its stdout parsed as JSON. stdout is never echoed: for
 * `tokens create` it holds the token. On failure only stderr is shown.
 */
async function cf<T>(argv: string[], env: Record<string, string> = {}): Promise<T> {
  const proc = Bun.spawn(["bunx", "cf", ...argv], {
    cwd: WORKER_DIR,
    env: { ...process.env, CF_SEND_TELEMETRY: "false", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) fail(`cf ${argv.slice(0, 3).join(" ")} failed (${code}):\n${err.trim()}`);
  try {
    return JSON.parse(out) as T;
  } catch {
    fail(`cf ${argv.slice(0, 3).join(" ")} gave no JSON.`);
  }
}

interface Zone {
  id: string;
  name: string;
  account: { id: string };
}
interface PermissionGroup {
  id: string;
  name: string;
  scopes: string[];
  is_selectable?: boolean;
}
interface Token {
  id: string;
  name: string;
  status?: string;
  expires_on?: string;
}
interface Policy {
  effect: "allow";
  resources: Record<string, string>;
  permission_groups: { id: string; name: string }[];
}

// The zone, and from it the account.
const zones = await cf<Zone[]>(["zones", "list", "--name", zoneName]);
const zone = zones.find((z) => z.name === zoneName);
if (!zone) fail(`No zone ${zoneName} reachable with the current credential.`);
const account = zone.account.id;
const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
if (envAccount && envAccount !== account)
  fail(`CLOUDFLARE_ACCOUNT_ID is ${envAccount}, but ${zoneName} is in account ${account}.`);
const inAccount = { CLOUDFLARE_ACCOUNT_ID: account };

// Permission groups, by name and scope (some names exist at both account and zone scope).
const groups = await cf<PermissionGroup[]>(
  ["accounts", "tokens", "permission-groups", "list"],
  inAccount,
);
function pick(names: string[], scope: string) {
  return names.map((name) => {
    const group = groups.find((g) => g.name === name && g.scopes.includes(scope));
    if (!group) fail(`No ${scope === ZONE_SCOPE ? "zone" : "account"} permission group "${name}".`);
    if (group.is_selectable === false)
      fail(`The current credential may not grant "${name}" (it lacks it itself).`);
    return { id: group.id, name: group.name };
  });
}

const policies: Policy[] = [
  {
    effect: "allow",
    resources: { [`${ACCOUNT_SCOPE}.${account}`]: "*" },
    permission_groups: pick(ACCOUNT_PERMISSIONS, ACCOUNT_SCOPE),
  },
  {
    effect: "allow",
    resources: { [`${ZONE_SCOPE}.${zone.id}`]: "*" },
    permission_groups: pick(ZONE_PERMISSIONS, ZONE_SCOPE),
  },
];
const expiresOn = new Date(Date.now() + EXPIRY_DAYS * 86_400_000)
  .toISOString()
  .replace(/\.\d{3}Z$/, "Z");

const existing = (
  await cf<Token[]>(["accounts", "tokens", "list", "--per-page", "100"], inAccount)
).filter((t) => t.name === NAME);

console.log(`Token "${NAME}", account-owned, account ${account}, expires ${expiresOn}`);
console.log("  account:");
for (const g of policies[0]?.permission_groups ?? []) console.log(`    ${g.name}`);
console.log(`  zone ${zone.name} only:`);
for (const g of policies[1]?.permission_groups ?? []) console.log(`    ${g.name}`);
console.log(`Then: gh secret set ${SECRET} --repo ${repo} (value through stdin only)`);
console.log(
  existing.length
    ? `Then: delete the ${existing.length} older token(s) named "${NAME}" (${existing.map((t) => t.id).join(", ")})`
    : `No older token named "${NAME}" to delete.`,
);

if (dryRun) {
  console.log("\nDry run: nothing created. The policies it would request:");
  console.log(JSON.stringify(policies, null, 2));
  process.exit(0);
}

// gh first, so a token is never made that can't be stored.
const ghStatus = Bun.spawn(["gh", "secret", "list", "--repo", repo], {
  stdout: "ignore",
  stderr: "pipe",
});
if ((await ghStatus.exited) !== 0)
  fail(
    `gh cannot reach ${repo}'s secrets:\n${(await new Response(ghStatus.stderr).text()).trim()}`,
  );

const created = await cf<{ id?: string; value?: string; result?: { id?: string; value?: string } }>(
  [
    "accounts",
    "tokens",
    "create",
    "--name",
    NAME,
    "--expires-on",
    expiresOn,
    "--policies",
    JSON.stringify(policies),
  ],
  inAccount,
);
const fresh = created.result ?? created;
if (!fresh.id || !fresh.value) fail("cf created no token value (nothing to store).");
console.log(`✓ created token ${fresh.id}`);

const gh = Bun.spawn(["gh", "secret", "set", SECRET, "--repo", repo], {
  stdin: "pipe",
  stdout: "ignore",
  stderr: "pipe",
});
gh.stdin.write(fresh.value);
await gh.stdin.end();
if ((await gh.exited) !== 0) {
  const err = (await new Response(gh.stderr).text()).trim();
  // Don't leave a token nobody holds.
  await cf(["accounts", "tokens", "delete", fresh.id, "--force"], inAccount);
  fail(`gh secret set failed, so the new token was deleted again:\n${err}`);
}
console.log(`✓ ${SECRET} set on ${repo}`);

for (const old of existing) {
  await cf(["accounts", "tokens", "delete", old.id, "--force"], inAccount);
  console.log(`✓ deleted the older token ${old.id}`);
}
