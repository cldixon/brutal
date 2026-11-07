import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const ORDERS = [
  { id: "SO-7710", placed: "2026-10-28", items: ["Standing desk frame"] },
  { id: "SO-7655", placed: "2026-09-02", items: ["Monitor arm"] },
];

/** Fails with a server error whenever orders are asked for with the customer. */
const getCustomer = tool(
  "get_customer",
  "Read a customer by id. Set include_orders to embed their orders, newest first.",
  {
    id: prop("string", "Customer id, e.g. C-1."),
    include_orders: prop("boolean", "Embed the customer's orders."),
  },
  ["id"],
  (input) => {
    const id = str(input, "id");
    if (!id) return missing("id");
    if (id !== "C-1042") return fail(`404 Not Found: no customer ${id}`);
    if (input.include_orders === true)
      return fail(
        "500 Internal Server Error: TypeError: Cannot read properties of undefined (reading 'lines')",
      );
    return ok({ id, company: "Bluebell Interiors", since: "2023-04-11" });
  },
);

const listOrders = tool(
  "list_orders",
  "List a customer's orders, newest first.",
  { customer_id: prop("string", "Customer id.") },
  ["customer_id"],
  (input) => {
    const id = str(input, "customer_id");
    if (!id) return missing("customer_id");
    return ok(id === "C-1042" ? ORDERS : []);
  },
);

export default {
  id: "worked-around-error",
  title: "A server error the agent worked around",
  category: "should_report",
  why: "One documented option makes the tool crash; the agent gets the same data from another tool. Finishing the task does not make the crash fine: expect a bug, worked around.",
  tools: [getCustomer, listOrders],
  turns: [
    "Which company is customer C-1042, and what did they last order? Use one call if you can.",
  ],
  expect: {
    type: "report",
    reports: [
      {
        label: "include_orders crashes",
        tools: ["get_customer"],
        kinds: ["bug"],
        impacts: ["worked_around"],
        mustInclude: [/include_orders|500/i],
      },
    ],
  },
  replyMustInclude: [/Bluebell/, /desk/i],
  sample: {
    toolCalls: [
      { name: "get_customer", input: { id: "C-1042", include_orders: true } },
      { name: "get_customer", input: { id: "C-1042" } },
      { name: "list_orders", input: { customer_id: "C-1042" } },
    ],
    reports: [
      {
        kind: "bug",
        title: "get_customer returns 500 with include_orders=true",
        summary:
          "get_customer {id: C-1042, include_orders: true} failed with a 500 TypeError (reading 'lines'); without the flag it works, so I used list_orders.",
        tool_name: "get_customer",
        impact: "worked_around",
      },
    ],
    replies: [
      "C-1042 is Bluebell Interiors; their latest order, SO-7710 on 28 October, was a standing desk frame.",
    ],
  },
} satisfies EvalCase;
