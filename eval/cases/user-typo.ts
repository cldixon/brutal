import { fail, missing, ok, prop, str, tool } from "../tool";
import type { EvalCase } from "../types";

const BOOKINGS = [
  { ref: "BK-4810", guest: "R. Okafor", nights: 3 },
  { ref: "BK-4817", guest: "L. Haddad", nights: 2 },
];

const getBooking = tool(
  "get_booking",
  "Read a booking by its reference.",
  { ref: prop("string", "Booking reference, e.g. BK-1000.") },
  ["ref"],
  (input) => {
    const ref = str(input, "ref");
    if (!ref) return missing("ref");
    const booking = BOOKINGS.find((b) => b.ref === ref.toUpperCase());
    return booking ? ok(booking) : fail(`404 Not Found: no booking ${ref}`);
  },
);

const listBookings = tool("list_bookings", "List this week's bookings.", {}, [], () =>
  ok(BOOKINGS),
);

export default {
  id: "user-typo",
  title: "The user's own typo in an id",
  category: "should_not_report",
  why: "The user types BK-481O (a letter O). The tool's 404 is right; the problem is the user's input, which the description says not to report.",
  tools: [getBooking, listBookings],
  turns: ["How many nights is booking BK-481O for?"],
  expect: { type: "no_report" },
  replyMustInclude: [/BK-481/],
  sample: {
    toolCalls: [
      { name: "get_booking", input: { ref: "BK-481O" } },
      { name: "list_bookings", input: {} },
    ],
    reports: [],
    replies: [
      "There's no booking BK-481O; did you mean BK-4810 (R. Okafor, 3 nights) or BK-4817 (L. Haddad, 2 nights)?",
    ],
  },
} satisfies EvalCase;
