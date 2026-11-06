import { createBrutal } from "@brutal/sdk";

/**
 * A stand-in agent (no model) working against deliberately broken tools, to see the SDK file a
 * report with its recent tool calls attached. The agent names the tool and its judgment only.
 *
 *   BRUTAL_URL=… BRUTAL_INGEST_KEY=… bun run --cwd examples broken-tools
 */
const endpoint = process.env.BRUTAL_URL;
const ingestKey = process.env.BRUTAL_INGEST_KEY;
if (!endpoint || !ingestKey) throw new Error("Set BRUTAL_URL and BRUTAL_INGEST_KEY.");

const brutal = createBrutal({
  endpoint,
  ingestKey,
  context: () => ({ app_version: "example-0.1.0", environment: "example", agent_name: "example" }),
  onError: (error) => console.error("report not delivered:", error),
});

// The broken tools: a strict date format, a search that always comes back empty.
const tools = {
  findWorkOrders: async ({ year }: { year: string }) => {
    if (!/^\d{4}$/.test(year)) throw new Error(`invalid year "${year}": expected YYYY`);
    return [{ id: "WO-1", year }];
  },
  searchParts: async (_: { query: string }) => [] as string[],
};

const convo = brutal.conversation(`example-${Date.now()}`);
const findWorkOrders = convo.wrap("find_work_orders", tools.findWorkOrders);
const searchParts = convo.wrap("search_parts", tools.searchParts);

// What a model would do: try the user's format, work around it, then report.
await findWorkOrders({ year: "FY2025" }).catch(() => undefined);
await findWorkOrders({ year: "2025" });
await searchParts({ query: "hydraulic pump seal" });

console.log(
  await convo.handle({
    kind: "friction",
    title: "find_work_orders rejects fiscal years",
    summary: "The user asked for FY2025; the tool only takes YYYY, so I retried with 2025.",
    tool_name: "find_work_orders",
    impact: "worked_around",
  }),
);
console.log(
  await convo.handle({
    kind: "confusing_output",
    title: "search_parts returned nothing for a common part",
    summary: "Zero results for 'hydraulic pump seal' looks wrong for a parts catalogue.",
    tool_name: "search_parts",
    impact: "blocked",
  }),
);
