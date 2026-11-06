import { ReportInput, ReportUpdate, toolDefinition } from "@brutal-ai/schema";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import {
  bearer,
  CODE_MINUTES,
  createKey,
  createProject,
  EMAIL,
  endSession,
  findKey,
  issueCode,
  joinWaitlist,
  type Key,
  listKeys,
  listProjects,
  mayGetCode,
  migrated,
  newSession,
  normalizeEmail,
  ownedProject,
  type Project,
  revokeKey,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionUser,
  type User,
  useCode,
} from "./accounts";
import { type GrantMetadata, registerConsentRoutes } from "./oauth";
import type { ProjectReports } from "./reports";

export interface Bindings {
  /** Accounts: people, codes, sessions, projects, keys (src/accounts.ts). */
  DB: D1Database;
  /** One Durable Object per project, holding its reports (src/project.ts). */
  PROJECT?: DurableObjectNamespace;
  /** The Svelte app's static files (app/dist). */
  ASSETS?: Fetcher;
  /** Cloudflare Email Service, once a sending domain is set up; MAIL_FROM is its address. */
  EMAIL?: MailBinding;
  MAIL_FROM?: string;
  /** Local dev: sign-in codes are shown on the page instead of mailed (loopback hosts only). */
  DEV_SIGNIN?: string;
  /**
   * Who may sign up (Tempra's SIGNUP): `invite` (production) gives codes only to accounts,
   * invited emails and the operator, and puts anyone else on the waitlist; `open` lets anyone in.
   */
  SIGNUP?: string;
  /** The operator (a secret): always let in, and told when someone joins the waitlist. */
  OPERATOR_EMAIL?: string;
  /** The app's own origin, for links in mail sent from the operator's portal. */
  APP_ORIGIN?: string;
  /** The feedback MCP server's origin (worker.ts); unset, there is none. */
  FEEDBACK_ORIGIN?: string;
  /** The review MCP server's origin (worker.ts); unset, there is none. */
  REVIEW_ORIGIN?: string;
  /** The landing page's Worker (site/): `/` for people signed out, and its own files. */
  SITE?: Fetcher;
  /** OAuth clients and grants (worker.ts, oauth.ts). */
  OAUTH_KV?: KVNamespace;
  /** Put here by the OAuth provider for the consent page and the connected apps list. */
  OAUTH_PROVIDER?: OAuthHelpers;
}

