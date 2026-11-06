import { z } from "zod";

/**
 * The report schema and the canonical tool definition. Every surface (HTTP API, MCP, a future
 * SDK and CLI) validates against these, so an agent in any language can define the tool from
 * `toolDefinition()` and POST to the API.
 */

export const KINDS = [
  "bug",
  "friction",
  "missing_capability",
  "confusing_output",
  "latency",
  "eval_candidate",
  "other",
] as const;
export const IMPACTS = ["blocked", "worked_around", "minor"] as const;
export const STATUSES = ["new", "triaged", "linked", "fixed", "verified", "wont_fix"] as const;

export type Kind = (typeof KINDS)[number];
export type Impact = (typeof IMPACTS)[number];
export type Status = (typeof STATUSES)[number];

/** What the agent supplies: its judgment. Kept small so models fill it reliably. */
export const agentInput = {
  kind: z.enum(KINDS).describe("What sort of report this is."),
  title: z.string().min(1).max(100).describe("A short title, under 100 characters."),
  summary: z.string().min(1).max(500).describe("What happened, in one or two sentences."),
  details: z
    .string()
    .max(10_000)
    .optional()
    .describe("What you tried, what you expected, what you got, and a suggested fix."),
  tool_name: z.string().max(200).optional().describe("The tool the report is about, if any."),
  impact: z
    .enum(IMPACTS)
    .optional()
    .describe("blocked: could not finish; worked_around: finished another way; minor."),
  user_impact: z
    .string()
    .max(1000)
    .optional()
    .describe("How the end user was affected, if at all."),
};
export const AgentInput = z.object(agentInput);
export type AgentInput = z.infer<typeof AgentInput>;

/** One recorded tool call, attached by the integration, never written by the agent. */
export const ToolCall = z.object({
  name: z.string().max(200),
  args: z.unknown().optional(),
  status: z.enum(["ok", "error"]).optional(),
  latency_ms: z.number().nonnegative().optional(),
  result: z.unknown().optional(),
  error: z.string().max(4000).optional(),
  at: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

/** What the integration supplies: context, never asked of the agent. */
export const Context = z
  .object({
    conversation_id: z.string().max(200),
    turn_id: z.string().max(200),
    app_version: z.string().max(100),
    branch: z.string().max(200),
    deploy_id: z.string().max(200),
    environment: z.string().max(100),
    model: z.string().max(200),
    agent_name: z.string().max(200),
    trace_id: z.string().max(200),
    user_id: z.string().max(200),
    sdk: z.string().max(100),
    sdk_version: z.string().max(100),
    recent_tool_calls: z.array(ToolCall).max(50),
  })
  .partial();
export type Context = z.infer<typeof Context>;

/** The body of `POST /v1/reports`: the agent's fields, plus the integration's `context`. */
export const ReportInput = AgentInput.extend({ context: Context.optional() });
export type ReportInput = z.infer<typeof ReportInput>;

/** The body of `PATCH /v1/reports/:id`. */
export const ReportUpdate = z
  .object({
    status: z.enum(STATUSES),
    issue_url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .nullable(),
  })
  .partial();
export type ReportUpdate = z.infer<typeof ReportUpdate>;

/** A stored report, as the read API returns it. */
export interface Report extends AgentInput {
  id: string;
  status: Status;
  issue_url: string | null;
  context: Context;
  created_at: string;
  updated_at: string;
}

export const TOOL_NAME = "report_feedback";
export const TOOL_VERSION = "2026-11-05";

/** The tool's wording is where most of the product's quality lives: version it with TOOL_VERSION. */
export const TOOL_DESCRIPTION =
  "Use this to privately tell the developers of this application about problems or notable tasks. " +
  "The user does not see this call. Report when: a tool errors, rejects a reasonable input, " +
  "returns results that look wrong or suspiciously empty, cannot express what the user asked, " +
  "or is slow; the UI or input makes the task harder; or the task is unusually interesting or " +
  "hard and would make a good evaluation case (kind: eval_candidate). Be specific: name the " +
  "tool, what you tried, what you expected and what happened. Report once per distinct issue, " +
  "then continue helping the user. Never include secrets or personal data beyond what is " +
  "needed to reproduce.";

/** What the tool answers. It never fails the agent's turn. */
export const TOOL_ACK = "Feedback recorded.";

/** The canonical tool definition, in the shape most model APIs take (name, description, JSON Schema). */
export function toolDefinition() {
  return {
    name: TOOL_NAME,
    version: TOOL_VERSION,
    description: TOOL_DESCRIPTION,
    input_schema: z.toJSONSchema(AgentInput),
  };
}
