import { bindings, defineConfig, exports } from "cf/config";

/**
 * The hosted Brutal Worker for the `cf` CLI (`cf dev`, `cf deploy`, `cf workers types`): the API
 * (/v1), MCP (/mcp), the web app's API (/api) and the Svelte app's static files, at
 * brutal.cldixon.dev. Accounts live in D1; each project's reports in its own Durable Object.
 */
const MAIL_FROM = process.env.BRUTAL_MAIL_FROM ?? "";

export default defineConfig(({ mode }) => {
  const local = mode === undefined || mode === "local";
  return {
    worker: {
      name: "brutal",
      compatibilityDate: "2026-10-01",
      // The MCP SDK's transport needs it.
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./src/index.ts",
      observability: { enabled: true },
      domains: local ? [] : ["brutal.cldixon.dev"],
      workersDev: false,
      // Previews would share production's D1 and Durable Objects.
      previewUrls: false,
      // The Svelte app; anything that isn't a built file is the app's index.html, except the
      // paths the Worker answers.
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/v1/*", "/mcp", "/healthz"],
      },
      exports: {
        Project: exports.durableObject({ storage: "sqlite" }),
      },
      env: {
        // Accounts: people, sign-in codes, sessions, projects, keys. Migrates itself.
        DB: bindings.d1({ name: "brutal-accounts" }),
        PROJECT: bindings.durableObject({ worker: "brutal", exportName: "Project" }),
        ASSETS: bindings.assets(),
        // Invite-only in production, as Tempra: accounts, invited emails and OPERATOR_EMAIL (a
        // secret) get codes; anyone else joins the waitlist. Open in local dev.
        SIGNUP: bindings.text(local ? "open" : "invite"),
        // Sign-in codes by mail, once a sending domain is set up (BRUTAL_MAIL_FROM at deploy).
        ...(MAIL_FROM && {
          EMAIL: bindings.sendEmail({ allowedSenderAddresses: [MAIL_FROM] }),
          MAIL_FROM: bindings.text(MAIL_FROM),
        }),
      },
    },
  };
});
