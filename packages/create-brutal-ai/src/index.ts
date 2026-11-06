#!/usr/bin/env bun
/**
 * `bun create brutal-ai [folder]`: make a folder that deploys a Brutal instance to your own
 * Cloudflare account.
 *
 * The folder holds the owner's settings (brutal.config.json) and depends on @brutal-ai/server,
 * which ships the prebuilt Worker and the brutal-server CLI. It is meant to be its own git repo:
 * commit it, and updating Brutal is bumping that dependency.
 *
 *   --from <spec>   install @brutal-ai/server from <spec> instead of npm (a version, or a
 *                   tarball path or URL)
 *   --no-deploy     stop after setup
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";

declare const BRUTAL_VERSION: string;
declare const CF_VERSION: string;
declare const WRANGLER_VERSION: string;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const from = flag("--from");
const noDeploy = args.includes("--no-deploy");
const folder = args.find((a) => !a.startsWith("--")) ?? "my-brutal";
const dir = resolve(folder);
process.env.CF_SEND_TELEMETRY ??= "false";

if (existsSync(dir) && readdirSync(dir).length > 0) {
  console.error(`${folder} already exists and isn't empty.`);
  process.exit(1);
}

console.log(`\nCreating a Brutal instance in ${folder}\n`);
mkdirSync(dir, { recursive: true });

const files: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: folder.split("/").pop(),
      private: true,
      type: "module",
      scripts: {
        setup: "brutal-server setup",
        deploy: "brutal-server deploy",
        dev: "brutal-server dev",
        secrets: "brutal-server secrets",
      },
      dependencies: {
        "@brutal-ai/server": from ? resolveSpec(from) : `^${BRUTAL_VERSION}`,
        cf: CF_VERSION,
        wrangler: WRANGLER_VERSION,
      },
    },
    null,
    2,
  )}\n`,
  "cloudflare.config.ts": `import { defineBrutal } from "@brutal-ai/server/config";

// Your settings are in brutal.config.json (\`bun run setup\` writes it).
export default defineBrutal({ dir: import.meta.dirname });
`,
  ".github/workflows/deploy.yml": `name: Deploy

# Deploys this Brutal instance on every push to main, using the repo secret
# CLOUDFLARE_API_TOKEN. Without the secret, it skips with a notice.
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      CF_SEND_TELEMETRY: "false"
    steps:
      - name: No token, no deploy
        if: env.CLOUDFLARE_API_TOKEN == ''
        run: echo "::notice::Not deploying. Add the CLOUDFLARE_API_TOKEN repo secret to deploy on push."
      - uses: actions/checkout@v5
        if: env.CLOUDFLARE_API_TOKEN != ''
      - uses: oven-sh/setup-bun@v2
        if: env.CLOUDFLARE_API_TOKEN != ''
      - run: bun install --frozen-lockfile
        if: env.CLOUDFLARE_API_TOKEN != ''
      - run: bun run deploy
        if: env.CLOUDFLARE_API_TOKEN != ''
`,
  ".gitignore": "node_modules/\n.cloudflare/\n.wrangler/\n",
  "README.md": `# My Brutal

A [Brutal](https://github.com/cldixon/brutal) instance: feedback from your agents, on your own
Cloudflare account. Its settings are in \`brutal.config.json\`; the code comes from
[\`@brutal-ai/server\`](https://www.npmjs.com/package/@brutal-ai/server).

| Command | What it does |
| --- | --- |
| \`bun run setup\` | Change the settings (re-run any time) |
| \`bun run deploy\` | Deploy. The first deploy prints the setup code: open \`/setup\` and enter it for your keys |
| \`bun run dev\` | Run it locally on http://localhost:8787 |

**Update Brutal:** \`bun update @brutal-ai/server && bun run deploy\`. Migrations apply themselves.

**Deploy on push (optional):** \`.github/workflows/deploy.yml\` deploys every push to \`main\` once
this repo has the secret \`CLOUDFLARE_API_TOKEN\` (a Cloudflare API token from the "Edit Cloudflare
Workers" template, plus D1 Edit). Until then it skips, and \`bun run deploy\` from your machine is
all you need.
`,
};
for (const [name, content] of Object.entries(files)) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
}
console.log("✓ Wrote the instance folder");

await $`bun install`.cwd(dir).quiet();
console.log("✓ Installed @brutal-ai/server");

if ((await $`git --version`.nothrow().quiet()).exitCode === 0) {
  await $`git init -q`.cwd(dir).nothrow();
}

const whoami = await $`bunx cf auth whoami`.cwd(dir).nothrow().quiet();
let signedIn = false;
try {
  signedIn = whoami.exitCode === 0 && JSON.parse(whoami.stdout.toString()).authenticated;
} catch {
  // Unparseable output means cf could not report a session.
}
if (!signedIn) {
  console.log("\nSign in to Cloudflare (a browser window opens):");
  await interactive(["bunx", "cf", "auth", "login"]);
}

await interactive(["bunx", "brutal-server", "setup"]);

const answer = noDeploy ? null : prompt("Deploy it now? [Y/n]");
if (answer !== null && answer.trim().toLowerCase() !== "n") {
  await interactive(["bunx", "brutal-server", "deploy"]);
}

console.log(
  `Done. Your instance lives in ${folder}: commit it, and deploy with \`bun run deploy\`.\n`,
);

/** Runs a command in the new folder with this terminal, so it can prompt. */
async function interactive(cmd: string[]) {
  const code = await Bun.spawn(cmd, { cwd: dir, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) process.exit(code);
}

/** A local tarball path becomes absolute, so the new folder can install it. */
function resolveSpec(spec: string): string {
  return /^(\.|\/).*\.tgz$/.test(spec) ? resolve(spec) : spec;
}
