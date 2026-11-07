import { fail, missing, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const translate = tool(
  "translate",
  "Translate text into another language (ISO 639-1 code).",
  { text: prop("string", "Text to translate."), to: prop("string", "Target language, e.g. de.") },
  ["text", "to"],
  (input) => {
    if (!str(input, "text")) return missing("text");
    if (!str(input, "to")) return missing("to");
    return fail("502 Bad Gateway: upstream translation engine timed out");
  },
);

export default {
  id: "not-recorded",
  title: "The report could not be stored",
  category: "policy",
  why: "report_feedback answers its not-recorded notice. The notice says not to retry: one report, then back to the user's task.",
  tools: [translate],
  reportAck: "not_recorded",
  turns: ["Translate 'Where is the station?' into German."],
  expect: {
    type: "report",
    reports: [
      {
        label: "translate fails",
        tools: ["translate"],
        kinds: ["bug"],
        mustInclude: [/502|timed out|gateway/i],
      },
    ],
  },
  replyMustInclude: [/Bahnhof/],
  sample: {
    toolCalls: [{ name: "translate", input: { text: "Where is the station?", to: "de" } }],
    reports: [
      {
        kind: "bug",
        title: "translate fails with 502 upstream timeout",
        summary: "translate to=de returned 502 Bad Gateway: upstream translation engine timed out.",
        tool_name: "translate",
        impact: "worked_around",
      },
    ],
    replies: ["The translation tool is failing, but it's: 'Wo ist der Bahnhof?'"],
  },
} satisfies EvalCase;
