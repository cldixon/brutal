/**
 * Cloudflare Access for an instance's dashboard: the one-time PIN login, one reusable allow policy
 * naming the owner's emails, and a self-hosted application over `<domain>/dashboard` only (the
 * API, MCP and setup stay reachable with keys). Created when missing, corrected when they differ,
 * never deleted; nothing else in the account is touched, and running it again changes nothing.
 * Adapted from Tempra's operator portal (cldixon/tempra, admin/scripts/access.ts); it goes through
 * the `cf` CLI, so it uses whatever sign-in cf has (`cf auth login`, or an API token).
 */

/** Runs one `cf zero-trust …` command, with an optional JSON body, and returns its JSON result. */
export type Cf = (args: string[], body?: unknown) => Promise<unknown>;

export interface Want {
  /** The custom domain the dashboard is served on. */
  host: string;
  /** The Worker's name, which names the policy so several instances can share an account. */
  worker: string;
  /** Who may sign in. */
  emails: string[];
  /** How long a sign-in lasts, e.g. "24h". */
  sessionDuration: string;
}

export interface Ensured {
  /** The Zero Trust team domain (the tokens' issuer). */
  team: string;
  /** The application's audience tag, or "" when a dry run would create it. */
  aud: string;
  /** What was (or, in a dry run, would be) done. */
  changes: string[];
}

interface Idp {
  id: string;
  type: string;
}
interface Policy {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
}
interface App {
  id: string;
  name: string;
  domain: string;
  aud: string;
  type: string;
  session_duration?: string;
  allowed_idps?: string[];
  auto_redirect_to_identity?: boolean;
  policies?: { id: string }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function ensureAccess(cf: Cf, want: Want, dryRun = false): Promise<Ensured> {
  const emails = [...new Set(want.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0 || emails.some((e) => !e.includes("@"))) {
    throw new Error("Access needs at least one email address to let in.");
  }
  const changes: string[] = [];

  const org = (await cf(["organization", "get"])) as { auth_domain?: string } | null;
  const team = org?.auth_domain ?? "";
  if (!team) {
    throw new Error(
      "This Cloudflare account has no Zero Trust organization yet. Open Zero Trust in the " +
        "Cloudflare dashboard once to create one (the Free plan is enough), then run this again.",
    );
  }

  // The one-time PIN login: a code mailed to the person signing in.
  const idps = ((await cf(["identity-providers", "list"])) ?? []) as Idp[];
  let otp = idps.find((i) => i.type === "onetimepin");
  if (!otp) {
    changes.push("create the one-time PIN login");
    otp = dryRun
      ? { id: "(new)", type: "onetimepin" }
      : ((await cf(["identity-providers", "create"], {
          name: "One-time PIN",
          type: "onetimepin",
          config: {},
        })) as Idp);
  }

  // One reusable policy: allow the owner's emails, nobody else.
  const policyName = `Brutal ${want.worker}: owners`;
  const policyBody = {
    name: policyName,
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
    exclude: [],
    require: [],
  };
  const policies = ((await cf(["access", "policies", "list"])) ?? []) as Policy[];
  let policy = policies.find((p) => p.name === policyName);
  if (!policy) {
    changes.push(`create the policy "${policyName}" (allow ${emails.join(", ")})`);
    policy = dryRun
      ? { id: "(new)", ...policyBody }
      : ((await cf(["access", "policies", "create"], policyBody)) as Policy);
  } else if (policy.decision !== "allow" || !same(policy.include, policyBody.include)) {
    changes.push(`correct the policy "${policyName}" (allow ${emails.join(", ")} only)`);
    if (!dryRun) {
      policy = (await cf(["access", "policies", "update", policy.id], policyBody)) as Policy;
    }
  }

  // The application over the dashboard's path only.
  const domain = `${want.host}/dashboard`;
  const title = `Brutal (${want.host})`;
  const appBody = {
    name: title,
    domain,
    type: "self_hosted",
    session_duration: want.sessionDuration,
    allowed_idps: [otp.id],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    policies: [{ id: policy.id, precedence: 1 }],
  };
  const apps = ((await cf(["access", "applications", "list"])) ?? []) as App[];
  let app = apps.find((a) => a.domain === domain);
  if (!app) {
    changes.push(`create the application for ${domain} (${want.sessionDuration} sessions)`);
    if (!dryRun) app = (await cf(["access", "applications", "create"], appBody)) as App;
  } else if (
    app.name !== title ||
    app.type !== "self_hosted" ||
    app.session_duration !== want.sessionDuration ||
    !same(app.allowed_idps, [otp.id]) ||
    app.auto_redirect_to_identity !== true ||
    !same(
      (app.policies ?? []).map((p) => p.id),
      [policy.id],
    )
  ) {
    changes.push(`correct the application for ${domain}`);
    if (!dryRun) app = (await cf(["access", "applications", "update", app.id], appBody)) as App;
  }
  return { team, aud: app?.aud ?? "", changes };
}

/**
 * The JSON in cf's output. A list prints a `result_info: …` line before its JSON, so this reads
 * from the first line that opens an array or object.
 */
export function parseCfJson(stdout: string): unknown {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.startsWith("[") || l.startsWith("{"));
  if (start === -1) return null;
  return JSON.parse(lines.slice(start).join("\n"));
}
