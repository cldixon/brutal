#!/usr/bin/env bun
/**
 * brutal-server: set up, deploy and look after one Brutal instance. Runs in the folder that holds
 * its brutal.config.json (`worker/` in this repo, or a folder made by `bun create brutal-ai`).
 *
 *   brutal-server setup     ask for the settings and write brutal.config.json (safe to re-run)
 *   brutal-server deploy    deploy the Worker; on the very first deploy, also set a setup code
 *                           and print it
 *   brutal-server secrets   set a new setup code (only useful before the instance is claimed)
 *   brutal-server dev       run it locally on http://localhost:8787
 */
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { $ } from "bun";
import {
  type BrutalConfig,
  configPath,
  DEFAULTS,
  loadBrutalConfig,
  readConfigFile,
} from "../config.ts";

const root = process.cwd();
const [command, ...rest] = process.argv.slice(2);
process.env.CF_SEND_TELEMETRY ??= "false";

const commands: Record<string, () => Promise<void>> = { setup, deploy, secrets, dev };
const run = command ? commands[command] : undefined;
if (!run) {
  console.log("Usage: brutal-server <setup|deploy|secrets|dev>");
  process.exit(command ? 1 : 0);
}
await run();

async function requireAuth() {
  const whoami = await $`bunx cf auth whoami`.nothrow().quiet();
  let authenticated = false;
  try {
    authenticated = whoami.exitCode === 0 && JSON.parse(whoami.stdout.toString()).authenticated;
  } catch {
    // Unparseable output means cf could not report a session.
  }
  if (!authenticated) {
    console.error("Not signed in to Cloudflare. Run: bunx cf auth login");
    process.exit(1);
  }
}

async function setup() {
  console.log("\nBrutal setup\n");
  // cf evaluates the config for every command run here, before there is a file.
  process.env.BRUTAL_SETUP = "1";
  await requireAuth();

  // Re-running setup offers the current answers as the defaults.
  const current: Partial<BrutalConfig> = readConfigFile(root) ?? {};
  const worker = prompt(`Worker name [${current.worker ?? DEFAULTS.worker}]:`)?.trim();
  const domainAnswer = prompt(
    `Custom domain, on a zone in your Cloudflare account (blank for none, "-" to remove) [${current.domain ?? ""}]:`,
  )?.trim();
  const domain = domainAnswer === "-" ? "" : domainAnswer || current.domain || "";

  // The D1 database is named after the Worker, so several instances can share an account. The
  // first deploy creates it.
  const config: BrutalConfig = {
    ...current,
    worker: worker || current.worker || DEFAULTS.worker,
    domain: domain || null,
  };
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\n✓ Wrote ${basename(configPath(root))}`);
  console.log(
    domain
      ? `✓ ${domain} will route to this Worker (its zone must be on your account)`
      : "✓ No custom domain: it will be served from *.workers.dev",
  );
  console.log("\nNext: bun run deploy\n");
}

/** True when the Worker already exists (listing its secrets fails for one that doesn't). */
async function workerExists(worker: string): Promise<boolean> {
  return (
    (await $`bunx cf workers secrets list --worker ${worker}`.nothrow().quiet()).exitCode === 0
  );
}

async function deploy() {
  const { worker } = loadBrutalConfig(root);
  const existed = await workerExists(worker);
  const code = await interactive(["bunx", "cf", "deploy", ...rest]);
  if (code !== 0) process.exit(code);
  // An existing instance keeps its setup code, or is already claimed.
  if (existed || rest.includes("--dry-run")) return;
  if (process.env.CI) {
    // CI logs can be public, and the setup code claims the instance. Without one, the instance
    // makes its own when /setup first opens and writes it to the Worker's logs.
    console.log("\nNo setup code was set here, since CI logs may be public.");
    console.log("Run `bun run secrets` on your own machine for one before you claim it.\n");
    return;
  }
  await secrets();
}

async function secrets() {
  const { worker } = loadBrutalConfig(root);
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const setupCode = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await $`bunx cf workers secrets update SETUP_CODE --worker ${worker} --type secret_text --text ${setupCode}`.quiet();
  console.log(`\n✓ SETUP_CODE set on ${worker}`);
  console.log(`\nSetup code: ${setupCode}`);
  console.log("Open /setup on your instance and enter it to make your keys.\n");
}

async function dev() {
  process.exit(await interactive(["bunx", "cf", "dev", "--port", "8787", ...rest]));
}

/** Runs a command with this terminal, so cf can prompt. */
function interactive(cmd: string[]): Promise<number> {
  return Bun.spawn(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] }).exited;
}
