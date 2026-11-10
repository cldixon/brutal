import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cssVar, TOKENS, type TokenName } from "../src/tokens.ts";

const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
const declared = new Map(
  [...css.matchAll(/(--brutal-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
);

test("tokens.css declares every token with the value tokens.ts gives it", () => {
  for (const [name, value] of Object.entries(TOKENS)) {
    expect(declared.get(cssVar(name as TokenName))).toBe(value);
  }
});

test("tokens.css declares nothing tokens.ts doesn't", () => {
  const known = new Set(Object.keys(TOKENS).map((n) => cssVar(n as TokenName)));
  expect([...declared.keys()].filter((n) => !known.has(n))).toEqual([]);
});
