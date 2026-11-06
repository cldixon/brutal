import { bindings, defineConfig } from "cf/config";
import { COMPATIBILITY_DATE, DEPLOYMENT } from "../deploy.config.ts";

/**
 * The operator's portal: its own Worker on its own host (DEPLOYMENT.admin), behind Cloudflare
 * Access. scripts/deploy.ts makes sure of the Access application first, then deploys with what
 * the Worker needs to check Access's token: the team (BRUTAL_ACCESS_TEAM) and the application's
 * audience tag (BRUTAL_ACCESS_AUD). Without them the Worker refuses every request. It calls the
 * app's Operator entrypoint through OPERATOR. With no mode (cf dev, types) nothing is attached.
 */
export default defineConfig(({ mode }) => {
  const local = !mode;
  const env = process.env;
  const { admin, app } = DEPLOYMENT;
  return {
    worker: {
      name: admin.name,
      compatibilityDate: COMPATIBILITY_DATE,
      entrypoint: "./src/index.ts",
      observability: { enabled: true },
      domains: local ? [] : [admin.host],
      workersDev: false,
      previewUrls: false,
      // Its stylesheet (public/); Access covers these too, on the portal's host.
      assets: { htmlHandling: "none", notFoundHandling: "none" },
      env: {
        ORIGIN: bindings.text(local ? "http://localhost:8787" : `https://${admin.host}`),
        ACCESS_TEAM: bindings.text(local ? "" : (env.BRUTAL_ACCESS_TEAM ?? "")),
        ACCESS_AUD: bindings.text(local ? "" : (env.BRUTAL_ACCESS_AUD ?? "")),
        ASSETS: bindings.assets(),
        ...(local
          ? {}
          : { OPERATOR: bindings.worker({ worker: app.name, exportName: "Operator" }) }),
      },
    },
  };
});
