import { bindings, defineConfig } from "cf/config";
import { COMPATIBILITY_DATE, DEPLOYMENT } from "../deploy.config.ts";

/** The landing page's Worker: no host, no data; the app calls it by service binding. */
export default defineConfig({
  worker: {
    name: DEPLOYMENT.site.name,
    compatibilityDate: COMPATIBILITY_DATE,
    entrypoint: "./worker.ts",
    observability: { enabled: true },
    workersDev: false,
    previewUrls: false,
    // The Worker sees every request first: it adds the security headers.
    assets: { runWorkerFirst: true, notFoundHandling: "404-page" },
    env: { ASSETS: bindings.assets() },
  },
});
