/**
 * Where Brutal runs: one place for every Worker's name and host, read by the three
 * cloudflare.config.ts files (worker/, site/, admin/) and the admin's deploy script. Moving to a
 * new domain is changing this file: the app on the domain itself, the operator's portal on
 * admin.<domain>, mail from an address on a sending subdomain (mail.<domain>) once it is set up
 * in Cloudflare Email Service.
 */
export const DEPLOYMENT = {
  /** The app: the API, MCP and the Svelte web app; the landing page for people signed out. */
  app: { name: "brutal", host: "brutal.cldixon.dev" },
  /** The landing page (Astro). No host of its own: the app reaches it by service binding. */
  site: { name: "brutal-site" },
  /**
   * The operator's portal, behind Cloudflare Access. One level under the zone, so its free
   * certificate covers it (admin.brutal.cldixon.dev would not be).
   */
  admin: { name: "brutal-admin", host: "brutal-admin.cldixon.dev" },
  /** Sign-in and invitation mail's address; empty until a sending domain is set up. */
  mailFrom: "",
} as const;

export const COMPATIBILITY_DATE = "2026-10-01";
