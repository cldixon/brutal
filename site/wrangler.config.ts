import { defineWranglerConfig } from "wrangler/experimental-config";

// cf builds the Worker with the Wrangler bundler; the Astro build (web/dist) is the static assets.
export default defineWranglerConfig({ types: { generate: false }, assetsDirectory: "web/dist" });
