import { defineWranglerConfig } from "wrangler/experimental-config";

// The portal's stylesheet.
export default defineWranglerConfig({ types: { generate: false }, assetsDirectory: "public" });
