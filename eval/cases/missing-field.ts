import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

/** Promises a total; never returns one. */
const getOrder = tool(
  "get_order",
  "Read an order: its lines, status and total (with tax, in the order's currency).",
  { id: prop("string", "Order id.") },
  ["id"],
  (input) => {
    const id = str(input, "id");
    if (!id) return missing("id");
    if (id !== "SO-9001") return fail(`404 Not Found: no order ${id}`);
    return ok({
      id,
      status: "paid",
      currency: "EUR",
      lines: [
        { sku: "CHR-11", qty: 4, unit_price: null },
        { sku: "TBL-200", qty: 1, unit_price: null },
      ],
    });
  },
);

export default {
  id: "missing-field",
  title: "Output missing what its description promises",
  category: "should_report",
  why: "The description promises a total; the result has none, and unit prices are null, so the agent cannot answer. Tests 'missing what it should hold' with impact blocked.",
  tools: [getOrder],
  turns: ["What was the total for order SO-9001?"],
  expect: {
    type: "report",
    reports: [
      {
        label: "no total",
        tools: ["get_order"],
        kinds: ["bug", "confusing_output"],
        impacts: ["blocked"],
        mustInclude: [/total/i],
      },
    ],
  },
  replyMustNotInclude: [/€\s?\d|\d\s?(EUR|euros?)\b/i],
  sample: {
    toolCalls: [{ name: "get_order", input: { id: "SO-9001" } }],
    reports: [
      {
        kind: "bug",
        title: "get_order returns no total and null unit prices",
        summary:
          "get_order SO-9001 has no total field and every line's unit_price is null, though the description promises a total.",
        tool_name: "get_order",
        impact: "blocked",
      },
    ],
    replies: [
      "SO-9001 is paid, but the order system didn't return a total or line prices, so I can't tell you the amount.",
    ],
  },
} satisfies EvalCase;
