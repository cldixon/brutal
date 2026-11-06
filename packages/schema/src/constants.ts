/** The schema's fixed lists, with no dependencies, so a web page can use them without zod. */

export const KINDS = [
  "bug",
  "friction",
  "missing_capability",
  "confusing_output",
  "latency",
  "eval_candidate",
  "other",
] as const;
export const IMPACTS = ["blocked", "worked_around", "minor"] as const;
export const STATUSES = ["new", "triaged", "linked", "fixed", "verified", "wont_fix"] as const;

export type Kind = (typeof KINDS)[number];
export type Impact = (typeof IMPACTS)[number];
export type Status = (typeof STATUSES)[number];
