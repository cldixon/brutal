import { ReportInput, ReportUpdate, toolDefinition } from "@brutal-ai/schema";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { reportPage, reportsPage, setupPage } from "./dashboard";
import { getReport, insertReport, listReports, migrated, updateReport } from "./db";
import { findKey, type Key, secretFrom } from "./keys";
import { handleMcp } from "./mcp";
import { claim, isClaimed, logSetupCode } from "./setup";

export interface Bindings {
  DB: D1Database;
  /** Optional: the setup code, when the deployer sets one; otherwise one is made and logged. */
  SETUP_CODE?: string;
}
type Env = { Bindings: Bindings; Variables: { db: D1Database; key: Key } };

const problem = (error: string, status: number, extra: object = {}) =>
  Response.json({ error, ...extra }, { status });

export function createApp() {
  const app = new Hono<Env>();

  app.use(async (c, next) => {
    c.set("db", await migrated(c.env.DB));
    await next();
  });

  /** Requires a key of one of the given kinds; a read key may do everything. */
  const auth = (...kinds: Key["kind"][]) =>
    createMiddleware<Env>(async (c, next) => {
      const secret = secretFrom(c.req.header("authorization"));
      const key = secret ? await findKey(c.var.db, secret) : null;
      if (!key) return problem("A valid key is required (Authorization: Bearer <key>).", 401);
      if (!kinds.includes(key.kind)) return problem(`This needs a ${kinds.join(" or ")} key.`, 403);
      c.set("key", key);
      await next();
    });

  app.get("/healthz", (c) => c.text("ok"));

  // Public: the canonical tool definition and prompt, so any language can define the tool.
  app.get("/v1/schema/tool", (c) => c.json(toolDefinition()));

  app.post("/v1/reports", auth("ingest", "read"), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ReportInput.safeParse(body);
    if (!parsed.success) return problem("Invalid report.", 400, { issues: parsed.error.issues });
    const report = await insertReport(c.var.db, parsed.data, c.var.key.id);
    return c.json({ id: report.id }, 201);
  });

  app.get("/v1/reports", auth("read"), async (c) => {
    const q = c.req.query();
    return c.json(
      await listReports(c.var.db, { ...q, limit: q.limit ? Number(q.limit) : undefined }),
    );
  });

  app.get("/v1/reports/:id", auth("read"), async (c) => {
    const report = await getReport(c.var.db, c.req.param("id"));
    return report ? c.json(report) : problem("Not found.", 404);
  });

  app.patch("/v1/reports/:id", auth("read"), async (c) => {
    const parsed = ReportUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem("Invalid update.", 400, { issues: parsed.error.issues });
    const report = await updateReport(c.var.db, c.req.param("id"), parsed.data);
    return report ? c.json(report) : problem("Not found.", 404);
  });

  app.all("/mcp", auth("ingest", "read"), (c) => handleMcp(c.req.raw, c.var.db, c.var.key));

  // First run: the setup code claims the instance and shows its first two keys once.
  app.get("/setup", async (c) => {
    if (await isClaimed(c.var.db)) return c.html(setupPage({ claimed: true }));
    await logSetupCode(c.var.db, c.env.SETUP_CODE);
    return c.html(setupPage({}));
  });
  app.post("/setup", async (c) => {
    const form = await c.req.parseBody();
    const code = typeof form.code === "string" ? form.code : "";
    const result = await claim(c.var.db, c.env.SETUP_CODE, code);
    if (result.ok) return c.html(setupPage({ keys: result }));
    if (result.reason === "claimed") return c.html(setupPage({ claimed: true }), 409);
    return c.html(setupPage({ wrongCode: true }), 403);
  });

  // The dashboard: the browser's own Basic auth prompt, with the read key as the password.
  const dashboard = createMiddleware<Env>(async (c, next) => {
    const secret = secretFrom(c.req.header("authorization"));
    const key = secret ? await findKey(c.var.db, secret) : null;
    if (key?.kind !== "read") {
      return new Response("Sign in with any username and your read key as the password.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="brutal", charset="UTF-8"' },
      });
    }
    await next();
  });

  app.get("/", dashboard, async (c) => {
    const q = c.req.query();
    const page = await listReports(c.var.db, q);
    return c.html(reportsPage(page.reports, q, page.next));
  });

  app.get("/reports/:id", dashboard, async (c) => {
    const report = await getReport(c.var.db, c.req.param("id"));
    return report ? c.html(reportPage(report)) : c.notFound();
  });

  return app;
}
