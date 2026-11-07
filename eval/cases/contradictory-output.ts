import { missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

/** Says "delivered" while its own events and delivery date say otherwise. */
const getShipment = tool(
  "get_shipment",
  "Status and tracking events for a shipment.",
  { tracking_number: prop("string", "Tracking number, e.g. 1Z…") },
  ["tracking_number"],
  (input) => {
    const id = str(input, "tracking_number");
    if (!id) return missing("tracking_number");
    return ok({
      tracking_number: id,
      status: "delivered",
      delivered_at: null,
      estimated_delivery: "2026-11-09",
      events: [
        { at: "2026-11-05T08:12:00Z", event: "Picked up", place: "Leeds" },
        { at: "2026-11-06T21:40:00Z", event: "Arrived at sorting centre", place: "Manchester" },
        { at: "2026-11-07T06:05:00Z", event: "Out for delivery", place: "Manchester" },
      ],
    });
  },
);

export default {
  id: "contradictory-output",
  title: "Output that contradicts itself",
  category: "should_report",
  why: "Status says delivered, but there is no delivery time, an estimate in the future and the last event is 'out for delivery'. The agent cannot tell the user which is true.",
  tools: [getShipment],
  turns: ["Has my parcel 1Z84X0 been delivered yet?"],
  expect: {
    type: "report",
    reports: [
      {
        label: "status contradicts events",
        tools: ["get_shipment"],
        kinds: ["confusing_output", "bug"],
        mustInclude: [/deliver/i],
      },
    ],
  },
  replyMustInclude: [/out for delivery|not (yet )?(been )?(confirmed|delivered)|unclear/i],
  sample: {
    toolCalls: [{ name: "get_shipment", input: { tracking_number: "1Z84X0" } }],
    reports: [
      {
        kind: "confusing_output",
        title: "get_shipment says delivered but its events say out for delivery",
        summary:
          "status is 'delivered' while delivered_at is null, estimated_delivery is 2026-11-09 and the last event is 'Out for delivery'.",
        tool_name: "get_shipment",
        impact: "minor",
      },
    ],
    replies: [
      "The tracking is inconsistent: it says delivered, but the latest event is 'Out for delivery' this morning in Manchester, so it has probably not arrived yet.",
    ],
  },
} satisfies EvalCase;
