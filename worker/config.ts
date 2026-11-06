import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { bindings, defineConfig } from "cf/config";

/**
 * What makes one Brutal instance different from another. The code is the same for everyone;
 * these settings are each owner's, so they live in their own brutal.config.json (written by
 * `brutal-server setup`), never in this repo's source.
 */
export type BrutalConfig = {
  /** Worker name. Also names the D1 database unless `database` is set. */
  worker: string;
  /** D1 database for reports and keys. Defaults to the Worker name. */
  database?: string;
  /** Custom domain on a zone in your Cloudflare account. Without one, workers.dev serves it. */
  domain?: string | null;
};

export const CONFIG_FILE = "brutal.config.json";
export const DEFAULTS = { worker: "brutal" } as const;

/** Environment variables that override the file, for CI. */
const ENV: Record<keyof BrutalConfig, string> = {
  worker: "BRUTAL_WORKER",
  database: "BRUTAL_DATABASE",
  domain: "BRUTAL_DOMAIN",
};

/** The config file's path: brutal.config.json, or the file `BRUTAL_CONFIG` names. */
export function configPath(dir: string): string {
  const named = process.env.BRUTAL_CONFIG;
  return named ? (isAbsolute(named) ? named : join(dir, named)) : join(dir, CONFIG_FILE);
}

/** The config file, or null if there isn't one. */
export function readConfigFile(dir: string): Partial<BrutalConfig> | null {
  const path = configPath(dir);
  if (!existsSync(path)) {
    if (process.env.BRUTAL_CONFIG && !process.env.BRUTAL_SETUP) {
      throw new Error(`BRUTAL_CONFIG points at ${path}, which doesn't exist`);
    }
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Partial<BrutalConfig>;
}

/**
 * The instance's settings: the config file, then environment overrides. Without either, this
 * throws unless `allowDefaults` (local dev, type generation): a deploy that silently fell back
 * to defaults would drop the custom domain from a running instance, or deploy a second one.
 */
export function loadBrutalConfig(dir: string, { allowDefaults = false } = {}): BrutalConfig {
  const file = readConfigFile(dir);
  const env: Partial<BrutalConfig> = {};
  for (const [key, name] of Object.entries(ENV) as [keyof BrutalConfig, string][]) {
    const value = process.env[name];
    if (value !== undefined) (env as Record<string, string | null>)[key] = value || null;
  }
  if (!file && !env.worker && !allowDefaults && !process.env.BRUTAL_SETUP) {
    throw new Error(
      `No ${CONFIG_FILE} in ${dir}. Run \`bun run setup\` to make one, ` +
        "or set BRUTAL_WORKER (and BRUTAL_DOMAIN) in the environment.",
    );
  }
  const config = { ...DEFAULTS, ...file, ...env } as BrutalConfig;
  if (!config.worker) throw new Error(`${CONFIG_FILE} needs a worker name`);
  return config;
}

/**
 * The Brutal Worker's cf config, from the owner's settings in `dir`. This repo passes its source
 * entrypoint; the published package defaults to the prebuilt bundle it ships.
 */
export function defineBrutal({ dir, entrypoint }: { dir: string; entrypoint?: string }) {
  return defineConfig(() => {
    // cf evaluates this for every command; `cf dev` and `cf workers types` need no settings.
    const argv = process.argv;
    const brutal = loadBrutalConfig(dir, {
      allowDefaults: argv.includes("dev") || argv.includes("types"),
    });
    const domain = brutal.domain || null;
    return {
      worker: {
        name: brutal.worker,
        compatibilityDate: "2026-10-01",
        // The MCP SDK's transport needs it.
        compatibilityFlags: ["nodejs_compat"],
        entrypoint: entrypoint ?? join(import.meta.dirname, "worker", "index.js"),
        observability: { enabled: true },
        // The zone must be on your own account. Without a domain, workers.dev is the only route,
        // so it is turned on.
        ...(domain && { domains: [domain] }),
        workersDev: !domain,
        // Previews would share production's D1, and migrations apply themselves on first use.
        previewUrls: false,
        env: {
          // Reports, keys and settings. Migrates itself on first use; cf deploy creates it.
          DB: bindings.d1({ name: brutal.database ?? brutal.worker }),
        },
      },
    };
  });
}
