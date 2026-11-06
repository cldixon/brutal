import { bindings, defineConfig } from "cf/config";

/**
 * The Brutal Worker for the `cf` CLI (`cf dev`, `cf deploy`, `cf workers types`). One Worker
 * serves the HTTP API (/v1), the MCP server (/mcp) and the dashboard (/). Each team deploys it
 * to its own Cloudflare account, so reports stay on infrastructure they control.
 */
export default defineConfig({
  worker: {
    name: "brutal",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./src/index.ts",
    observability: { enabled: true },
    env: {
      // Reports and keys. Migrates itself on first use (src/db.ts); nobody runs a migration.
      DB: bindings.d1({ name: "brutal" }),
    },
  },
});
