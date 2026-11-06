# CLAUDE.md

## Spec

The original design is the **Brutal — Handoff** Claude Doc:
https://claude.ai/artifact/6vdZJyNoajH9EkVxHKiG6j. Where this repo deliberately differs, it says so
below. Next steps are GitHub issues.

## What it is now

A hosted app at **https://brutal.cldixon.dev** (temporary home), deployed from this repo. The
self-hosted model (deploy folders, `@brutal-ai/server`, `create-brutal-ai`) was dropped; the
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
  Mail goes through Cloudflare Email Service when `BRUTAL_MAIL_FROM` is set at deploy (a repo
  variable in CI); local dev with `DEV_SIGNIN=1` (worker/.dev.vars) shows the code instead.
- **Keys** belong to a project: ingest (files reports) and read (also reads and triages), stored
  as hashes, made and revoked in the web app.

Routes: `/v1/*` and `/mcp` take a project's key; `/api/*` is the web app's API with the session
cookie; everything else is the Svelte app's static files (SPA fallback; the Worker runs first
only for `/api/*`, `/v1/*`, `/mcp`, `/healthz`).

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
- Biome for lint and format (`bun run format`). `bun run build` (the app) then `bun run check`
  before every commit.
- Tests run under `bun test`: D1 is `worker/test/d1.ts` over bun:sqlite; `worker/test/harness.ts`
  runs the app in process with one bun:sqlite `ReportStore` per project and mail captured; MCP
  tests use the SDK's own client.

## Deployment and releases

- CI (`.github/workflows/ci.yml`) deploys every green push to `main` (`bun run deploy`, needs the
  repo secret `CLOUDFLARE_API_TOKEN`; skips without it). Do not create or delete Cloudflare
  resources without asking.
- `@brutal-ai/schema` and `@brutal-ai/sdk` are published together at `worker/package.json`'s
  version: bump it in a PR, and `release.yml` publishes what's not on npm yet (trusted
  publishing, provenance) and tags it. `@brutal-ai/server` and `create-brutal-ai` (0.1.0, 0.2.0)
  belong to the dropped self-hosted model.
