#!/usr/bin/env bun
/**
 * One-time bootstrap: npm only lets a package trust a publishing workflow once the package
 * exists, and refuses placeholder versions, so the first release (worker/package.json's version)
 * is published by hand from the tarballs `bun run pack` builds, exactly as release.yml would.
 * Then, on npmjs.com, each package's Settings gets the trusted publisher cldixon/brutal,
 * workflow release.yml, and release.yml publishes every later version.
 *
 *   bun scripts/first-release.ts                packs, then publishes what is not on npm yet
 *   bun scripts/first-release.ts --dry-run      shows what would be published
 *   bun scripts/first-release.ts --otp 123456   passes a one-time password (expires in ~30 s)
 *
 * Needs `npm login`. npm runs attached to this terminal, so it can ask for two-factor
 * authentication. Re-running skips what is already published.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dirname, "..");
const version: string = JSON.parse(
  readFileSync(join(root, "worker", "package.json"), "utf-8"),
).version;
// Schema before the SDK that depends on it, as release.yml publishes them.
const PACKAGES = [
  ["@brutal-ai/schema", "brutal-ai-schema"],
  ["@brutal-ai/sdk", "brutal-ai-sdk"],
  ["@brutal-ai/server", "brutal-ai-server"],
  ["create-brutal-ai", "create-brutal-ai"],
] as const;
const dryRun = process.argv.includes("--dry-run");
const otpAt = process.argv.indexOf("--otp");
const otp = otpAt === -1 ? undefined : process.argv[otpAt + 1];

await $`bun run pack`.cwd(root);

for (const [name, file] of PACKAGES) {
  const existing = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();
  if (existing.stdout.toString().trim()) {
    console.log(`✓ ${name}@${version} is already on npm`);
    continue;
  }
  const args = [
    "publish",
    join(root, "dist", `${file}-${version}.tgz`),
    "--access",
    "public",
    ...(dryRun ? ["--dry-run"] : []),
    ...(otp ? ["--otp", otp] : []),
  ];
  // Attached to this terminal, so npm's two-factor prompt reaches the person running this.
  const code = await Bun.spawn(["npm", ...args], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
  if (code !== 0) {
    console.error(`✗ ${name} was not published (npm exited ${code}). Re-run to continue.`);
    process.exit(code);
  }
  console.log(`✓ ${dryRun ? "Would publish" : "Published"} ${name}@${version}`);
}
