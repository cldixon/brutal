import type { Hono, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { newId, SESSION_COOKIE, sha256 } from "./accounts";
import type { AppEnv, Bindings, Deps, Fetch } from "./app";
import { issueContent } from "./issue-body";

/**
 * A person's connections to GitHub and Linear, made once and used across their projects to file
 * an issue from a report. Tokens are kept in D1 encrypted with AES-GCM under INTEGRATIONS_KEY and
 * never leave the Worker. Every call to a provider goes through `Deps.providerFetch`, so tests
 * run against fake servers.
 */

export type ProviderId = "github" | "linear";
export const PROVIDERS: ProviderId[] = ["github", "linear"];

/** Tokens as a provider hands them out; times as ISO strings, null when they don't expire. */
export interface Tokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
}

/** Where an issue can go: a GitHub repo (`owner/repo`) or a Linear team (its id). */
export interface Target {
  id: string;
  name: string;
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// --- Crypto -----------------------------------------------------------------------------------

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) =>
  b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** The AES-GCM key from INTEGRATIONS_KEY (base64 of 32 bytes); null when unset or malformed. */
export async function sealingKey(env: Bindings): Promise<CryptoKey | null> {
  if (!env.INTEGRATIONS_KEY) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = unb64(env.INTEGRATIONS_KEY.trim());
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts a token for one row: `v1.<iv>.<ciphertext>`, with the row's id as additional data, so
 * a sealed token copied into another row does not open.
 */
export async function seal(key: CryptoKey, plain: string, rowId: string): Promise<string> {
  const iv = random(12);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(rowId) },
    key,
    new TextEncoder().encode(plain),
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(sealed))}`;
}

export async function unseal(key: CryptoKey, sealed: string, rowId: string): Promise<string> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("Unknown sealed token format.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(rowId) },
    key,
    unb64(data),
  );
  return new TextDecoder().decode(plain);
}

/** PKCE (RFC 7636): a verifier and its S256 challenge. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(random(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

// --- Providers --------------------------------------------------------------------------------

interface Provider {
  name: string;
  /** Client id and secret are set on this deployment. */
  configured(env: Bindings): boolean;
  authorizeUrl(env: Bindings, a: { state: string; challenge: string; redirect: string }): string;
  exchange(
    f: Fetch,
    env: Bindings,
    a: { code: string; verifier: string; redirect: string },
  ): Promise<Tokens>;
  refresh(f: Fetch, env: Bindings, refreshToken: string): Promise<Tokens>;
  /** The connected account's login (GitHub) or workspace (Linear), to tell connections apart. */
  account(f: Fetch, token: string): Promise<string>;
  targets(f: Fetch, token: string): Promise<Target[]>;
  createIssue(
    f: Fetch,
    token: string,
    target: string,
    issue: { title: string; body: string },
  ): Promise<string>;
  /** Revokes at the provider; best effort. */
  revoke(
    f: Fetch,
    env: Bindings,
    tokens: { access: string; refresh: string | null },
  ): Promise<void>;
}

const inSeconds = (s: unknown) =>
  typeof s === "number" && s > 0 ? new Date(Date.now() + s * 1000).toISOString() : null;

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/** Reads a token endpoint's answer; GitHub answers 200 with `error` when it refuses. */
async function tokenResponse(res: Response, provider: string): Promise<Tokens> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    const why = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new IntegrationError(`${provider} refused the token request (${why}).`, 502);
  }
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expires_at: inSeconds(data.expires_in),
  };
}

const GITHUB_API = "https://api.github.com";
const githubHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Brutal",
});

async function githubGet<T>(f: Fetch, token: string, path: string): Promise<T> {
  const res = await f(`${GITHUB_API}${path}`, { headers: githubHeaders(token) });
  if (res.status === 401)
    throw new IntegrationError("Reconnect GitHub: it refused the token.", 409);
  if (!res.ok) throw new IntegrationError(`GitHub answered ${res.status}.`, 502);
  return (await res.json()) as T;
}

/** The label every issue Brutal files carries, made in the repo or team when it's missing. */
export const LABEL = {
  name: "Brutal",
  color: "000000",
  description: "Filed from an agent's report in Brutal",
};

/**
 * Makes sure the repo has the label; false when it can't (no push access, say), and the issue
 * is filed without it. Never fails the issue.
 */
async function githubLabel(f: Fetch, token: string, repo: string): Promise<boolean> {
  try {
    const headers = githubHeaders(token);
    const found = await f(`${GITHUB_API}/repos/${repo}/labels/${LABEL.name}`, { headers });
    if (found.ok) return true;
    if (found.status !== 404) return false;
    const made = await f(`${GITHUB_API}/repos/${repo}/labels`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(LABEL),
    });
    // 422: it exists after all (made meanwhile).
    return made.ok || made.status === 422;
  } catch {
    return false;
  }
}

/**
 * GitHub through a GitHub App's user access tokens: the token can reach only repos where the
 * app is installed and the person has access, with the app's permissions (Issues, Metadata).
 */
const github: Provider = {
  name: "GitHub",
  configured: (env) => Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET),
  authorizeUrl(env, a) {
    const q = new URLSearchParams({
      client_id: env.GITHUB_APP_CLIENT_ID ?? "",
      redirect_uri: a.redirect,
      state: a.state,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
    });
    return `https://github.com/login/oauth/authorize?${q}`;
  },
  async exchange(f, env, a) {
    const res = await f("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: env.GITHUB_APP_CLIENT_ID ?? "",
        client_secret: env.GITHUB_APP_CLIENT_SECRET ?? "",
        code: a.code,
        redirect_uri: a.redirect,
        code_verifier: a.verifier,
      }),
    });
    return tokenResponse(res, "GitHub");
  },
  async refresh(f, env, refreshToken) {
    const res = await f("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: env.GITHUB_APP_CLIENT_ID ?? "",
        client_secret: env.GITHUB_APP_CLIENT_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    return tokenResponse(res, "GitHub");
  },
  async account(f, token) {
    return (await githubGet<{ login: string }>(f, token, "/user")).login;
  },
  async targets(f, token) {
    const { installations } = await githubGet<{ installations: { id: number }[] }>(
      f,
      token,
      "/user/installations?per_page=100",
    );
    const repos: Target[] = [];
    for (const inst of installations.slice(0, 20)) {
      for (let page = 1; page <= 5; page++) {
        const { repositories } = await githubGet<{ repositories: { full_name: string }[] }>(
          f,
          token,
          `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
        );
        for (const r of repositories) repos.push({ id: r.full_name, name: r.full_name });
        if (repositories.length < 100) break;
      }
    }
    return repos.sort((a, b) => a.name.localeCompare(b.name));
  },
  async createIssue(f, token, target, issue) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(target)) {
      throw new IntegrationError("Pick a repository (owner/repo).", 400);
    }
    const labelled = await githubLabel(f, token, target);
    const res = await f(`${GITHUB_API}/repos/${target}/issues`, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(labelled ? { ...issue, labels: [LABEL.name] } : issue),
    });
    if (res.status === 401)
      throw new IntegrationError("Reconnect GitHub: it refused the token.", 409);
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new IntegrationError(
        `GitHub can't create issues in ${target} with this connection: install the app there, or check the repository has issues on.`,
        403,
      );
    }
    if (!res.ok) throw new IntegrationError(`GitHub answered ${res.status}.`, 502);
    return ((await res.json()) as { html_url: string }).html_url;
  },
  async revoke(f, env, tokens) {
    // Deletes the app's authorization for the person (all its tokens); the app stays installed.
    const id = env.GITHUB_APP_CLIENT_ID ?? "";
    await f(`${GITHUB_API}/applications/${id}/grant`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${btoa(`${id}:${env.GITHUB_APP_CLIENT_SECRET ?? ""}`)}`,
        "Content-Type": "application/json",
        "User-Agent": "Brutal",
      },
      body: JSON.stringify({ access_token: tokens.access }),
    });
  },
};

const LINEAR_SCOPES = "read,issues:create";

async function linearQuery<T>(
  f: Fetch,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await f("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401)
    throw new IntegrationError("Reconnect Linear: it refused the token.", 409);
  const data = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: { message: string; extensions?: { code?: string } }[];
  };
  const error = data.errors?.[0];
  if (error?.extensions?.code === "AUTHENTICATION_ERROR") {
    throw new IntegrationError("Reconnect Linear: it refused the token.", 409);
  }
  if (!res.ok || error || !data.data) {
    throw new IntegrationError(`Linear refused: ${error?.message ?? `HTTP ${res.status}`}.`, 502);
  }
  return data.data;
}

/**
 * The id of a "Brutal" label the team can use (the workspace's or the team's own), made in the
 * team when there's none; null when Linear won't, and the issue is filed without it.
 */
async function linearLabel(f: Fetch, token: string, teamId: string): Promise<string | null> {
  try {
    const found = await linearQuery<{
      issueLabels: { nodes: { id: string; team: { id: string } | null }[] };
    }>(
      f,
      token,
      "query ($name: String!) { issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) { nodes { id team { id } } } }",
      { name: LABEL.name },
    );
    const usable = found.issueLabels.nodes.find((l) => !l.team || l.team.id === teamId);
    if (usable) return usable.id;
    const made = await linearQuery<{
      issueLabelCreate: { success: boolean; issueLabel: { id: string } | null };
    }>(
      f,
      token,
      "mutation ($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }",
      {
        input: {
          name: LABEL.name,
          color: `#${LABEL.color}`,
          description: LABEL.description,
          teamId,
        },
      },
    );
    return made.issueLabelCreate.issueLabel?.id ?? null;
  } catch {
    return null;
  }
}

