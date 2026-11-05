import { expect, test } from "bun:test";
import { ReportInput, toolDefinition } from "./index";

test("the agent's part is small and the context is optional", () => {
  expect(ReportInput.safeParse({ kind: "bug", title: "t", summary: "s" }).success).toBe(true);
  expect(ReportInput.safeParse({ kind: "bug", title: "x".repeat(101), summary: "s" }).success).toBe(
    false,
  );
});

test("the tool's JSON Schema has no integration fields", () => {
  const props = Object.keys(toolDefinition().input_schema.properties ?? {});
  expect(props).not.toContain("context");
  expect(props).toContain("kind");
});