export interface MailBinding {
  send(m: {
    from: { name: string; email: string };
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

export type Mailer = (to: string, subject: string, text: string) => Promise<void>;

export interface Deps {
  /** A project's reports: its Durable Object in production, an in-memory store in tests. */
  reports(env: Bindings, projectId: string): ProjectReports;
  /** Sends mail, or null when this deployment cannot. */
  mailer(env: Bindings): Mailer | null;
}

/** Cloudflare Email Service's mailer, from "Brutal" at MAIL_FROM; null without a sending domain. */
export function mailerFor(env: Bindings): Mailer | null {
  const binding = env.EMAIL;
  const from = env.MAIL_FROM;
  if (!binding || !from) return null;
  return async (to, subject, text) => {
    await binding.send({ from: { name: "Brutal", email: from }, to, subject, text });
  };
}

export const defaultDeps: Deps = {
  reports(env, projectId) {
    if (!env.PROJECT) throw new Error("The PROJECT binding is missing.");
    return env.PROJECT.get(env.PROJECT.idFromName(projectId)) as unknown as ProjectReports;
  },
  mailer: mailerFor,
};

type Env = {
  Bindings: Bindings;
  Variables: { db: D1Database; key: Key; reports: ProjectReports; user: User; project: Project };
};
type C = Context<Env>;

const problem = (error: string, status: number, extra: object = {}) =>
  Response.json({ error, ...extra }, { status });

/** Local dev: loopback hosts with DEV_SIGNIN=1 show the code instead of mailing it. */
function devSignIn(c: C): boolean {
  const host = new URL(c.req.url).hostname;
  return c.env.DEV_SIGNIN === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(host);
}

/**
 * Whether a state-changing request came from this site's own pages (CSRF defence beside
 * SameSite=Lax cookies; Tempra's fromThisSite): Origin, else Sec-Fetch-Site.
 */
function fromThisSite(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (origin && origin !== "null") return origin === new URL(req.url).origin;
  return req.headers.get("Sec-Fetch-Site") === "same-origin";
}

export function createApp(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps, ...overrides };
  const app = new Hono<Env>();

  app.use(async (c, next) => {
    c.set("db", await migrated(c.env.DB));
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  app.get("/healthz", (c) => c.text("ok"));

  // Public: the canonical tool definition and prompt, so any language can define the tool.
  app.get("/v1/schema/tool", (c) => c.json(toolDefinition()));

  // --- Agents and scripts: a project's key --------------------------------------------------

  /** Requires a key of one of the given kinds; a read key may do everything. */
  const keyed = (...kinds: Key["kind"][]) =>
    createMiddleware<Env>(async (c, next) => {
      const secret = bearer(c.req.header("authorization"));
      const key = secret ? await findKey(c.var.db, secret) : null;
      if (!key) return problem("A valid key is required (Authorization: Bearer <key>).", 401);
      if (!kinds.includes(key.kind)) return problem(`This needs a ${kinds.join(" or ")} key.`, 403);
      c.set("key", key);
      c.set("reports", deps.reports(c.env, key.project_id));
      await next();
    });

  app.post("/v1/reports", keyed("ingest", "read"), async (c) => {
    const parsed = ReportInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem("Invalid report.", 400, { issues: parsed.error.issues });
    const report = await c.var.reports.insert(parsed.data, c.var.key.id);
    return c.json({ id: report.id }, 201);
  });

  // Durable Object RPC can't carry Hono's query object (it has no prototype): copy it.
  app.get("/v1/reports", keyed("read"), async (c) =>
    c.json(await c.var.reports.list({ ...c.req.query() })),
  );

  app.get("/v1/reports/:id", keyed("read"), async (c) => {
    const report = await c.var.reports.get(c.req.param("id"));
    return report ? c.json(report) : problem("Not found.", 404);
  });

  app.patch("/v1/reports/:id", keyed("read"), async (c) => {
    const parsed = ReportUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem("Invalid update.", 400, { issues: parsed.error.issues });
    const report = await c.var.reports.update(c.req.param("id"), parsed.data);
    return report ? c.json(report) : problem("Not found.", 404);
  });

  // --- People: the web app's API, with a session cookie --------------------------------------

  // Every state-changing call must come from this site's own pages.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !fromThisSite(c.req.raw)) {
      return problem("Requests that change something must come from this site.", 403);
    }
    await next();
  });

  app.post("/api/sign-in", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    if (!EMAIL.test(email) || email.length > 254) return problem("Enter a valid email.", 400);
    const dev = devSignIn(c);
    const mailer = deps.mailer(c.env);
    if (!dev && !mailer) return problem("Sign-in mail isn't set up on this deployment.", 503);
    const operator = c.env.OPERATOR_EMAIL ? normalizeEmail(c.env.OPERATOR_EMAIL) : "";
    const open = c.env.SIGNUP === "open";
    if (!open && email !== operator && !(await mayGetCode(c.var.db, email))) {
      // Not invited: onto the waitlist, with the same answer an account gets, so the page never
      // says who has one (Tempra's way in). Told once; the operator too.
      if (await joinWaitlist(c.var.db, email)) {
        await mailer?.(
          email,
          "You're on the Brutal waitlist",
          "Thanks for your interest in Brutal. Sign-up is by invitation for now; we'll email " +
            "you when there's room.\n",
        );
        if (operator)
          await mailer?.(operator, `Brutal waitlist: ${email}`, `${email} asked to sign in.\n`);
      }
      return c.json({ sent: true });
    }
    const code = await issueCode(c.var.db, email);
    if (!code) return problem("A code was just sent. Wait a few seconds and try again.", 429);
    if (dev) {
      console.log(`brutal: sign-in code for ${email}: ${code}`);
      return c.json({ sent: true, code });
    }
    await mailer?.(
      email,
      `Your Brutal sign-in code: ${code}`,
      `Your Brutal sign-in code is ${code}\n\nIt works once, for ${CODE_MINUTES} minutes. ` +
        "If you didn't ask for it, ignore this email.\n",
    );
    return c.json({ sent: true });
  });

