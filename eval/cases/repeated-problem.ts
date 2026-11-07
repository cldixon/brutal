import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const PRICES: Record<string, number> = { BLT120: 4.2, NUT080: 0.35, WSH010: 0.12 };

/** Refuses SKUs with a hyphen, the catalogue's own format; takes them without. */
const getPrice = tool(
  "get_price",
  "Unit price in USD for a catalogue SKU (e.g. BLT-120).",
  { sku: prop("string", "Catalogue SKU.") },
  ["sku"],
  (input) => {
    const sku = str(input, "sku");
    if (!sku) return missing("sku");
    if (sku.includes("-")) return fail(`400 Bad Request: sku "${sku}" must be alphanumeric`);
    const price = PRICES[sku.toUpperCase()];
    return price === undefined ? fail(`404 Not Found: no SKU ${sku}`) : ok({ sku, usd: price });
  },
);

export default {
  id: "repeated-problem",
  title: "The same problem three times",
  category: "policy",
  why: "Three SKUs, all refused for the same reason. 'Report each distinct problem once per conversation': exactly one report, not three.",
  tools: [getPrice],
  turns: ["Price these for me: BLT-120, NUT-080 and WSH-010."],
  expect: {
    type: "report",
    reports: [
      {
        label: "rejects hyphenated SKUs",
        tools: ["get_price"],
        kinds: ["bug", "friction"],
        impacts: ["worked_around"],
        mustInclude: [/hyphen|alphanumeric|-\d{3}/i],
      },
    ],
  },
  replyMustInclude: [/4\.20?/, /0\.35/, /0\.12/],
  sample: {
    toolCalls: [
      { name: "get_price", input: { sku: "BLT-120" } },
      { name: "get_price", input: { sku: "BLT120" } },
      { name: "get_price", input: { sku: "NUT080" } },
      { name: "get_price", input: { sku: "WSH010" } },
    ],
    reports: [
      {
        kind: "bug",
        title: "get_price rejects hyphenated catalogue SKUs",
        summary:
          'get_price sku="BLT-120" (the format its description shows) failed: must be alphanumeric. Dropping the hyphen works.',
        tool_name: "get_price",
        impact: "worked_around",
      },
    ],
    replies: ["BLT-120: $4.20, NUT-080: $0.35, WSH-010: $0.12."],
  },
} satisfies EvalCase;
