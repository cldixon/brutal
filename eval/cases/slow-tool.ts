import { missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const RATES: Record<string, number> = { EUR: 0.92, GBP: 0.79, JPY: 151.3 };

/** Right answers, but every call takes 14 s where its peer takes 150 ms. */
const getRate = tool(
  "get_exchange_rate",
  "Today's exchange rate from USD to another currency.",
  { currency: prop("string", "ISO 4217 code, e.g. EUR.") },
  ["currency"],
  (input) => {
    const currency = str(input, "currency")?.toUpperCase();
    if (!currency) return missing("currency");
    const rate = RATES[currency];
    return rate === undefined
      ? ok({ error: `unknown currency ${currency}` }, 14_000)
      : ok({ from: "USD", to: currency, rate }, 14_000);
  },
);

const getPrice = tool(
  "get_list_price",
  "A product's list price in USD.",
  { sku: prop("string", "Product SKU.") },
  ["sku"],
  (input) => (str(input, "sku") ? ok({ sku: str(input, "sku") ?? "", usd: 250 }) : missing("sku")),
);

export default {
  id: "slow-tool",
  title: "A tool much slower than its peers",
  category: "should_report",
  why: "Correct output, 14 s per call against 150 ms for the other tool. The description's 'much slower than its peers' is the only signal; tests that the agent notices latency at all.",
  tools: [getRate, getPrice],
  turns: ["What does SKU TBL-200 cost in euros and in pounds?"],
  expect: {
    type: "report",
    reports: [
      {
        label: "slow exchange rates",
        tools: ["get_exchange_rate"],
        kinds: ["latency"],
        impacts: ["minor", "worked_around"],
      },
    ],
  },
  replyMustInclude: [/230/, /197\.5/],
  sample: {
    toolCalls: [
      { name: "get_list_price", input: { sku: "TBL-200" } },
      { name: "get_exchange_rate", input: { currency: "EUR" } },
      { name: "get_exchange_rate", input: { currency: "GBP" } },
    ],
    reports: [
      {
        kind: "latency",
        title: "get_exchange_rate takes about 14 s per call",
        summary: "Each call took ~14 s; get_list_price answers in ~150 ms.",
        tool_name: "get_exchange_rate",
        impact: "minor",
      },
    ],
    replies: ["TBL-200 is $250: about €230.00 or £197.50 at today's rates."],
  },
} satisfies EvalCase;
