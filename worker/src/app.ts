import { ReportInput, ReportUpdate, toolDefinition } from "@brutal-ai/schema";
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
  type Key,
  listKeys,
  listProjects,
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
import { handleMcp } from "./mcp";
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
  /** Comma-separated emails that may sign in (a secret); unset lets anyone in. */
  SIGNUP_ALLOW?: string;
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

const defaultDeps: Deps = {
  reports(env, projectId) {
    if (!env.PROJECT) throw new Error("The PROJECT binding is missing.");
    return env.PROJECT.get(env.PROJECT.idFromName(projectId)) as unknown as ProjectReports;
  },
  mailer(env) {
    const binding = env.EMAIL;
    const from = env.MAIL_FROM;
    if (!binding || !from) return null;
    return async (to, subject, text) => {
      await binding.send({ from: { name: "Brutal", email: from }, to, subject, text });
    };
  },
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

  app.all("/mcp", keyed("ingest", "read"), (c) => handleMcp(c.req.raw, c.var.reports, c.var.key));

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
    const allow = (c.env.SIGNUP_ALLOW ?? "").split(",").map(normalizeEmail).filter(Boolean);
    if (allow.length > 0 && !allow.includes(email)) {
      return problem("Brutal is invite-only for now.", 403);
    }
    const dev = devSignIn(c);
    const mailer = deps.mailer(c.env);
    if (!dev && !mailer) return problem("Sign-in mail isn't set up on this deployment.", 503);
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
    c.json({ project: c.var.project, keys: await listKeys(c.var.db, c.var.project.id) }),
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

  app.all("/api/*", () => problem("Not found.", 404));

  // Everything else is the web app (static assets, which answer before the Worker in
  // production; this covers local tools that send every request here).
  app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound()));

  return app;
}
