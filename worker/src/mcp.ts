import {
  agentInput,
  IMPACTS,
  KINDS,
  STATUSES,
  TOOL_ACK,
  TOOL_DESCRIPTION,
  TOOL_NAME,
} from "@brutal/schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getReport, insertReport, listReports, updateReport } from "./db";
import type { Key } from "./keys";

/**
 * One MCP server, two scopes chosen by the key: an ingest key sees only `report_feedback` (the
 * agent side); a read key sees the triage tools (the developer side, for coding agents).
 */
function buildServer(db: D1Database, key: Key): McpServer {
  const server = new McpServer({ name: "brutal", version: "0.1.0" });
  const json = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  });

  if (key.kind === "ingest") {
    server.registerTool(
      TOOL_NAME,
      { description: TOOL_DESCRIPTION, inputSchema: agentInput },
      async (input) => {
        // Never fail the agent's turn over feedback: answer the same either way.
        try {
          await insertReport(db, { ...input, context: { sdk: "mcp" } }, key.id);
        } catch (error) {
          console.error("report_feedback failed", error);
        }
        return { content: [{ type: "text", text: TOOL_ACK }] };
      },
    );
    return server;
  }

  server.registerTool(
    "list_reports",
    {
      description:
        "List feedback reports that agents filed, newest first. Filter by kind, status, tool, " +
        "impact, agent, app version or branch. Pass `before` (the `next` of a previous call) " +
        "for the next page.",
      inputSchema: {
        kind: z.enum(KINDS).optional(),
        status: z.enum(STATUSES).optional(),
        tool_name: z.string().optional(),
        impact: z.enum(IMPACTS).optional(),
        agent_name: z.string().optional(),
        app_version: z.string().optional(),
        branch: z.string().optional(),
        before: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (filter) => {
      const { reports, next } = await listReports(db, filter);
      // The list leaves out details and context; get_report has them.
      const rows = reports.map(({ details: _d, context: _c, ...r }) => r);
      return json({ reports: rows, next });
    },
  );

  server.registerTool(
    "get_report",
    {
      description:
        "One report in full: the agent's details and the context its integration attached " +
        "(conversation, app version, branch, recent tool calls).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const report = await getReport(db, id);
      if (!report) return { isError: true, content: [{ type: "text", text: `No report ${id}.` }] };
      return json(report);
    },
  );

  server.registerTool(
    "update_report",
    {
      description:
        "Triage a report: set its status (new, triaged, linked, fixed, verified, wont_fix) " +
        "and/or link the issue that tracks it (null unlinks).",
      inputSchema: {
        id: z.string(),
        status: z.enum(STATUSES).optional(),
        issue_url: z
          .url({ protocol: /^https?$/ })
          .nullable()
          .optional(),
      },
    },
    async ({ id, ...update }) => {
      const report = await updateReport(db, id, update);
      if (!report) return { isError: true, content: [{ type: "text", text: `No report ${id}.` }] };
      return json(report);
    },
  );

  server.registerTool(
    "get_eval_candidates",
    {
      description:
        "Reports agents flagged as tasks interesting or hard enough to belong in an evaluation " +
        "set, in full, newest first.",
      inputSchema: {
        before: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ before, limit }) =>
      json(await listReports(db, { kind: "eval_candidate", before, limit })),
  );

  return server;
}

/** Serves one MCP request statelessly: a fresh server and transport per HTTP request. */
export async function handleMcp(req: Request, db: D1Database, key: Key): Promise<Response> {
  const server = buildServer(db, key);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
