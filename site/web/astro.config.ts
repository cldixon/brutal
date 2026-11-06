import { defineConfig } from "astro/config";

// A static site: every page is pre-rendered into dist/, which the brutal-site Worker serves
// (cloudflare.config.ts). No adapter, no server rendering, no scripts.
export default defineConfig({
  trailingSlash: "never",
  build: {
    format: "file",
    // One external stylesheet rather than inlined styles, so the CSP can stay style-src 'self'.
    inlineStylesheets: "never",
  },
  vite: { build: { assetsInlineLimit: 0 } },
});
