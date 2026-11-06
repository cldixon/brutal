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
 * person. A connection reaches one project of theirs, at one level: "report" does what an ingest
 * key does, "triage" what a read key does.
 */

/** OAuth scopes. A grant never carries more than the person approved. */
export const SCOPES = ["brutal:report", "brutal:triage"];

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

type Env = { Bindings: { DB: D1Database; OAUTH_PROVIDER?: OAuthHelpers } };

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
  access: "report" | "triage";
}

function consentPage(opts: {
  details: ConsentDescription;
  handle: string;
  email: string;
  projects: Project[];
  form: Form;
  error?: string;
}) {
  const { details, handle, email, projects, form, error } = opts;
  const name = details.clientName || "This app";
  return html`<h1>Connect ${name} to Brutal</h1>
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
      <fieldset>
        <legend>What it may do</legend>
        <label
          ><input type="radio" name="access" value="report" ${form.access === "report" ? "checked" : ""} />
          <strong>Report feedback</strong>: file reports about its tools (like an ingest key)</label
        >
        <label
          ><input type="radio" name="access" value="triage" ${form.access === "triage" ? "checked" : ""} />
          <strong>Read and triage</strong>: also read the project's reports and update them (like a read
          key)</label
        >
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
          form: {
            project: projects[0]?.id ?? "new",
            newProject: "",
            // Least access unless the app asked for more.
            access: request.scope.includes("brutal:triage") ? "triage" : "report",
          },
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
        access: body.get("access") === "triage" ? "triage" : "report",
      };
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
          consentPage({ details, handle, email: user.email, projects, form, error: problem }),
          undefined,
          400,
        );
      }
      const scope =
        form.access === "triage" ? ["brutal:report", "brutal:triage"] : ["brutal:report"];
      const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
      const project =
        form.project === "new"
          ? await createProject(db, user.id, form.newProject)
          : (projects.find((p) => p.id === form.project) as Project);
      const grant: Grant = {
        id: crypto.randomUUID(),
        userId: user.id,
        projectId: project.id,
        kind: form.access === "triage" ? "read" : "ingest",
      };
      const metadata: GrantMetadata = {
        project: project.id,
        access: form.access,
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
