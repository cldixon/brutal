#!/usr/bin/env bun
/**
 * Builds the publishable client packages into dist/ and packs each into a tarball there:
 *
 *   @brutal-ai/schema   the report schema and tool definition (and its constants, zod-free)
 *   @brutal-ai/sdk      the TypeScript SDK
 *
 * Both share worker/package.json's version and are released together (release.yml). Nothing
 * here publishes. The hosted app itself is deployed, not published.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const version: string = JSON.parse(
  readFileSync(join(root, "worker", "package.json"), "utf-8"),
).version;
const zod: string = JSON.parse(
  readFileSync(join(root, "packages", "schema", "package.json"), "utf-8"),
).dependencies.zod;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const PACKAGES = [
  {
    dir: "schema",
    name: "@brutal-ai/schema",
    description: "Brutal's report schema and report_feedback tool",
    entries: ["index", "constants"],
    dependencies: { zod },
  },
  {
    dir: "sdk",
    name: "@brutal-ai/sdk",
    description:
      "Brutal's TypeScript SDK: the report_feedback tool and a recorder of recent tool calls",
    entries: ["index"],
    dependencies: { "@brutal-ai/schema": version },
  },
] as const;

for (const pkg of PACKAGES) {
  const src = join(root, "packages", pkg.dir);
  const out = join(dist, pkg.dir);
  const entrypoints = pkg.entries.map((e) => join(src, "src", `${e}.ts`));
  // ESM with dependencies left as imports.
  const result = await Bun.build({
    entrypoints,
    outdir: out,
    format: "esm",
    target: "browser",
    naming: "[name].js",
    external: Object.keys(pkg.dependencies),
  });
  if (!result.success) throw new AggregateError(result.logs, `Couldn't bundle ${pkg.name}`);
  // Declarations, from the package's own folder, where the isolated linker put its dependencies.
  await $`bunx tsc ${entrypoints} --declaration --emitDeclarationOnly --outDir ${out} --strict --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution bundler --skipLibCheck --types bun`.cwd(
    src,
  );
  writeFileSync(
    join(out, "README.md"),
    `# ${pkg.name}\n\n${pkg.description}. See [Brutal](https://github.com/cldixon/brutal).\n`,
  );
  const exports = Object.fromEntries(
    pkg.entries.map((e) => [
      e === "index" ? "." : `./${e}`,
      { types: `./${e}.d.ts`, default: `./${e}.js` },
    ]),
  );
  writeFileSync(
    join(out, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        version,
        description: pkg.description,
        license: "MIT",
        type: "module",
        repository: {
          type: "git",
          url: "git+https://github.com/cldixon/brutal.git",
          directory: `packages/${pkg.dir}`,
        },
        exports,
        files: [...pkg.entries.flatMap((e) => [`${e}.js`, `${e}.d.ts`]), "README.md"],
        dependencies: pkg.dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await $`bun pm pack --destination ${dist} --quiet`.cwd(out);
  console.log(`✓ Packed ${pkg.name}@${version}`);
}
