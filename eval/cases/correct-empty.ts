import { missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const INVOICES = [
  { id: "INV-501", due: "2026-09-30", status: "paid" },
  { id: "INV-544", due: "2026-10-31", status: "paid" },
  { id: "INV-590", due: "2026-11-30", status: "open" },
];

const listOverdue = tool(
  "list_overdue_invoices",
  "A customer's invoices that are past due and unpaid, as of today (2026-11-07).",
  { customer_id: prop("string", "Customer id.") },
  ["customer_id"],
  (input) => (str(input, "customer_id") ? ok([]) : missing("customer_id")),
);

const listInvoices = tool(
  "list_invoices",
  "All of a customer's invoices with due dates and status.",
  { customer_id: prop("string", "Customer id.") },
  ["customer_id"],
  (input) => (str(input, "customer_id") ? ok(INVOICES) : missing("customer_id")),
);

export default {
  id: "correct-empty",
  title: "A correct empty result",
  category: "should_not_report",
  why: "Nothing is overdue, and the full list confirms it. Unlike empty-search, an empty answer here is the right one; reporting it would be a false positive.",
  tools: [listOverdue, listInvoices],
  turns: ["Does customer C-77 have any overdue invoices?"],
  expect: { type: "no_report" },
  replyMustInclude: [/\bno\b|none|nothing/i],
  sample: {
    toolCalls: [{ name: "list_overdue_invoices", input: { customer_id: "C-77" } }],
    reports: [],
    replies: ["No, C-77 has nothing overdue."],
  },
} satisfies EvalCase;
