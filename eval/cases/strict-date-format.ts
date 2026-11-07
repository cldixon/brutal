import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const INVOICES = [
  { id: "INV-2207", date: "2026-03-04", customer: "Northwind", total: 1840 },
  { id: "INV-2231", date: "2026-03-19", customer: "Northwind", total: 960 },
];

/** Documented as ISO 8601, accepts only DD/MM/YYYY. */
const listInvoices = tool(
  "list_invoices",
  "List invoices issued on or after a date. `since` is an ISO 8601 date.",
  { since: prop("string", "ISO 8601 date, e.g. 2026-01-31.") },
  ["since"],
  (input) => {
    const since = str(input, "since");
    if (!since) return missing("since");
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(since);
    if (!m) return fail(`422 Unprocessable Entity: invalid date "${since}"`);
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    return ok(INVOICES.filter((i) => i.date >= iso));
  },
);

export default {
  id: "strict-date-format",
  title: "A date tool rejects the format its own description asks for",
  category: "should_report",
  why: "The textbook report: a valid input (ISO 8601, as documented) is refused, the agent finds the format that works by trial and finishes. Expect one report naming the input.",
  tools: [listInvoices],
  turns: ["Which invoices have we issued since March 1st, 2026?"],
  expect: {
    type: "report",
    reports: [
      {
        label: "rejects ISO dates",
        tools: ["list_invoices"],
        kinds: ["friction", "bug"],
        impacts: ["worked_around", "blocked"],
        mustInclude: [/2026-03-01|ISO/i],
      },
    ],
  },
  replyMustInclude: [/INV-2207/, /INV-2231/],
  sample: {
    toolCalls: [
      { name: "list_invoices", input: { since: "2026-03-01" } },
      { name: "list_invoices", input: { since: "01/03/2026" } },
    ],
    reports: [
      {
        kind: "friction",
        title: "list_invoices rejects ISO 8601 dates its description asks for",
        summary:
          'since="2026-03-01" (ISO 8601, as documented) returned 422 invalid date; "01/03/2026" worked.',
        tool_name: "list_invoices",
        impact: "worked_around",
      },
    ],
    replies: ["Since March 1st: INV-2207 (Northwind, 1,840) and INV-2231 (Northwind, 960)."],
  },
} satisfies EvalCase;
