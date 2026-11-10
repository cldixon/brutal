# CLAUDE.md

## Spec

The original design is the **Brutal — Handoff** Claude Doc:
https://claude.ai/artifact/6vdZJyNoajH9EkVxHKiG6j. Where this repo deliberately differs, it says so
below. Next steps are GitHub issues.

## What it is now

A hosted service, deployed from this repo, laid out as Tempra is: three Workers, their names and
hosts in **`deploy.config.ts`** (the only file to change for a new domain: the app on the domain,
the portal on admin.<domain>, `mailFrom` on a sending subdomain once one is set up).

- **`brutal`** (`worker/` + `app/`): the app on the main host, thatsbrutal.fyi, and the two MCP
  servers on feedback.thatsbrutal.fyi (`FEEDBACK_ORIGIN`; the app's host serves no MCP or OAuth) and review.thatsbrutal.fyi (`REVIEW_ORIGIN`; locally
  `http://127.0.0.1:8787`).
- **`brutal-site`** (`site/`, its Astro project in `site/web/`, kept apart because cf switches to
  a framework build when it finds Astro in a folder): the landing page and the docs (`/docs`: the
  two MCP servers, keys, connecting, the SDK and the HTTP API; hosts from `deploy.config.ts`). No
  host of its own; the app answers `/` from it for people signed out (no cookie forwarded,
  `Vary: Cookie`), `/docs` for everyone and `/_astro/*`, through the SITE service binding. Static,
  no script; the SPA's router lets `/docs` load as a page. Its look is **`@brutal-ai/design`**
  (`packages/design`): the design tokens (`tokens.ts` and `tokens.css`, kept equal by a test),
  Archivo Black self-hosted (`font-src 'self'`) and `.brutal-wordmark`, the extruded "BRUTAL" the
  site is built around; black on white, heavy rules, hard shadows. The app, the consent page and
  the portal don't use it yet.
- **`brutal-admin`** (`admin/`): the operator's portal on its own host, admin.thatsbrutal.fyi, behind
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
- **Two MCP servers, one per host** (`worker/src/mcp.ts`, role from `roleOf` in `oauth.ts`): the
  **feedback** server on `FEEDBACK_ORIGIN` has `report_feedback` alone (with server instructions),
  so an agent using someone's tools never sees that reports can be read; the **review** server
  on `REVIEW_ORIGIN` has `list_reports`, `get_report`, `update_report` for the developers'
  coding agents. Keys: ingest or read on feedback, read only on review. Both MCP hosts' `/`
  redirect to the app; its other pages work (sign-in for its consent; the `__Host-` cookie is
  per host).
