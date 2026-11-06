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
    // The reference deployment's host. Moves to the owner's own deploy folder when the Worker is
    // packaged for self-deployers (step 2), so no owner-specific value stays in this repo.
    domains: ["brutal.cldixon.dev"],
    workersDev: false,
    // Previews would share production's D1, and migrations apply themselves (igloo's reason).
    previewUrls: false,
    env: {
      // Reports and keys. Migrates itself on first use (src/db.ts); nobody runs a migration.
      DB: bindings.d1({ name: "brutal" }),
    },
  },
});
