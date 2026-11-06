import { bindings, defineConfig, exports } from "cf/config";
import { COMPATIBILITY_DATE, DEPLOYMENT } from "../deploy.config.ts";

/**
 * The app's Worker for the `cf` CLI (`cf dev`, `cf deploy`, `cf workers types`): the API (/v1), MCP
 * (/mcp), the web app's API (/api) and the Svelte app's static files, on DEPLOYMENT.app.host. The
 * landing page (site/) answers `/` for people signed out, through SITE; the operator's portal
 * (admin/) calls the Operator entrypoint. Accounts live in D1; each project's reports in its own
 * Durable Object. With no mode (`cf dev`, types) no domain is attached and nothing is bound.
 */
export default defineConfig(({ mode }) => {
  const local = mode === undefined || mode === "local";
  const { app, site, mailFrom } = DEPLOYMENT;
  return {
    worker: {
      name: app.name,
      compatibilityDate: COMPATIBILITY_DATE,
      // nodejs_compat: the MCP SDK's transport. global_fetch_strictly_public: the OAuth library
      // fetches client metadata documents only under it (as Tempra).
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      entrypoint: "./src/index.ts",
      observability: { enabled: true },
      domains: local ? [] : [app.host],
      workersDev: false,
      // Previews would share production's D1 and Durable Objects.
      previewUrls: false,
      // The Svelte app; anything that isn't a built file is the app's index.html, except the
      // paths the Worker answers: `/` (the landing page or the app) and the site's files.
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: [
          "/",
          "/_astro/*",
          "/api/*",
          "/v1/*",
          "/mcp",
          "/healthz",
          // OAuth for connecting apps (worker.ts, oauth.ts).
          "/authorize",
          "/token",
          "/register",
          "/.well-known/*",
        ],
      },
      exports: {
        Project: exports.durableObject({ storage: "sqlite" }),
        Operator: exports.worker(),
      },
      env: {
        // Accounts: people, sign-in codes, sessions, projects, keys, invites. Migrates itself.
        DB: bindings.d1({ name: "brutal-accounts" }),
        PROJECT: bindings.durableObject({ worker: app.name, exportName: "Project" }),
        // OAuth clients and grants for connected apps (Cloudflare's OAuth provider, worker.ts).
        OAUTH_KV: bindings.kv(),
        ASSETS: bindings.assets(),
        APP_ORIGIN: bindings.text(local ? "http://localhost:8787" : `https://${app.host}`),
        // Invite-only in production, as Tempra: accounts, invited emails and OPERATOR_EMAIL (a
        // secret, set by admin/scripts/deploy.ts) get codes; anyone else joins the waitlist.
        SIGNUP: bindings.text(local ? "open" : "invite"),
        ...(local ? {} : { SITE: bindings.worker({ worker: site.name }) }),
        // Sign-in and invitation mail, once a sending domain is set up.
        ...(mailFrom
          ? {
              EMAIL: bindings.sendEmail({ allowedSenderAddresses: [mailFrom] }),
              MAIL_FROM: bindings.text(mailFrom),
            }
          : {}),
      },
    },
  };
});