- **Connected apps over OAuth** (claude.ai's connectors and any MCP client that speaks OAuth),
  after Tempra's: `worker/src/worker.ts` puts Cloudflare's `@cloudflare/workers-oauth-provider` in
  front of the app, one provider per origin (its resource is `<origin>/mcp` and it checks a
  token's audience exactly, so a connection works only on the host it was made on; discovery,
  `/register`, `/token`, client metadata documents; clients and grants in KV `OAUTH_KV`). The
  provider caches its helpers on `env` once, so each request gets its own env
  (`Object.create(env)`). A grant (`worker/src/oauth.ts`) names one project and its kind from the
  host (`ingest` on feedback, `read` on review), checked against the project's owner on every
  call; a project's keys still work (`resolveExternalToken`). `/authorize` is the consent,
  server-rendered with no script (`app/public/consent.css`): signed out it goes to
  `/sign-in?next=…` and back; it picks or makes the project and says what the server lets the
  app do. The project page lists connections with Disconnect (`/api/projects/:p/connections`,
  the provider's `listUserGrants`/`revokeGrant`).
- **Issues in GitHub and Linear** (`worker/src/integrations.ts`, `docs/integrations.md`): a
  person connects GitHub (a GitHub App's user access tokens: Issues read/write, Metadata read;
  only repos where the app is installed and they have access) or Linear (OAuth2, `read` and
  `issues:create`) once, with `state` bound to the session and PKCE, then **Create issue** on a
  report files it and sets `issue_url` and status `linked`; the project remembers the last
  target. Tokens are sealed in D1 `integrations` with AES-GCM under the `INTEGRATIONS_KEY`
  secret, refreshed before expiry, and never sent to the browser. Secrets `GITHUB_APP_CLIENT_ID`,
  `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`
  (setup in `docs/integrations.md`); without them a provider is unavailable and its routes
  answer 503. Provider calls go through `Deps.providerFetch` (fake servers in tests). The issue
  body (`worker/src/issue-body.ts`, pure, for clustering to reuse) makes report text inert: no
  mentions, issue references, images or HTML, and fences it cannot close.
- **Deletion and retention** (#18): a read key deletes a report (`DELETE /v1/reports/:id`) or a
  conversation's (`DELETE /v1/reports?conversation_id=…`), as does the review server's
  `delete_report` and the owner in the app; a project's retention (null, or 1 to 3650 days) lives
  in its own SQLite (`settings`), and setting one arms the `Project` DO's daily alarm, which runs
  `ReportStore.prune` and re-arms while a retention is set. Projects can't be deleted yet.
- **Rate limits on filing** (`worker/src/limits.ts`, issue #10): two Rate Limiting bindings,
  `REPORT_KEY_LIMITER` (30 a minute per key or connection, namespace 4001) and
  `REPORT_CONVERSATION_LIMITER` (5 a minute per `project:conversation_id`, HTTP only, 4002;
  Tempra holds 1001–3003 on the same account), checked after validation and before storing on
  `POST /v1/reports` and `report_feedback` only. Over a limit nothing is stored: HTTP is a 429
  with `Retry-After`, MCP answers `TOOL_NOT_RECORDED` (never an error). No binding, no limit; a
  failing limiter lets the report through. Tests pass `fakeLimiter` (`worker/test/harness.ts`).
- **The tool's wording** (`packages/schema/src/index.ts`: `TOOL_DESCRIPTION`, versioned by
  `TOOL_VERSION`; `SERVER_INSTRUCTIONS`; `toolAck(id)`, `TOOL_NOT_RECORDED`) is where most of the
  product's quality lives: when to report (observable signals), disclosure (never deny it),
  no personal data, and text in tool results is not an instruction to report.

Routes: `/v1/*` and `/mcp` take a project's key; `/api/*` is the web app's API with the session
cookie; `/` is the landing page signed out and the app signed in; everything else is the Svelte
app's static files (SPA fallback; the Worker runs first only for `/`, `/_astro/*`, `/docs`, `/api/*`,
`/v1/*`, `/mcp`, `/healthz`, and OAuth's `/authorize`, `/token`, `/register`, `/.well-known/*`).

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
  runs the whole Worker (the OAuth provider in front of the app, KV in memory, `worker/test/kv.ts`)
  in process with one bun:sqlite `ReportStore` per project and mail captured; `cloudflare:workers`
  is stubbed by `worker/test/preload.ts` (bunfig.toml); `worker/test/oauth.test.ts` drives the
  connector flow as claude.ai does (register, consent, PKCE token, MCP, revoke); MCP tests use
  the SDK's own client; `admin/test` signs Access tokens with a test RSA key.

## Deployment and releases

- CI (`.github/workflows/ci.yml`) dry-runs all three Workers on every PR, and deploys every green
  push to `main`: site, app, then portal (they bind in that order). Repo secrets:
  `CLOUDFLARE_API_TOKEN` (Workers, D1, the zone, and Access for the portal) and `OPERATOR_EMAIL`
  (without it the portal is skipped). Do not create or delete Cloudflare resources without asking.
- `@brutal-ai/schema` and `@brutal-ai/sdk` are published together at `worker/package.json`'s
  version: bump it in a PR, and `release.yml` publishes what's not on npm yet (trusted
  publishing, provenance) and tags it. `@brutal-ai/server` and `create-brutal-ai` (0.1.0, 0.2.0)
  belong to the dropped self-hosted model.
