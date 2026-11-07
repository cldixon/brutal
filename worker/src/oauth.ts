import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { html } from "hono/html";
import {
  createProject,
  type Key,
  type KeyKind,
  listProjects,
  migrated,
  type Project,
  SESSION_COOKIE,
  sessionUser,
  type User,
} from "./accounts";

/**
 * Connecting an app (claude.ai's connectors, any MCP client that speaks OAuth) to one project,
 * after Tempra's (cldixon/tempra, worker/src/oauth/): the provider in worker.ts serves discovery,
 * /register and /token and guards /mcp; this is the consent at /authorize, for the signed-in
 * person. A connection reaches one project of theirs; what it may do is the host's: on the app's
 * host it files reports (as an ingest key), on the review host it reads and triages them (as a
 * read key).
 */

/** OAuth scopes. A grant never carries more than the person approved. */
export const SCOPES = ["brutal:report", "brutal:triage"];

/**
 * Which MCP server a host serves: "report" (FEEDBACK_ORIGIN: `report_feedback`, for agents using
 * someone's tools) or "review" (REVIEW_ORIGIN: the triage tools, for the developers' coding
 * agents); null for the app's own host, which serves neither.
 */
export type Role = "report" | "review";

export function roleOf(
  origin: string,
  env: { FEEDBACK_ORIGIN?: string; REVIEW_ORIGIN?: string },
): Role | null {
  if (env.REVIEW_ORIGIN && origin === env.REVIEW_ORIGIN) return "review";
  if (env.FEEDBACK_ORIGIN && origin === env.FEEDBACK_ORIGIN) return "report";
  return null;
}

/** The scopes a host's connections get. */
export function scopesFor(role: Role): string[] {
  return role === "review" ? ["brutal:triage"] : ["brutal:report"];
}

/** What an approved connection carries, checked again on every MCP call. */
export interface Grant {
  id: string;
  userId: string;
  projectId: string;
  /** What it may do: "ingest" (report feedback) or "read" (also read and triage). */
  kind: KeyKind;
}

/** What the provider passes to /mcp: a connection's grant, or one of our own keys. */
export interface GrantProps {
  grant?: Grant;
  key?: Key;
}

/** What the "Connected apps" list shows, from a grant's metadata. */
export interface GrantMetadata {
  project: string;
  access: "report" | "triage";
  client: string;
}

type Env = {
  Bindings: {
    DB: D1Database;
    OAUTH_PROVIDER?: OAuthHelpers;
    FEEDBACK_ORIGIN?: string;
    REVIEW_ORIGIN?: string;
  };
};

