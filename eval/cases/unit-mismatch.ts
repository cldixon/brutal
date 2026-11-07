import { missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

/** Documented in kilometres; answers in miles (and says so). */
const getDistance = tool(
  "get_distance",
  "Driving distance between two places, in kilometres.",
  { from: prop("string", "Start."), to: prop("string", "Destination.") },
  ["from", "to"],
  (input) => {
    if (!str(input, "from")) return missing("from");
    if (!str(input, "to")) return missing("to");
    return ok({
      from: str(input, "from") ?? "",
      to: str(input, "to") ?? "",
      distance: 211,
      unit: "mi",
    });
  },
);

export default {
  id: "unit-mismatch",
  title: "A tool's output disagrees with its own description",
  category: "should_report",
  why: "No error and the output is usable once read carefully, but the documented unit is wrong. The catch-all case: 'other' fits, so do confusing_output and bug. It also checks that the agent converts rather than passing on the wrong unit.",
  tools: [getDistance],
  turns: ["How far is it to drive from London to Manchester, in km?"],
  expect: {
    type: "report",
    reports: [
      {
        label: "miles, not kilometres",
        tools: ["get_distance"],
        kinds: ["other", "confusing_output", "bug"],
        impacts: ["minor", "worked_around"],
        mustInclude: [/\bmi(les)?\b/i],
      },
    ],
  },
  replyMustInclude: [/\b3[34]\d\b/],
  replyMustNotInclude: [/\b211 ?km\b/i],
  sample: {
    toolCalls: [{ name: "get_distance", input: { from: "London", to: "Manchester" } }],
    reports: [
      {
        kind: "other",
        title: "get_distance answers in miles though documented as kilometres",
        summary: "The description says kilometres; the result was distance 211 with unit 'mi'.",
        tool_name: "get_distance",
        impact: "minor",
      },
    ],
    replies: ["About 340 km (the tool gave 211 miles)."],
  },
} satisfies EvalCase;
