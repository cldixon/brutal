import { describe, expect, test } from "bun:test";
import type { Report } from "@brutal-ai/schema";
import { code, fenced, inert, issueContent, MAX_CALLS } from "../src/issue-body";

const base: Report = {
  id: "rep_1",
  kind: "bug",
  title: "Year filter\nrejects 2024-25",
  summary: "search_parts rejected a fiscal-year range.",
  status: "new",
  issue_url: null,
  context: {},
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const URL = "https://brutal.test/projects/prj_1/reports/rep_1";

describe("issue body", () => {
  test("title, summary, facts, context, calls and the link back", () => {
    const { title, body } = issueContent(
      {
        ...base,
        tool_name: "search_parts",
        impact: "blocked",
        user_impact: "The user retyped the year.",
        details: "Tried 2024-25; expected results.",
        context: {
          app_version: "1.2.3",
          branch: "main",
          agent_name: "otto",
          model: "some-model",
          recent_tool_calls: [
            { name: "search_parts", args: { year: "2024-25" }, status: "error", error: "bad year" },
            { name: "list_parts", status: "ok", latency_ms: 12.4, result: { n: 3 } },
          ],
        },
      },
      URL,
    );
    expect(title).toBe("Year filter rejects 2024-25");
    expect(body).toContain("search_parts rejected a fiscal-year range.");
    expect(body).toContain("**Kind:** bug · **Tool:** `search_parts` · **Impact:** blocked");
    expect(body).toContain("### User impact");
    expect(body).toContain("### Details");
    expect(body).toContain("- App version: `1.2.3`");
    expect(body).toContain("- Branch: `main`");
    expect(body).toContain("- Agent: `otto`");
    expect(body).toContain("- Model: `some-model`");
    expect(body).toContain('search_parts · error · args={"year":"2024-25"} · error=bad year');
    expect(body).toContain('list_parts · ok · 12 ms · result={"n":3}');
    expect(body.endsWith(`[View the report in Brutal](${URL})`)).toBe(true);
  });

  test("leaves out what the report doesn't have", () => {
    const { body } = issueContent(base, URL);
    expect(body).not.toContain("###");
    expect(body).toContain("**Kind:** bug");
  });

  test("long values are clipped, and only the latest calls listed", () => {
    const calls = Array.from({ length: 15 }, (_, i) => ({
      name: `tool_${i}`,
      args: "x".repeat(1000),
    }));
    const { body } = issueContent(
      { ...base, details: "d".repeat(9000), context: { recent_tool_calls: calls } },
      URL,
    );
    expect(body).toContain(`(latest ${MAX_CALLS} of 15)`);
    expect(body).not.toContain("tool_4 ");
    expect(body).toContain("tool_14");
    expect(body).not.toContain("x".repeat(201));
    expect(body).not.toContain("d".repeat(4000));
    expect(body.length).toBeLessThan(10_000);
  });

  test("mentions, references, images and HTML in report text are made inert", () => {
    const text = inert(
      "cc @octocat and @org/team, see #12 and owner/repo#3 ![x](https://t/p.png) <img src=x>",
    );
    expect(text).not.toMatch(/@[\w-]/);
    expect(text).not.toMatch(/#\d/);
    expect(text).not.toContain("![");
    expect(text).not.toContain("<img");
    expect(inert("me@example.com")).toContain("@​example");

    const { body } = issueContent(
      { ...base, summary: "Ping @admin", user_impact: "Fixes #1", title: "@here" },
      URL,
    );
    expect(body).not.toMatch(/@admin/);
    expect(body).not.toMatch(/#1\b/);
  });

  test("report text cannot close the code fence it is in", () => {
    const details = "before\n```\n# not a heading @someone\n````\nafter";
    const block = fenced(details);
    const fence = block.split("\n")[0]?.replace("text", "") ?? "";
    expect(fence).toBe("`````");
    // The block ends only at its own last line.
    const lines = block.split("\n");
    const closers = lines.filter((l) => l === fence);
    expect(closers).toHaveLength(1);
    expect(lines.at(-1)).toBe(fence);

    const { body } = issueContent({ ...base, details }, URL);
    expect(body).toContain(block);

    // Tool calls too.
    const calls = issueContent(
      { ...base, context: { recent_tool_calls: [{ name: "t", error: "```\n@x" }] } },
      URL,
    ).body;
    expect(calls).toContain("````text");
  });

  test("inline code survives backticks", () => {
    expect(code("a`b")).toBe("``a`b``");
    expect(code("`x`")).toBe("`` `x` ``");
    expect(code("multi\nline")).toBe("`multi line`");
  });
});
