/** A Brutal instance's settings, as brutal.config.json holds them. */
export type BrutalConfig = {
  /** Worker name. Also names the D1 database unless `database` is set. */
  worker: string;
  /** D1 database for reports and keys. Defaults to the Worker name. */
  database?: string;
  /** Custom domain on a zone in your Cloudflare account. Without one, workers.dev serves it. */
  domain?: string | null;
  /** Cloudflare Access in front of /dashboard; `brutal-server access` sets it up. */
  access?: { emails: string[]; team?: string; aud?: string } | null;
};

/**
 * The Brutal Worker's cf config, from the brutal.config.json in `dir`. Use as the default export
 * of cloudflare.config.ts:
 *
 *   export default defineBrutal({ dir: import.meta.dirname });
 */
export function defineBrutal(options: { dir: string; entrypoint?: string }): unknown;

export function loadBrutalConfig(dir: string, options?: { allowDefaults?: boolean }): BrutalConfig;
