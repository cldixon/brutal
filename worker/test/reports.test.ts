import { expect, test } from "bun:test";
import type { Kind } from "@brutal-ai/schema";
import { ReportStore } from "../src/reports";
import { bunSql } from "./harness";

const r = (title: string, kind: Kind = "bug") => ({ kind, title, summary: "s" });

test("pages newest first, filters, and migrates once", () => {
  const sql = bunSql();
  const store = new ReportStore(sql);
  for (let i = 0; i < 3; i++) store.insert(r(`r${i}`), null);
  store.insert(r("f", "friction"), "key_1");
  const first = store.list({ limit: 2 });
  expect(first.reports.map((x) => x.title)).toEqual(["f", "r2"]);
  const second = store.list({ limit: 2, before: first.next ?? "" });
  expect(second.reports.map((x) => x.title)).toEqual(["r1", "r0"]);
  expect(second.next).toBeNull();
  expect(store.list({ kind: "friction" }).reports).toHaveLength(1);
  // A second store over the same database finds the schema in place.
  expect(new ReportStore(sql).list().reports).toHaveLength(4);
});

test("updates status and issue link", () => {
  const store = new ReportStore(bunSql());
  const made = store.insert(r("x"), null);
  expect(store.update(made.id, { status: "fixed", issue_url: null })?.status).toBe("fixed");
  expect(store.update("rep_missing", { status: "fixed" })).toBeNull();
});