/** Linear through an OAuth2 app with `read` and `issues:create`, acting as the person. */
const linear: Provider = {
  name: "Linear",
  configured: (env) => Boolean(env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET),
  authorizeUrl(env, a) {
    const q = new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID ?? "",
      redirect_uri: a.redirect,
      response_type: "code",
      scope: LINEAR_SCOPES,
      state: a.state,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
    });
    return `https://linear.app/oauth/authorize?${q}`;
  },
  async exchange(f, env, a) {
    const res = await f("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: a.redirect,
        client_id: env.LINEAR_CLIENT_ID ?? "",
        client_secret: env.LINEAR_CLIENT_SECRET ?? "",
        code_verifier: a.verifier,
      }),
    });
    return tokenResponse(res, "Linear");
  },
  async refresh(f, env, refreshToken) {
    const res = await f("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: env.LINEAR_CLIENT_ID ?? "",
        client_secret: env.LINEAR_CLIENT_SECRET ?? "",
      }),
    });
    return tokenResponse(res, "Linear");
  },
  async account(f, token) {
    const data = await linearQuery<{ organization: { name: string } }>(
      f,
      token,
      "query { organization { name } }",
    );
    return data.organization.name;
  },
  async targets(f, token) {
    const data = await linearQuery<{
      teams: { nodes: { id: string; name: string; key: string }[] };
    }>(f, token, "query { teams(first: 250) { nodes { id name key } } }");
    return data.teams.nodes
      .map((t) => ({ id: t.id, name: `${t.name} (${t.key})` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  async createIssue(f, token, target, issue) {
    const labelId = await linearLabel(f, token, target);
    const data = await linearQuery<{
      issueCreate: { success: boolean; issue: { url: string } | null };
    }>(
      f,
      token,
      "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { url } } }",
      {
        input: {
          teamId: target,
          title: issue.title,
          description: issue.body,
          ...(labelId ? { labelIds: [labelId] } : {}),
        },
      },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new IntegrationError("Linear didn't create the issue.", 502);
    }
    return data.issueCreate.issue.url;
  },
  async revoke(f, _env, tokens) {
    await f("https://api.linear.app/oauth/revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form({ token: tokens.access, token_type_hint: "access_token" }),
    });
  },
};

const PROVIDER: Record<ProviderId, Provider> = { github, linear };
const isProvider = (p: string): p is ProviderId => (PROVIDERS as string[]).includes(p);

// --- Storage ----------------------------------------------------------------------------------

/** How long a connect attempt's state lives. */
export const STATE_MINUTES = 10;
/** Tokens this close to expiry are refreshed before use. */
const REFRESH_EARLY_MS = 5 * 60_000;

interface Row {
  id: string;
  user_id: string;
  provider: ProviderId;
  account: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  created_at: string;
}

/** A connection as the browser sees it: no tokens. */
export interface IntegrationInfo {
  id: string;
  provider: ProviderId;
  account: string;
  created_at: string;
}

const info = (r: Row): IntegrationInfo => ({
  id: r.id,
  provider: r.provider,
  account: r.account,
  created_at: r.created_at,
});

const now = () => new Date().toISOString();

async function findRow(db: D1Database, userId: string, id: string): Promise<Row | null> {
  return db
    .prepare("SELECT * FROM integrations WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<Row>();
}

/** Stores a connection's tokens, sealed; a reconnect of the same account replaces its tokens. */
async function saveConnection(
  db: D1Database,
  key: CryptoKey,
  userId: string,
  provider: ProviderId,
  account: string,
  tokens: Tokens,
): Promise<string> {
  const existing = await db
    .prepare("SELECT id FROM integrations WHERE user_id = ? AND provider = ? AND account = ?")
    .bind(userId, provider, account)
    .first<{ id: string }>();
  const id = existing?.id ?? newId("int");
  const access = await seal(key, tokens.access_token, id);
  const refresh = tokens.refresh_token ? await seal(key, tokens.refresh_token, id) : null;
  await db
    .prepare(
      `INSERT INTO integrations
         (id, user_id, provider, account, access_token, refresh_token, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(id, userId, provider, account, access, refresh, tokens.expires_at, now())
    .run();
  return id;
}

/** A usable access token for a connection, refreshed first when it is about to expire. */
export async function accessToken(
  db: D1Database,
  key: CryptoKey,
  f: Fetch,
  env: Bindings,
  row: Row,
): Promise<string> {
  const provider = PROVIDER[row.provider];
  const fresh = !row.expires_at || Date.parse(row.expires_at) - REFRESH_EARLY_MS > Date.now();
  if (fresh) return unseal(key, row.access_token, row.id);
  if (!row.refresh_token) {
    throw new IntegrationError(`Reconnect ${provider.name}: the connection has expired.`, 409);
  }
  let tokens: Tokens;
  try {
    tokens = await provider.refresh(f, env, await unseal(key, row.refresh_token, row.id));
  } catch {
    throw new IntegrationError(`Reconnect ${provider.name}: the connection has expired.`, 409);
  }
  // Rotation: a provider may hand out a new refresh token; keep the old one if it doesn't.
  const refresh = tokens.refresh_token
    ? await seal(key, tokens.refresh_token, row.id)
    : row.refresh_token;
  await db
    .prepare(
      "UPDATE integrations SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(await seal(key, tokens.access_token, row.id), refresh, tokens.expires_at, now(), row.id)
    .run();
  return tokens.access_token;
}

// --- Routes -----------------------------------------------------------------------------------

/** Where a connect attempt returns to: a path on this site only. */
function safeReturn(path: string | undefined): string {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return "/projects";
  }
  return path.slice(0, 500);
}

const problem = (error: string, status: number) => Response.json({ error }, { status });

const reportUrl = (origin: string, projectId: string, reportId: string) =>
  `${origin}/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}`;

/**
 * The integrations' routes, all for a signed-in person: `session` checks the cookie and `owned`
 * the project in the path (a stranger's is a 404). The same-site check on state-changing calls
 * runs before these, for every /api route.
 */
export function registerIntegrationRoutes(
  app: Hono<AppEnv>,
  deps: Deps,
  guards: { session: MiddlewareHandler<AppEnv>; owned: MiddlewareHandler<AppEnv> },
) {
  const { session, owned } = guards;

  /** The provider, set up on this deployment, and the key that seals its tokens; else a 503. */
  const ready = async (env: Bindings, p: ProviderId) => {
    const key = await sealingKey(env);
    if (!key || !PROVIDER[p].configured(env)) {
      throw new IntegrationError(`${PROVIDER[p].name} isn't set up on this deployment.`, 503);
    }
    return key;
  };

  const handle =
    (fn: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => Promise<Response>) =>
    async (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => {
      try {
        return await fn(c);
      } catch (error) {
        if (error instanceof IntegrationError) return problem(error.message, error.status);
        throw error;
      }
    };

  const callbackUrl = (env: Bindings, req: Request, p: ProviderId) =>
    `${env.APP_ORIGIN ?? new URL(req.url).origin}/api/integrations/${p}/callback`;

  const sessionHash = async (c: Parameters<MiddlewareHandler<AppEnv>>[0]) =>
    sha256(getCookie(c, SESSION_COOKIE) ?? "");

  app.get("/api/integrations", session, async (c) => {
    const key = await sealingKey(c.env);
    const { results } = await c.var.db
      .prepare("SELECT * FROM integrations WHERE user_id = ? ORDER BY created_at")
      .bind(c.var.user.id)
      .all<Row>();
    return c.json({
      providers: PROVIDERS.map((p) => ({
        id: p,
        name: PROVIDER[p].name,
        available: Boolean(key) && PROVIDER[p].configured(c.env),
        install_url:
          p === "github" && c.env.GITHUB_APP_SLUG
            ? `https://github.com/apps/${encodeURIComponent(c.env.GITHUB_APP_SLUG)}/installations/new`
            : null,
      })),
      integrations: results.map(info),
    });
  });

  app.get(
    "/api/integrations/:provider/connect",
    session,
    handle(async (c) => {
      const p = c.req.param("provider") ?? "";
      if (!isProvider(p)) return problem("Not found.", 404);
      await ready(c.env, p);
      const state = b64url(random(24));
      const { verifier, challenge } = await pkce();
      const db = c.var.db;
      await db.batch([
        db.prepare("DELETE FROM integration_states WHERE expires_at < ?").bind(now()),
        db
          .prepare(
            `INSERT INTO integration_states
               (hash, session_hash, provider, verifier, return_to, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            await sha256(state),
            await sessionHash(c),
            p,
            verifier,
            safeReturn(c.req.query("return")),
            new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
          ),
      ]);
      const url = PROVIDER[p].authorizeUrl(c.env, {
        state,
        challenge,
        redirect: callbackUrl(c.env, c.req.raw, p),
      });
      return c.redirect(url, 302);
    }),
  );

  app.get(
    "/api/integrations/:provider/callback",
    session,
    handle(async (c) => {
      const p = c.req.param("provider") ?? "";
      if (!isProvider(p)) return problem("Not found.", 404);
      const key = await ready(c.env, p);
      const state = c.req.query("state") ?? "";
      const db = c.var.db;
      // The state is used up whatever happens next, and must be this session's, for this provider.
      const stateHash = await sha256(state);
      const saved = state
        ? await db
            .prepare("SELECT * FROM integration_states WHERE hash = ?")
            .bind(stateHash)
            .first<{
              session_hash: string;
              provider: string;
              verifier: string;
              return_to: string;
              expires_at: string;
            }>()
        : null;
      if (saved)
        await db.prepare("DELETE FROM integration_states WHERE hash = ?").bind(stateHash).run();
      if (
        !saved ||
        saved.provider !== p ||
        saved.session_hash !== (await sessionHash(c)) ||
        Date.parse(saved.expires_at) < Date.now()
      ) {
        return problem("This connection attempt is unknown or has expired. Try again.", 400);
      }
      const back = (outcome: string) => {
        const url = new URL(saved.return_to, "https://x");
        url.searchParams.set("integration", outcome);
        return c.redirect(url.pathname + url.search, 302);
      };
      const code = c.req.query("code");
      if (!code) return back("cancelled");
      const f = deps.providerFetch(c.env);
      const tokens = await PROVIDER[p].exchange(f, c.env, {
        code,
        verifier: saved.verifier,
        redirect: callbackUrl(c.env, c.req.raw, p),
      });
      const account = await PROVIDER[p].account(f, tokens.access_token);
      await saveConnection(db, key, c.var.user.id, p, account, tokens);
      return back("connected");
    }),
  );

  app.delete(
    "/api/integrations/:id",
    session,
    handle(async (c) => {
      const row = await findRow(c.var.db, c.var.user.id, c.req.param("id") ?? "");
      if (!row) return problem("Not found.", 404);
      const key = await sealingKey(c.env);
      if (key && PROVIDER[row.provider].configured(c.env)) {
        try {
          await PROVIDER[row.provider].revoke(deps.providerFetch(c.env), c.env, {
            access: await unseal(key, row.access_token, row.id),
            refresh: row.refresh_token ? await unseal(key, row.refresh_token, row.id) : null,
          });
        } catch (error) {
          console.warn(`brutal: revoking ${row.provider} failed: ${(error as Error).message}`);
        }
      }
      const db = c.var.db;
      await db.batch([
        db.prepare("DELETE FROM integrations WHERE id = ?").bind(row.id),
        db.prepare("DELETE FROM project_issue_targets WHERE integration_id = ?").bind(row.id),
      ]);
      return c.json({ ok: true });
    }),
  );

  app.get(
    "/api/integrations/:id/targets",
    session,
    handle(async (c) => {
      const row = await findRow(c.var.db, c.var.user.id, c.req.param("id") ?? "");
      if (!row) return problem("Not found.", 404);
      const key = await ready(c.env, row.provider);
      const f = deps.providerFetch(c.env);
      const token = await accessToken(c.var.db, key, f, c.env, row);
      return c.json({ targets: await PROVIDER[row.provider].targets(f, token) });
    }),
  );

  /** The project's default target: the last one an issue went to, while its connection lasts. */
  app.get("/api/projects/:project/issue-target", session, owned, async (c) => {
    const row = await c.var.db
      .prepare(
        `SELECT t.integration_id AS integration, t.target AS target
         FROM project_issue_targets t JOIN integrations i ON i.id = t.integration_id
         WHERE t.project_id = ? AND i.user_id = ?`,
      )
      .bind(c.var.project.id, c.var.user.id)
      .first<{ integration: string; target: string }>();
    return c.json({ default: row ?? null });
  });

  app.post(
    "/api/projects/:project/reports/:id/issue",
    session,
    owned,
    handle(async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        integration?: unknown;
        target?: unknown;
      };
      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (typeof body.integration !== "string" || !target || target.length > 200) {
        return problem("Pick a connection and where the issue goes.", 400);
      }
      const reportId = c.req.param("id") ?? "";
      const report = await c.var.reports.get(reportId);
      if (!report) return problem("Not found.", 404);
      if (report.issue_url) return problem("This report already links an issue.", 409);
      const row = await findRow(c.var.db, c.var.user.id, body.integration);
      if (!row) return problem("Not found.", 404);
      const key = await ready(c.env, row.provider);
      const f = deps.providerFetch(c.env);
      const token = await accessToken(c.var.db, key, f, c.env, row);
      const origin = c.env.APP_ORIGIN ?? new URL(c.req.url).origin;
      const content = issueContent(report, reportUrl(origin, c.var.project.id, report.id));
      const url = await PROVIDER[row.provider].createIssue(f, token, target, content);
      const updated = await c.var.reports.update(report.id, { status: "linked", issue_url: url });
      await c.var.db
        .prepare(
          `INSERT INTO project_issue_targets (project_id, integration_id, target, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (project_id) DO UPDATE SET integration_id = excluded.integration_id,
             target = excluded.target, updated_at = excluded.updated_at`,
        )
        .bind(c.var.project.id, row.id, target, now())
        .run();
      return c.json(updated, 201);
    }),
  );
}
