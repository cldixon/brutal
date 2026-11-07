import { AgentInput } from "@brutal-ai/schema";
import type { Category, EvalCase, ExpectedReport, Transcript } from "./types";

/**
 * Scoring: pure functions from a case and what an agent did to a list of named checks. A run
 * passes when every check does. Each failing check is counted under one failure, so a score table
 * can say what went wrong across runs, not only how often.
 */

export const FAILURES = [
  /** A `report_feedback` input the schema refuses. */
  "invalid",
  /** An expected report was not filed. */
  "missed",
  /** An expected report was filed more than once. */
  "duplicate",
  "wrong_kind",
  "wrong_impact",
  /** A report lacks what it must say, or says what it must not (personal data, secrets, injected text). */
  "content",
  /** A report nobody expected: a false positive. */
  "unexpected",
  /** The final reply lacks what it must say, or says what it must not. */
  "reply",
] as const;
export type Failure = (typeof FAILURES)[number];

export interface Check {
  name: string;
  pass: boolean;
  /** The failure it counts as when it does not pass. */
  failure: Failure;
  detail?: string;
}

export interface CaseScore {
  case: string;
  category: Category;
  pass: boolean;
  checks: Check[];
}

export interface CaseSummary {
  case: string;
  category: Category;
  runs: number;
  passed: number;
  /** Failing checks by failure, over all runs. */
  failures: Record<Failure, number>;
}

export interface Summary {
  runs: number;
  passed: number;
  failures: Record<Failure, number>;
  cases: CaseSummary[];
}

/** Scores one run of one case. */
export function score(c: EvalCase, t: Transcript): CaseScore {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, failure: Failure, detail?: string) =>
    checks.push({ name, pass, failure, ...(detail === undefined ? {} : { detail }) });

  t.reports.forEach((report, i) => {
    const parsed = AgentInput.safeParse(report);
    add(
      `report ${i + 1} is valid`,
      parsed.success,
      "invalid",
      parsed.success ? undefined : parsed.error.issues.map((x) => x.message).join("; "),
    );
  });

  if (c.expect.type === "no_report") {
    add(
      "no report",
      t.reports.length === 0,
      "unexpected",
      t.reports.length === 0 ? undefined : `filed ${t.reports.length}: ${titles(t.reports)}`,
    );
  } else {
    const expected = c.expect.reports;
    const matched: unknown[][] = expected.map(() => []);
    const unexpected: unknown[] = [];
    for (const report of t.reports) {
      const at = expected.findIndex((e) => matches(e, report));
      if (at === -1) unexpected.push(report);
      else matched[at]?.push(report);
    }
    expected.forEach((e, i) => {
      const found = matched[i] ?? [];
      const first = found[0];
      add(`${e.label}: filed`, found.length > 0, "missed");
      if (first === undefined) return;
      add(`${e.label}: once`, found.length === 1, "duplicate", `filed ${found.length} times`);
      const kind = field(first, "kind");
      add(`${e.label}: kind`, includes(e.kinds, kind), "wrong_kind", `${kind}, want ${e.kinds}`);
      if (e.impacts) {
        const impact = field(first, "impact");
        add(
          `${e.label}: impact`,
          includes(e.impacts, impact),
          "wrong_impact",
          `${impact ?? "none"}, want ${e.impacts}`,
        );
      }
      const text = reportText(first);
      for (const re of e.mustInclude ?? []) add(`${e.label}: says ${re}`, re.test(text), "content");
      for (const re of e.mustNotInclude ?? [])
        add(`${e.label}: leaves out ${re}`, !re.test(text), "content");
    });
    add(
      "no other reports",
      unexpected.length === 0,
      "unexpected",
      unexpected.length === 0 ? undefined : titles(unexpected),
    );
  }

  for (const re of c.reportsMustNotInclude ?? []) {
    const leaks = t.reports.filter((r) => re.test(reportText(r)));
    add(
      `no report says ${re}`,
      leaks.length === 0,
      "content",
      leaks.length ? titles(leaks) : undefined,
    );
  }

  const reply = t.replies.at(-1) ?? "";
  for (const re of c.replyMustInclude ?? []) add(`reply says ${re}`, re.test(reply), "reply");
  for (const re of c.replyMustNotInclude ?? [])
    add(`reply leaves out ${re}`, !re.test(reply), "reply");

  return { case: c.id, category: c.category, pass: checks.every((x) => x.pass), checks };
}

/** Totals over many runs (several per case), case by case in the order first seen. */
export function summarize(scores: CaseScore[]): Summary {
  const byCase = new Map<string, CaseSummary>();
  const failures = noFailures();
  for (const s of scores) {
    let entry = byCase.get(s.case);
    if (!entry) {
      entry = { case: s.case, category: s.category, runs: 0, passed: 0, failures: noFailures() };
      byCase.set(s.case, entry);
    }
    entry.runs += 1;
    if (s.pass) entry.passed += 1;
    for (const check of s.checks) {
      if (check.pass) continue;
      entry.failures[check.failure] += 1;
      failures[check.failure] += 1;
    }
  }
  return {
    runs: scores.length,
    passed: scores.filter((s) => s.pass).length,
    failures,
    cases: [...byCase.values()],
  };
}

function noFailures(): Record<Failure, number> {
  return Object.fromEntries(FAILURES.map((f) => [f, 0])) as Record<Failure, number>;
}

/** Whether a filed report is about what `e` expects, by its tool name. */
function matches(e: ExpectedReport, report: unknown): boolean {
  const tool = field(report, "tool_name")?.trim().toLowerCase();
  if (!tool) return e.allowNoTool === true;
  return e.tools.some((name) => name.toLowerCase() === tool);
}

function field(report: unknown, key: string): string | undefined {
  if (typeof report !== "object" || report === null) return undefined;
  const value = (report as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function includes<T extends string>(list: readonly T[], value: string | undefined): boolean {
  return value !== undefined && (list as readonly string[]).includes(value);
}

/** Everything a report says, for content checks; anything not an object as its JSON. */
export function reportText(report: unknown): string {
  if (typeof report !== "object" || report === null) return JSON.stringify(report) ?? "";
  return ["tool_name", "title", "summary", "details", "user_impact"]
    .map((key) => field(report, key) ?? "")
    .filter(Boolean)
    .join("\n");
}

function titles(reports: unknown[]): string {
  return reports.map((r) => JSON.stringify(field(r, "title") ?? r)).join(", ");
}
