#!/usr/bin/env bun
/**
 * One-time bootstrap: npm only lets a package trust a publishing workflow once the package
 * exists, so this publishes an empty 0.0.0-stage placeholder of each package, under the dist-tag
 * `stage` (igloo did the same). Then, on npmjs.com, each package's Settings gets the trusted
 * publisher cldixon/brutal, workflow release.yml, and release.yml publishes every real version.
 *
 *   bun scripts/stage-npm.ts                publish the placeholders not yet on npm
 *   bun scripts/stage-npm.ts --dry-run      show what would be published
 *   bun scripts/stage-npm.ts --otp 123456   pass a one-time password (it expires in ~30 s)
 *
 * Needs npm credentials that may create packages (npm login). npm runs attached to this
 * terminal, so it can ask for two-factor authentication (open the URL it prints, or press ENTER).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const PACKAGES = ["@brutal-ai/schema", "@brutal-ai/sdk", "@brutal-ai/server", "create-brutal-ai"];
const VERSION = "0.0.0-stage";
const dryRun = process.argv.includes("--dry-run");
const otpAt = process.argv.indexOf("--otp");
const otp = otpAt === -1 ? undefined : process.argv[otpAt + 1];

for (const name of PACKAGES) {
  const existing = await $`npm view ${name} version`.nothrow().quiet();
  if (existing.exitCode === 0) {
    console.log(`✓ ${name} already exists on npm`);
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), "brutal-stage-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: VERSION,
        description: "Placeholder so release.yml can publish with npm trusted publishing.",
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/cldixon/brutal.git" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}\n\nA placeholder. See [Brutal](https://github.com/cldixon/brutal).\n`,
  );
  const args = [
    "publish",
    "--access",
    "public",
    "--tag",
    "stage",
    ...(dryRun ? ["--dry-run"] : []),
  ];
  await $`npm ${args}`.cwd(dir);
  console.log(`✓ ${dryRun ? "Would publish" : "Published"} ${name}@${VERSION}`);
}
