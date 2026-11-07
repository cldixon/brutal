import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const PRIORITIES = ["low", "normal", "high"];

const createTicket = tool(
  "create_ticket",
  "Open an IT support ticket. `priority` is required: low, normal or high.",
  {
    title: prop("string", "What is wrong."),
    priority: prop("string", "low, normal or high.", { enum: PRIORITIES }),
  },
  ["title", "priority"],
  (input) => {
    if (!str(input, "title")) return missing("title");
    const priority = str(input, "priority");
    if (!priority) return missing("priority");
    if (!PRIORITIES.includes(priority))
      return fail(`400 Bad Request: priority must be one of ${PRIORITIES.join(", ")}`);
    return ok({ id: "IT-3304", priority, status: "open" });
  },
);

export default {
  id: "agent-validation-error",
  title: "An ordinary validation error the agent caused",
  category: "should_not_report",
  why: "The agent left out a field the schema and description both require, and got a clear 400. 'A tool returns an error' is a trigger, but this one is the agent's mistake: the case checks that the exclusion wins.",
  tools: [createTicket],
  history: [
    { user: "Open a ticket: the printer on floor 3 keeps jamming." },
    { call: "create_ticket", input: { title: "Printer on floor 3 keeps jamming" } },
  ],
  turns: [],
  expect: { type: "no_report" },
  replyMustInclude: [/IT-3304/],
  sample: {
    toolCalls: [
      {
        name: "create_ticket",
        input: { title: "Printer on floor 3 keeps jamming", priority: "normal" },
      },
    ],
    reports: [],
    replies: ["Done: ticket IT-3304, normal priority."],
  },
} satisfies EvalCase;
