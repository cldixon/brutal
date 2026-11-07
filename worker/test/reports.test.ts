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

test("deletes one report, or a conversation's, and says how many", () => {
  const store = new ReportStore(bunSql());
  const a = store.insert({ ...r("a"), context: { conversation_id: "c1" } }, null);
  store.insert({ ...r("b"), context: { conversation_id: "c1" } }, null);
  const c = store.insert({ ...r("c"), context: { conversation_id: "c2" } }, null);
  expect(store.delete(a.id)).toBe(true);
  expect(store.delete(a.id)).toBe(false);
  expect(store.deleteConversation("c1")).toBe(1);
  expect(store.deleteConversation("c1")).toBe(0);
  expect(store.list().reports.map((x) => x.id)).toEqual([c.id]);
});

test("retention is stored, validated, and prunes only what's older", () => {
  const sql = bunSql();
  const store = new ReportStore(sql);
  expect(store.retention()).toBeNull();
  const old = store.insert(r("old"), null);
  const recent = store.insert(r("recent"), null);
  sql.run("UPDATE reports SET created_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", old.id);
  sql.run("UPDATE reports SET created_at = ? WHERE id = ?", "2026-03-25T00:00:00.000Z", recent.id);
  const now = Date.parse("2026-04-01T00:00:00.000Z");
  expect(store.prune(now)).toBe(0); // no retention: nothing goes
  expect(store.setRetention(30)).toBe(30);
  expect(new ReportStore(sql).retention()).toBe(30);
  expect(store.prune(now)).toBe(1);
  expect(store.list().reports.map((x) => x.title)).toEqual(["recent"]);
  for (const bad of [0, -1, 1.5, 3651, Number.NaN]) {
    expect(() => store.setRetention(bad)).toThrow();
  }
  expect(store.setRetention(null)).toBeNull();
  expect(store.retention()).toBeNull();
});
