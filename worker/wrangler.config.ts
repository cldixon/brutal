import { defineWranglerConfig } from "wrangler/experimental-config";

// cf builds the Worker with the Wrangler bundler; the web app's built files are here.
export default defineWranglerConfig({
  types: { generate: false },
  assetsDirectory: "../app/dist",
});
