import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrutalConfig } from "../config";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["BRUTAL_CONFIG", "BRUTAL_WORKER", "BRUTAL_DOMAIN", "BRUTAL_SETUP"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const folder = (config?: object) => {
  const dir = mkdtempSync(join(tmpdir(), "brutal-config-"));
  if (config) writeFileSync(join(dir, "brutal.config.json"), JSON.stringify(config));
  return dir;
};

test("the owner's file, with environment overrides", () => {
  delete process.env.BRUTAL_CONFIG;
  const dir = folder({ worker: "mine", domain: "brutal.example.com" });
  expect(loadBrutalConfig(dir)).toMatchObject({ worker: "mine", domain: "brutal.example.com" });
  process.env.BRUTAL_DOMAIN = "";
  expect(loadBrutalConfig(dir).domain).toBeNull();
});

test("no settings: refused, unless defaults are allowed", () => {
  delete process.env.BRUTAL_CONFIG;
  const dir = folder();
  expect(() => loadBrutalConfig(dir)).toThrow("No brutal.config.json");
  expect(loadBrutalConfig(dir, { allowDefaults: true }).worker).toBe("brutal");
});

test("BRUTAL_CONFIG names another file, and must exist", () => {
  const dir = folder();
  writeFileSync(join(dir, "ci.json"), JSON.stringify({ worker: "ci" }));
  process.env.BRUTAL_CONFIG = "ci.json";
  expect(loadBrutalConfig(dir).worker).toBe("ci");
  process.env.BRUTAL_CONFIG = "missing.json";
  expect(() => loadBrutalConfig(dir)).toThrow("doesn't exist");
});
