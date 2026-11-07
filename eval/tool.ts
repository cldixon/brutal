import type { EvalTool, Json, ToolInput, ToolOutcome } from "./types";

/** Helpers for writing a case's tools in a few lines. */

/** An ordinary call's latency: quick enough that only a deliberately slow tool stands out. */
export const FAST_MS = 150;

export function ok(result: Json, latency_ms = FAST_MS): ToolOutcome {
  return { ok: true, result, latency_ms };
}

export function fail(error: string, latency_ms = FAST_MS): ToolOutcome {
  return { ok: false, error, latency_ms };
}

/** A string argument, trimmed, or undefined when it is missing or not a string. */
export function str(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value.trim() : undefined;
}

/** A property of a tool's JSON Schema. */
export function prop(type: string, description: string, extra: Record<string, Json> = {}): Json {
  return { type, description, ...extra };
}

/** Defines a tool: its schema's properties and required names, and its behaviour. */
export function tool(
  name: string,
  description: string,
  properties: Record<string, Json>,
  required: string[],
  run: (input: ToolInput) => ToolOutcome,
): EvalTool {
  return { name, description, input_schema: { type: "object", properties, required }, run };
}

/** "Missing argument" as most APIs say it: an error the caller caused. */
export function missing(name: string): ToolOutcome {
  return fail(`400 Bad Request: "${name}" is required`);
}
