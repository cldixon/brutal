import { expect, test } from "bun:test";
import { reportText, score, summarize } from "./score";
import { ok, tool } from "./tool";
import type { EvalCase } from "./types";

const noop = tool("lookup", "Look something up.", {}, [], () => ok(null));

const reportCase: EvalCase = {
  id: "unit",
  title: "unit",
  category: "should_report",
  why: "Scoring's own test.",
  tools: [noop],
  turns: ["Look it up."],
  expect: {
    type: "report",
    reports: [
      {
        label: "lookup",
        tools: ["lookup"],
        kinds: ["bug"],
        impacts: ["blocked"],
        mustInclude: [/broken/],
        mustNotInclude: [/secret/],
      },
    ],
  },
  replyMustInclude: [/done/],
  sample: { toolCalls: [], reports: [], replies: [] },
};

const good = {
  kind: "bug",
  title: "lookup is broken",
  summary: "It failed.",
  tool_name: "lookup",
  impact: "blocked",
};

test("a run passes when every check does", () => {
  const s = score(reportCase, { toolCalls: [], reports: [good], replies: ["done"] });
  expect(s.pass).toBe(true);
  expect(s.checks.map((c) => c.name)).toEqual([
    "report 1 is valid",
    "lookup: filed",
    "lookup: once",
    "lookup: kind",
    "lookup: impact",
    "lookup: says /broken/",
    "lookup: leaves out /secret/",
    "no other reports",
    "reply says /done/",
  ]);
});

test("tool names match case-insensitively; no tool name matches only when allowed", () => {
  const upper = { ...good, tool_name: " Lookup " };
  expect(score(reportCase, { toolCalls: [], reports: [upper], replies: ["done"] }).pass).toBe(true);
  const { tool_name: _, ...nameless } = good;
  const s = score(reportCase, { toolCalls: [], reports: [nameless], replies: ["done"] });
  expect(s.checks.filter((c) => !c.pass).map((c) => c.failure)).toEqual(["missed", "unexpected"]);
  const allowing: EvalCase = {
    ...reportCase,
    expect: {
      type: "report",
      reports: [
        {
          label: "lookup",
          tools: ["lookup"],
          allowNoTool: true,
          kinds: ["bug"],
          impacts: ["blocked"],
        },
      ],
    },
  };
  expect(score(allowing, { toolCalls: [], reports: [nameless], replies: ["done"] }).pass).toBe(
    true,
  );
});

test("an input the schema refuses is invalid, and still counted against the expectation", () => {
  const bad = { ...good, kind: "complaint", summary: "x".repeat(501) };
  const s = score(reportCase, { toolCalls: [], reports: [bad], replies: ["done"] });
  expect(s.checks.filter((c) => !c.pass).map((c) => c.failure)).toEqual(["invalid", "wrong_kind"]);
});

test("content checks read every text field, and leaks fail", () => {
  expect(reportText({ ...good, details: "d", user_impact: "u" })).toBe(
    "lookup\nlookup is broken\nIt failed.\nd\nu",
  );
  const leak = { ...good, details: "the secret was hunter2" };
  const s = score(reportCase, { toolCalls: [], reports: [leak], replies: ["done"] });
  expect(s.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual([
    "lookup: leaves out /secret/",
  ]);
});

test("a no-report case fails on any report, and checks only the last reply", () => {
  const quiet: EvalCase = { ...reportCase, expect: { type: "no_report" } };
  expect(score(quiet, { toolCalls: [], reports: [], replies: ["nope", "done"] }).pass).toBe(true);
  expect(score(quiet, { toolCalls: [], reports: [], replies: ["done", "nope"] }).pass).toBe(false);
  const s = score(quiet, { toolCalls: [], reports: [good], replies: ["done"] });
  expect(s.checks.filter((c) => !c.pass).map((c) => c.failure)).toEqual(["unexpected"]);
});

test("summarize totals runs by case and by failure", () => {
  const pass = score(reportCase, { toolCalls: [], reports: [good], replies: ["done"] });
  const dup = score(reportCase, { toolCalls: [], reports: [good, good], replies: ["done"] });
  const miss = score(reportCase, { toolCalls: [], reports: [], replies: [] });
  const sum = summarize([pass, dup, miss]);
  expect(sum.runs).toBe(3);
  expect(sum.passed).toBe(1);
  expect(sum.failures.duplicate).toBe(1);
  expect(sum.failures.missed).toBe(1);
  expect(sum.failures.reply).toBe(1);
  expect(sum.cases).toHaveLength(1);
  expect(sum.cases[0]).toMatchObject({ case: "unit", runs: 3, passed: 1 });
});
