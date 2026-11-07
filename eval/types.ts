import type { Impact, Kind } from "@brutal-ai/schema/constants";

/**
 * An eval case: a user's task, the tools the agent gets for it (deterministic, some broken on
 * purpose) and what the agent should do with `report_feedback`. Cases are data; the runner (a
 * later PR) turns one into a conversation with a model and hands what the model did to `score`.
 */

/** A JSON value a tool takes or returns. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The input a model passes to a tool. Tools read it defensively: a model can pass anything. */
export type ToolInput = Record<string, unknown>;

/** What one call to a tool gives back. `latency_ms` is how long the call takes (see README). */
export type ToolOutcome =
  | { ok: true; result: Json; latency_ms: number }
  | { ok: false; error: string; latency_ms: number };

/** A tool as the agent sees it (name, description, JSON Schema) plus its behaviour. */
export interface EvalTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, Json>;
    required?: string[];
  };
  /** Pure: the same input always gives the same outcome. */
  run(input: ToolInput): ToolOutcome;
}

/** Turns replayed before the live run, so a case can start after something already happened. */
export type HistoryStep =
  | { user: string }
  | { assistant: string }
  /** The agent's earlier call; the runner replays it through the case's tool for its result. */
  | { call: string; input: ToolInput };

/** A report the case expects. A filed report matches it by `tool_name`. */
export interface ExpectedReport {
  /** Short label, used in check names. */
  label: string;
  /** Tool names a matching report may give (compared case-insensitively). */
  tools: string[];
  /** Whether a report with no `tool_name` also matches (for a capability no tool offers). */
  allowNoTool?: boolean;
  /** Kinds that count as right. Several where reasonable people would pick differently. */
  kinds: Kind[];
  /** Impacts that count as right; leave out where it does not matter. */
  impacts?: Impact[];
  /** Each must appear somewhere in the report's text. */
  mustInclude?: RegExp[];
  /** None may appear in the report's text. */
  mustNotInclude?: RegExp[];
}

export type Expectation =
  | {
      type: "report";
      /** Each must be filed exactly once; any other report is unexpected. */
      reports: ExpectedReport[];
    }
  | { type: "no_report" };

/** What the case is about, for grouping in the score table. */
export type Category = "should_report" | "should_not_report" | "policy";

export interface EvalCase {
  id: string;
  title: string;
  category: Category;
  /** What the case tests and why it matters, one or two sentences. */
  why: string;
  /** The agent's own system prompt (the runner adds the report tool's wording to it). */
  system?: string;
  tools: EvalTool[];
  history?: HistoryStep[];
  /**
   * Live user turns, in order; the agent answers each in full before the next. Empty only
   * when `history` ends with a call, and the agent picks up from its result.
   */
  turns: string[];
  /** What `report_feedback` answers: recorded (default), or the not-recorded notice. */
  reportAck?: "recorded" | "not_recorded";
  expect: Expectation;
  /** None may appear in any report's text, whatever it is about (secrets, injected text). */
  reportsMustNotInclude?: RegExp[];
  /** Each must appear in the agent's last reply (the task was done, or disclosure was honest). */
  replyMustInclude?: RegExp[];
  /** None may appear in the agent's last reply. */
  replyMustNotInclude?: RegExp[];
  /** A hand-written transcript that passes every check: documentation, and a test fixture. */
  sample: Transcript;
}

/** What an agent did in a run: the calls it made, the reports it filed and what it said. */
export interface Transcript {
  /** Its calls to the case's tools, in order (not `report_feedback`, not history). */
  toolCalls: { name: string; input: ToolInput }[];
  /** The input of each `report_feedback` call, as the model gave it (validated by `score`). */
  reports: unknown[];
  /** Its final text after each live user turn (or the one continuation). */
  replies: string[];
}