/** The consent page's look: the app's minimal stylesheet (app/public/consent.css). */
const HEADERS: Record<string, string> = {
  // Approving redirects to the app's own address, which the form's action must be allowed.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

function page(body: unknown, headers?: Headers, status = 200): Response {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(HEADERS)) h.set(k, v);
  h.set("Content-Type", "text/html; charset=utf-8");
  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>Connect an app · Brutal</title>
        <link rel="stylesheet" href="/consent.css" />
      </head>
      <body>
        <main>
          <p class="brand">Brutal</p>
          ${body}
        </main>
      </body>
    </html>`;
  return new Response(doc.toString(), { status, headers: h });
}

function message(title: string, text: string, status: number): Response {
  return page(html`<h1>${title}</h1><p>${text}</p>`, undefined, status);
}

interface Form {
  /** A project's id, or "new". */
  project: string;
  newProject: string;
}

function consentPage(opts: {
  details: ConsentDescription;
  handle: string;
  email: string;
  projects: Project[];
  form: Form;
  role: Role;
  error?: string;
}) {
  const { details, handle, email, projects, form, role, error } = opts;
  const name = details.clientName || "This app";
  const review = role === "review";
  return html`<h1>Connect ${name} to Brutal${review ? " review" : ""}</h1>
    <p>
      ${
        review
          ? html`It will <strong>read the project's reports and triage them</strong>: set their
              status, link issues, and delete reports.`
          : html`It will <strong>file feedback reports</strong> about the tools it uses. It can't
              read the project's reports.`
      }
    </p>
    <p class="muted">
      Signed in as ${email}. It will be sent back to <strong>${details.redirectHost}</strong>.
    </p>
    ${error ? html`<p class="error">${error}</p>` : ""}
    <form method="post">
      <input type="hidden" name="handle" value="${handle}" />
      <fieldset>
        <legend>Project</legend>
        ${projects.map(
          (p) =>
            html`<label><input type="radio" name="project" value="${p.id}" ${form.project === p.id ? "checked" : ""} /> ${p.name}</label>`,
        )}
        <label
          ><input type="radio" name="project" value="new" ${form.project === "new" ? "checked" : ""} />
          A new project:
          <input name="new_project" value="${form.newProject}" maxlength="80" placeholder="Project name"
        /></label>
      </fieldset>
      <p class="row">
        <button class="primary" name="decision" value="approve">Connect</button>
        <button name="decision" value="deny">Cancel</button>
      </p>
    </form>`;
}

function authError(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError) {
    return message("Can't connect this app", e.description ?? "The request isn't valid.", 400);
  }
  if (e instanceof CimdFetchError) {
    return message("Can't connect this app", "This app couldn't be verified.", 400);
  }
  throw e;
}

/** The signed-in person, or the redirect to sign in that comes back here. */
async function personOr<E extends Env>(c: Context<E>): Promise<User | Response> {
  const db = await migrated(c.env.DB);
  const secret = getCookie(c, SESSION_COOKIE);
  const user = secret ? await sessionUser(db, secret) : null;
  if (user) return user;
  const self = new URL(c.req.url);
  return c.redirect(`/sign-in?next=${encodeURIComponent(self.pathname + self.search)}`);
}

export function registerConsentRoutes<E extends Env>(app: Hono<E>) {
  app.get("/authorize", async (c) => {
    const user = await personOr(c);
    if (user instanceof Response) return user;
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return message("Unavailable", "Connecting apps isn't set up here.", 503);
    try {
      const request = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(request);
      const projects = await listProjects(await migrated(c.env.DB), user.id);
      const consent = await oauth.beginConsent(request);
      return page(
        consentPage({
          details,
          handle: consent.handle,
          email: user.email,
          projects,
          form: { project: projects[0]?.id ?? "new", newProject: "" },
          role: roleOf(new URL(c.req.url).origin, c.env) ?? "report",
        }),
        consent.headers,
      );
    } catch (e) {
      return authError(e);
    }
  });

  app.post("/authorize", async (c) => {
    const user = await personOr(c);
    if (user instanceof Response) return user;
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return message("Unavailable", "Connecting apps isn't set up here.", 503);
    const db = await migrated(c.env.DB);
    const body = await c.req.formData();
    const handle = String(body.get("handle") ?? "");
    try {
      if (body.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const form: Form = {
        project: String(body.get("project") ?? ""),
        newProject: String(body.get("new_project") ?? "").trim(),
      };
      const role = roleOf(new URL(c.req.url).origin, c.env) ?? "report";
      const projects = await listProjects(db, user.id);
      const problem =
        form.project === "new"
          ? form.newProject.length === 0 || form.newProject.length > 80
            ? "Name the new project (up to 80 characters)."
            : null
          : projects.some((p) => p.id === form.project)
            ? null
            : "Pick one of your projects, or name a new one.";
      // The form posts to its own URL, so the original authorization request is in the query.
      const oauthReq = await oauth.parseAuthRequest(new Request(c.req.url));
      const details = await oauth.describeConsent(oauthReq);
      if (problem) {
        // The handle is still unused, so the same page can be shown again with the problem.
        return page(
          consentPage({ details, handle, email: user.email, projects, form, role, error: problem }),
          undefined,
          400,
        );
      }
      const scope = scopesFor(role);
      const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
      const project =
        form.project === "new"
          ? await createProject(db, user.id, form.newProject)
          : (projects.find((p) => p.id === form.project) as Project);
      const grant: Grant = {
        id: crypto.randomUUID(),
        userId: user.id,
        projectId: project.id,
        kind: role === "review" ? "read" : "ingest",
      };
      const metadata: GrantMetadata = {
        project: project.id,
        access: role === "review" ? "triage" : "report",
        client: details.clientName || details.redirectHost || "An app",
      };
      const props: GrantProps = { grant };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: user.id,
        metadata,
        scope,
        props,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      return authError(e);
    }
  });
}
