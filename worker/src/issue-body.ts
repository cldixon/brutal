import type { Report, ToolCall } from "@brutal-ai/schema";

/**
 * A report as an issue: its title and a markdown body for GitHub or Linear. Pure, so the
 * clustering feature (#14) can build an issue for a group of reports from the same parts.
 *
 * Report text was written by an agent from what it saw, so it is untrusted: nothing in it may
 * ping a person (`@name`), reference another issue (`owner/repo#1` leaves a mark on that issue),
 * pull in an image (a tracking pixel), or close the code fences it is put in.
 */

export interface IssueContent {
  title: string;
  body: string;
}

const ZWSP = "​";

/** Clips text to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Prose from a report, made inert: a zero-width space after `@` and `#` before a name or a
 * number stops mentions and issue references; images become plain links' text; raw HTML tags
 * show as text.
 */
export function inert(text: string): string {
  return text
    .replace(/@(?=[\w-])/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/!\[/g, "!\\[")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** One line of prose: newlines folded, made inert. */
const line = (text: string) => inert(text.replace(/\s+/g, " ").trim());

/** A code fence that no run of backticks (or tildes) in `text` can close. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Inline code that a backtick in `text` cannot end early. */
export function code(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

const show = (v: unknown) => (typeof v === "string" ? v : (JSON.stringify(v) ?? ""));

/** One recorded tool call as a line: name, status, latency, then args and result, clipped. */
function callLine(call: ToolCall): string {
  const parts = [clip(call.name, 100)];
  if (call.status) parts.push(call.status);
  if (call.latency_ms !== undefined) parts.push(`${Math.round(call.latency_ms)} ms`);
  if (call.args !== undefined) parts.push(`args=${clip(show(call.args), 200)}`);
  if (call.error) parts.push(`error=${clip(call.error, 200)}`);
  else if (call.result !== undefined) parts.push(`result=${clip(show(call.result), 200)}`);
  return parts.join(" · ").replace(/\n/g, " ");
}

/** How many recorded calls the body lists: the latest ones. */
export const MAX_CALLS = 10;

export function issueContent(report: Report, reportUrl: string): IssueContent {
  const title = clip(report.title.replace(/\s+/g, " ").trim(), 200) || "Feedback report";
  const out: string[] = [];

  out.push(line(report.summary), "");

  const facts: string[] = [`**Kind:** ${report.kind}`];
  if (report.tool_name) facts.push(`**Tool:** ${code(clip(report.tool_name, 200))}`);
  if (report.impact) facts.push(`**Impact:** ${report.impact}`);
  out.push(facts.join(" · "), "");

  if (report.user_impact) out.push("### User impact", "", line(clip(report.user_impact, 1000)), "");
  if (report.details) out.push("### Details", "", fenced(clip(report.details, 4000)), "");

  const ctx = report.context ?? {};
  const contextRows: [string, string | undefined][] = [
    ["App version", ctx.app_version],
    ["Branch", ctx.branch],
    ["Environment", ctx.environment],
    ["Agent", ctx.agent_name],
    ["Model", ctx.model],
    ["SDK", ctx.sdk && (ctx.sdk_version ? `${ctx.sdk} ${ctx.sdk_version}` : ctx.sdk)],
  ];
  const shown = contextRows.filter((r): r is [string, string] => Boolean(r[1]));
  if (shown.length) {
    out.push("### Context", "");
    for (const [name, value] of shown) out.push(`- ${name}: ${code(clip(value, 200))}`);
    out.push("");
  }

  const calls = ctx.recent_tool_calls ?? [];
  if (calls.length) {
    const latest = calls.slice(-MAX_CALLS);
    const more = calls.length - latest.length;
    out.push(
      `### Recent tool calls${more ? ` (latest ${latest.length} of ${calls.length})` : ""}`,
      "",
      fenced(latest.map(callLine).join("\n")),
      "",
    );
  }

  out.push(`[View the report in Brutal](${reportUrl})`);
  return { title, body: out.join("\n") };
}
