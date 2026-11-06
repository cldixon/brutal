# CLAUDE.md

## Spec

The original design is the **Brutal — Handoff** Claude Doc:
https://claude.ai/artifact/6vdZJyNoajH9EkVxHKiG6j. Where this repo deliberately differs, it says so
below. Next steps are GitHub issues.

## What it is now

A hosted service, deployed from this repo, laid out as Tempra is: three Workers, their names and
hosts in **`deploy.config.ts`** (the only file to change for a new domain: the app on the domain,
the portal on admin.<domain>, `mailFrom` on a sending subdomain once one is set up).

- **`brutal`** (`worker/` + `app/`): the app on the main host (temporarily brutal.cldixon.dev).
- **`brutal-site`** (`site/`, its Astro project in `site/web/`, kept apart because cf switches to
  a framework build when it finds Astro in a folder): the landing page. No host of its own; the
  app answers `/` from it for people signed out (no cookie forwarded, `Vary: Cookie`) and
  `/_astro/*`, through the SITE service binding. Static, no script.
- **`brutal-admin`** (`admin/`): the operator's portal on its own host (temporarily
  brutal-admin.cldixon.dev: one level under the zone, so its certificate covers it), behind
  Cloudflare Access (one-time PIN, OPERATOR_EMAIL only, 2 hours; `admin/scripts/deploy.ts` makes
  sure of Access, deploys, then sets OPERATOR_EMAIL on the portal and the app). Server-rendered,
  no script; it re-checks Access's token and calls the app's `Operator` WorkerEntrypoint
  (`worker/src/index.ts`, `worker/src/operator.ts`), which checks the operator's email again.
  `admin/src/access.ts` and `admin/scripts/access.ts` are copied from Tempra.

The self-hosted model (deploy folders, `@brutal-ai/server`, `create-brutal-ai`) was dropped; the
focus is a person or team developing a custom agent, or testing a tool or MCP server with their
agents. Shipping Brutal inside someone else's MCP server is a later extension.

The account model is Tempra's (cldixon/tempra), kept small:

- **D1** (`brutal-accounts`, `worker/src/accounts.ts`): users, sign-in codes, sessions, projects,
  keys. Migrations apply themselves on first use per isolate; never edit a shipped one, only add.
- **One Durable Object per project** (`Project`, `worker/src/project.ts`) holds that project's
  reports in its own SQLite (`worker/src/reports.ts`, `ReportStore`, synchronous, free of Worker
  APIs). The Worker reaches a project's DO only after checking a key of that project, or that the
  session's person owns it (a stranger gets 404).
- **Sign-in** by email code (Tempra's: 8 Crockford base32 characters, bound to the email, 15
  minutes, 5 tries, one per 30 s), session cookie `__Host-brutal_session` (hash stored, 30 days),
  every state-changing `/api` call checked to come from this site (Origin, else Sec-Fetch-Site).
  **Invite-only**, as Tempra: with `SIGNUP=invite` (production; `open` in local dev) only
  accounts, invited emails (D1 `invites`) and `OPERATOR_EMAIL` (a Worker secret) get a code;
  anyone else joins the `waitlist`, is told once, and the operator is told. Every email gets the
  same answer, so the page never says who has an account; verifying a code checks the invite
  again. `bun run admin invite|uninvite|waitlist|users` (scripts/admin.ts) manages it through `cf`.
  Mail (sign-in codes, the waitlist's note, "You're in") goes through Cloudflare Email Service once
  `mailFrom` is set in deploy.config.ts; local dev with `DEV_SIGNIN=1` (worker/.dev.vars) shows
  the code instead. The operator admits people from the portal (or `bun run admin`).
- **Keys** belong to a project: ingest (files reports) and read (also reads and triages), stored
  as hashes, made and revoked in the web app.

Routes: `/v1/*` and `/mcp` take a project's key; `/api/*` is the web app's API with the session
cookie; `/` is the landing page signed out and the app signed in; everything else is the Svelte
app's static files (SPA fallback; the Worker runs first only for `/`, `/_astro/*`, `/api/*`,
`/v1/*`, `/mcp`, `/healthz`).

Durable Object RPC can't carry objects without a prototype (Hono's `c.req.query()`): copy them
(`{ ...c.req.query() }`). The test harness refuses such arguments as RPC does.

## Web app

`app/`: Svelte 5 with runes, Vite, no SvelteKit; a tiny router (`router.svelte.ts`). Minimal on
purpose: black on white, system fonts, plain links, no design system yet. Pages: landing, sign-in,
projects, a project (reports with filters, keys, how to connect), a report (triage, recorded tool
calls, context). CSP `script-src 'self'; style-src 'self'` (`app/public/_headers`). Biome lints only
`<script>` blocks of `.svelte` files, so its unused-variable and import rules are off there;
`svelte-check` covers them. Import the schema's lists from `@brutal-ai/schema/constants` in the
app, so zod stays out of the bundle.

## Tooling

- bun for everything (`bun install`, `bun run …`, `bun test`, `bunx`); no npm/npx/yarn/pnpm (npm
  only in `release.yml`, for trusted publishing).
- **`cf`** (Cloudflare's CLI, pinned in `worker/`), not Wrangler; the Worker is configured in
  `worker/cloudflare.config.ts` (`wrangler.config.ts` only names the assets directory). Find
  commands with `bunx cf cli search "<task>"` (generic wording), then `--help`. Set
  `CF_SEND_TELEMETRY=false`.
- Biome for lint and format (`bun run format`); like `.svelte`, `.astro` files get the unused
  rules off. `bun run build` (the app and the site) then `bun run check` before every commit.
- Tests run under `bun test`: D1 is `worker/test/d1.ts` over bun:sqlite; `worker/test/harness.ts`
  runs the app in process with one bun:sqlite `ReportStore` per project and mail captured; MCP
  tests use the SDK's own client; `admin/test` signs Access tokens with a test RSA key.

## Deployment and releases

- CI (`.github/workflows/ci.yml`) dry-runs all three Workers on every PR, and deploys every green
  push to `main`: site, app, then portal (they bind in that order). Repo secrets:
  `CLOUDFLARE_API_TOKEN` (Workers, D1, the zone, and Access for the portal) and `OPERATOR_EMAIL`
  (without it the portal is skipped). Do not create or delete Cloudflare resources without asking.
- `@brutal-ai/schema` and `@brutal-ai/sdk` are published together at `worker/package.json`'s
  version: bump it in a PR, and `release.yml` publishes what's not on npm yet (trusted
  publishing, provenance) and tags it. `@brutal-ai/server` and `create-brutal-ai` (0.1.0, 0.2.0)
  belong to the dropped self-hosted model.