  app.post("/api/sign-in/verify", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; code?: unknown };
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    const code = typeof body.code === "string" ? body.code : "";
    // Checked again: an invite may have been withdrawn since the code went out.
    const operator = c.env.OPERATOR_EMAIL ? normalizeEmail(c.env.OPERATOR_EMAIL) : "";
    if (c.env.SIGNUP !== "open" && email !== operator && !(await mayGetCode(c.var.db, email))) {
      return problem("That code isn't right.", 400);
    }
    const result = await useCode(c.var.db, email, code);
    if (!result.ok) {
      return problem(
        result.why === "wrong"
          ? "That code isn't right."
          : "That code has expired or was used. Ask for a new one.",
        400,
      );
    }
    const secret = await newSession(c.var.db, result.user.id);
    setCookie(c, SESSION_COOKIE, secret, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: SESSION_DAYS * 86_400,
    });
    return c.json({ email: result.user.email });
  });

  app.post("/api/sign-out", async (c) => {
    const secret = getCookie(c, SESSION_COOKIE);
    if (secret) await endSession(c.var.db, secret);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true });
  });

  /** Requires a signed-in person. */
  const session = createMiddleware<Env>(async (c, next) => {
    const secret = getCookie(c, SESSION_COOKIE);
    const user = secret ? await sessionUser(c.var.db, secret) : null;
    if (!user) return problem("Sign in first.", 401);
    c.set("user", user);
    await next();
  });

  /** Requires the signed-in person to own the project in the path; a stranger gets 404. */
  const owned = createMiddleware<Env>(async (c, next) => {
    const project = await ownedProject(c.var.db, c.var.user.id, c.req.param("project") ?? "");
    if (!project) return problem("Not found.", 404);
    c.set("project", project);
    c.set("reports", deps.reports(c.env, project.id));
    await next();
  });

  app.get("/api/me", session, (c) => c.json({ email: c.var.user.email }));

  app.get("/api/projects", session, async (c) =>
    c.json({ projects: await listProjects(c.var.db, c.var.user.id) }),
  );

  const NewProject = z.object({ name: z.string().trim().min(1).max(80) });
  app.post("/api/projects", session, async (c) => {
    const parsed = NewProject.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem("A project needs a name (up to 80 characters).", 400);
    return c.json(await createProject(c.var.db, c.var.user.id, parsed.data.name), 201);
  });

  app.get("/api/projects/:project", session, owned, async (c) =>
    c.json({
      project: c.var.project,
      keys: await listKeys(c.var.db, c.var.project.id),
      // Where agents connect: the feedback and review servers' hosts.
      feedback_origin: c.env.FEEDBACK_ORIGIN ?? null,
      review_origin: c.env.REVIEW_ORIGIN ?? null,
    }),
  );

  const NewKey = z.object({
    kind: z.enum(["ingest", "read"]),
    name: z.string().trim().min(1).max(80),
  });
  app.post("/api/projects/:project/keys", session, owned, async (c) => {
    const parsed = NewKey.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem("A key needs a kind (ingest or read) and a name.", 400);
    const made = await createKey(c.var.db, c.var.project.id, parsed.data.kind, parsed.data.name);
    return c.json(made, 201);
  });

  app.delete("/api/projects/:project/keys/:key", session, owned, async (c) => {
    const done = await revokeKey(c.var.db, c.var.project.id, c.req.param("key"));
    return done ? c.json({ ok: true }) : problem("Not found.", 404);
  });

  app.get("/api/projects/:project/reports", session, owned, async (c) =>
    c.json(await c.var.reports.list({ ...c.req.query() })),
  );

  app.get("/api/projects/:project/reports/:id", session, owned, async (c) => {
    const report = await c.var.reports.get(c.req.param("id"));
    return report ? c.json(report) : problem("Not found.", 404);
  });

  app.patch("/api/projects/:project/reports/:id", session, owned, async (c) => {
    const parsed = ReportUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem("Invalid update.", 400, { issues: parsed.error.issues });
    const report = await c.var.reports.update(c.req.param("id"), parsed.data);
    return report ? c.json(report) : problem("Not found.", 404);
  });

  // Apps connected to a project over OAuth (claude.ai's connectors and the like), and revoking them.
  app.get("/api/projects/:project/connections", session, owned, async (c) => {
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return c.json({ connections: [] });
    const { items } = await oauth.listUserGrants(c.var.user.id);
    const connections = items
      .filter((g) => (g.metadata as GrantMetadata | null)?.project === c.var.project.id)
      .map((g) => {
        const m = g.metadata as GrantMetadata;
        return {
          id: g.id,
          client: m.client,
          access: m.access,
          created_at: new Date(g.createdAt * 1000).toISOString(),
        };
      });
    return c.json({ connections });
  });

  app.delete("/api/projects/:project/connections/:grant", session, owned, async (c) => {
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return problem("Not found.", 404);
    const { items } = await oauth.listUserGrants(c.var.user.id);
    const grant = items.find(
      (g) =>
        g.id === c.req.param("grant") &&
        (g.metadata as GrantMetadata | null)?.project === c.var.project.id,
    );
    if (!grant) return problem("Not found.", 404);
    await oauth.revokeGrant(grant.id, c.var.user.id);
    return c.json({ ok: true });
  });

  app.all("/api/*", () => problem("Not found.", 404));

  // Connecting an app over OAuth: the consent at /authorize (oauth.ts).
  registerConsentRoutes(app);

  // `/` is the landing page (site/, through SITE) for people signed out, and the app for people
  // signed in; the site's own files come from it too. It gets no cookie or credentials, and `/`
  // varies by cookie, so a browser never reuses the landing page once signed in (Tempra's way).
  const fromSite = async (c: C) => {
    const site = c.env.SITE;
    if (!site) return c.redirect("/sign-in");
    const headers = new Headers(c.req.raw.headers);
    headers.delete("Cookie");
    headers.delete("Authorization");
    const res = await site.fetch(new Request(c.req.url, { method: c.req.method, headers }));
    const out = new Response(res.body, res);
    if (new URL(c.req.url).pathname === "/") {
      out.headers.set("Cache-Control", "private, no-cache");
      out.headers.append("Vary", "Cookie");
    }
    return out;
  };

  app.get("/", async (c) => {
    const secret = getCookie(c, SESSION_COOKIE);
    const user = secret ? await sessionUser(c.var.db, secret) : null;
    if (!user) return fromSite(c);
    const res = c.env.ASSETS ? await c.env.ASSETS.fetch(c.req.raw) : await c.notFound();
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-cache");
    out.headers.append("Vary", "Cookie");
    return out;
  });
  app.get("/_astro/*", (c) => fromSite(c));
  // The docs are the site's too: public and static.
  app.get("/docs", (c) => fromSite(c));

  // Everything else is the web app (static assets, which answer before the Worker in
  // production; this covers local tools that send every request here).
  app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound()));

  return app;
}
