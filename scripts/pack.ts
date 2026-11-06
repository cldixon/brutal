#!/usr/bin/env bun
/**
 * Builds the four publishable packages into dist/ and packs each into a tarball there:
 *
 *   @brutal-ai/server   the prebuilt Worker, `defineBrutal` and the `brutal-server` CLI
 *   @brutal-ai/schema   the report schema and tool definition
 *   @brutal-ai/sdk      the TypeScript SDK
 *   create-brutal-ai    `bun create brutal-ai`
 *
 * All four share worker/package.json's version and are released together (release.yml), so a
 * scaffolded folder always installs a matching server. Nothing here publishes or deploys.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const worker = join(root, "worker");
const own = JSON.parse(readFileSync(join(worker, "package.json"), "utf-8"));
const version: string = own.version;
const cf: string = own.devDependencies.cf;
const wrangler: string = own.devDependencies.wrangler;
const zod: string = JSON.parse(
  readFileSync(join(root, "packages", "schema", "package.json"), "utf-8"),
).dependencies.zod;
const repository = (directory: string) => ({
  type: "git",
  url: "git+https://github.com/cldixon/brutal.git",
  directory,
});

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

async function build(entry: string, outdir: string, name: string, options: object = {}) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    format: "esm",
    naming: name,
    ...options,
  });
  if (!result.success) throw new AggregateError(result.logs, `Couldn't bundle ${entry}`);
}

function writePackage(dir: string, manifest: object) {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ version, license: "MIT", ...manifest }, null, 2)}\n`,
  );
}

async function pack(dir: string, name: string) {
  await $`bun pm pack --destination ${dist} --quiet`.cwd(dir);
  console.log(`✓ Packed ${name}@${version}`);
}

/** Declarations for one entry, with tsc, leaving imports of other packages as they are. */
async function declarations(pkg: string, entry: string, outdir: string) {
  // From the package's own folder, where the isolated linker put its dependencies.
  await $`bunx tsc ${entry} --declaration --emitDeclarationOnly --outDir ${outdir} --strict --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution bundler --skipLibCheck --types bun`.cwd(
    pkg,
  );
}

// @brutal-ai/server. The bundle depends on no owner's settings, so the example stands in.
{
  const out = join(dist, "server");
  await $`bunx cf build`
    .cwd(worker)
    .env({
      ...process.env,
      BRUTAL_CONFIG: "brutal.config.example.json",
      CF_SEND_TELEMETRY: "false",
    })
    .quiet();
  cpSync(
    join(worker, ".cloudflare", "output", "v0", "workers", "default", "bundle"),
    join(out, "worker"),
    {
      recursive: true,
    },
  );
  // cf and wrangler come from the owner's folder.
  const external = ["cf", "cf/*", "wrangler", "wrangler/*"];
  await build(join(worker, "config.ts"), out, "config.js", { target: "node", external });
  await build(join(worker, "cli", "brutal-server.ts"), out, "cli.js", { target: "bun", external });
  cpSync(join(worker, "package"), out, { recursive: true });
  writePackage(out, {
    name: "@brutal-ai/server",
    description: "Brutal: feedback from your agents, deployed to your own Cloudflare account",
    type: "module",
    repository: repository("worker"),
    bin: { "brutal-server": "cli.js" },
    exports: { "./config": { types: "./config.d.ts", default: "./config.js" } },
    files: ["cli.js", "config.js", "config.d.ts", "worker", "README.md"],
    peerDependencies: { cf, wrangler },
    engines: { bun: ">=1.2.0" },
  });
  await pack(out, "@brutal-ai/server");
}

// @brutal-ai/schema and @brutal-ai/sdk: ESM with declarations; dependencies stay imports.
for (const [dir, name, dependencies, description] of [
  ["schema", "@brutal-ai/schema", { zod }, "Brutal's report schema and report_feedback tool"],
  [
    "sdk",
    "@brutal-ai/sdk",
    { "@brutal-ai/schema": version },
    "Brutal's TypeScript SDK: the report_feedback tool and a recorder of recent tool calls",
  ],
] as const) {
  const out = join(dist, dir);
  const pkg = join(root, "packages", dir);
  const entry = join(pkg, "src", "index.ts");
  await build(entry, out, "index.js", { target: "browser", external: Object.keys(dependencies) });
  await declarations(pkg, entry, out);
  writeFileSync(
    join(out, "README.md"),
    `# ${name}\n\n${description}. See [Brutal](https://github.com/cldixon/brutal).\n`,
  );
  writePackage(out, {
    name,
    description,
    type: "module",
    repository: repository(`packages/${dir}`),
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    files: ["index.js", "index.d.ts", "README.md"],
    dependencies,
  });
  await pack(out, name);
}

// create-brutal-ai, with the versions it installs baked in.
{
  const out = join(dist, "create-brutal-ai");
  await build(join(root, "packages", "create-brutal-ai", "src", "index.ts"), out, "index.js", {
    target: "bun",
    define: {
      BRUTAL_VERSION: JSON.stringify(version),
      CF_VERSION: JSON.stringify(cf),
      WRANGLER_VERSION: JSON.stringify(wrangler),
    },
  });
  writeFileSync(
    join(out, "README.md"),
    "# create-brutal-ai\n\nDeploy your own [Brutal](https://github.com/cldixon/brutal) to your Cloudflare account:\n\n```sh\nbun create brutal-ai my-brutal\n```\n",
  );
  writePackage(out, {
    name: "create-brutal-ai",
    description: "Create your own Brutal instance on your Cloudflare account",
    type: "module",
    repository: repository("packages/create-brutal-ai"),
    bin: { "create-brutal-ai": "index.js" },
    files: ["index.js", "README.md"],
    engines: { bun: ">=1.2.0" },
  });
  await pack(out, "create-brutal-ai");
}
