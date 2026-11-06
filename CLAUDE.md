# CLAUDE.md

## Spec

The design is the **Brutal — Handoff** Claude Doc: https://claude.ai/artifact/6vdZJyNoajH9EkVxHKiG6j.
Read it before architectural decisions. Where this repo deliberately differs, it says so below.

## Where the code differs from the handoff

- **Bun workspaces**, not pnpm; **`cf`** (Cloudflare's CLI, pinned in `worker/`), not Wrangler.
  The Worker is configured in `worker/cloudflare.config.ts`; there is no `wrangler.jsonc`.
  Find commands with `bunx cf cli search "<task>"` (generic wording), then `--help`.
  Set `CF_SEND_TELEMETRY=false` in scripts and CI.
- **MCP is stateless Streamable HTTP** with `@modelcontextprotocol/sdk` (a fresh server per request,
  `worker/src/mcp.ts`), not the Agents SDK's `McpAgent`: no Durable Object is needed yet.
- **Migrations apply themselves** on first use per isolate (`worker/src/db.ts`), so a
  self-deployer never runs one. Never edit a shipped migration; only add.
- **Dashboard auth** is the browser's Basic auth with the read key as password, until Access.
- **Setup** (`worker/src/setup.ts`) takes a setup code, as igloo does: the `SETUP_CODE` secret,
  or one generated on first use and written only to the Worker's logs. The claim is one D1 batch.
- **The SDK depends on `@brutal/schema` (and so zod)**; the handoff's "zero runtime deps" waits
  until it is bundled for publishing.

## Deployment

The reference deployment is the Worker `brutal` on `https://brutal.cl-dixon.workers.dev` (D1
`brutal`), deployed with `bun run deploy`. It is claimed. Do not create or delete Cloudflare
resources without asking.

## Tooling

- bun for everything (`bun install`, `bun run …`, `bun test`, `bunx`); no npm/npx/yarn/pnpm.
- Biome for lint and format (`bun run format`). `bun run check` before every commit.
- Tests run under `bun test`; D1 is `worker/test/d1.ts` over `bun:sqlite`; MCP tests use the SDK's
  own client against the app in process.

## Not built yet (handoff milestones)

OpenAI/Bedrock/Mastra/LangChain tool formats and a model-driven eval script (M2), CLI (M4), clustering with Queues + Vectorize, issue
sync, webhooks and the Deploy to Cloudflare button (M5), rate limits per conversation, retention.
