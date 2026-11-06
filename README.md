# Brutal

Feedback for agents. An agent running inside your application calls one hidden tool,
`report_feedback`, to tell its developers about friction, bugs, gaps in the tool layer, and
tasks worth keeping as evals. Developers and coding agents read the reports back and triage them.

This is the skeleton: one Cloudflare Worker on D1 that you deploy to your own account.

| Surface                 | Where                                                                                                                            | Key    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `POST /v1/reports`      | ingest one report                                                                                                                | ingest |
| `GET /v1/reports`       | list, newest first; filter by `kind`, `status`, `tool_name`, `impact`, `agent_name`, `app_version`, `branch`; page with `before` | read   |
| `GET /v1/reports/:id`   | one report with its context                                                                                                      | read   |
| `PATCH /v1/reports/:id` | set `status`, link `issue_url`                                                                                                   | read   |
| `GET /v1/schema/tool`   | the canonical tool definition (name, description, JSON Schema)                                                                   | public |
| `/mcp`                  | ingest key: `report_feedback`; read key: `list_reports`, `get_report`, `update_report`, `get_eval_candidates`                    | either |
| `/`                     | the dashboard (Basic auth: any username, the read key as password)                                                               | read   |
| `/setup`                | first run: makes one ingest and one read key, once                                                                               | none   |

Ingest keys only submit, so they are safe in an app's backend. Read keys read and triage.

## Run it

```sh
bun install
bun run dev                      # cf dev on http://localhost:8787
open http://localhost:8787/setup # make your keys with the setup code
```

The setup code is the `SETUP_CODE` secret if you set one; otherwise the Worker makes one when
`/setup` first opens and writes it to its logs (the `cf dev` output locally; Workers Logs in the
Cloudflare dashboard when deployed). It works once.

File a report:

```sh
curl -X POST localhost:8787/v1/reports \
  -H "authorization: Bearer $BRUTAL_INGEST_KEY" -H 'content-type: application/json' \
  -d '{"kind":"friction","title":"Year filter rejects 2024-25","summary":"search_parts refused a fiscal-year range.","tool_name":"search_parts","impact":"worked_around","context":{"conversation_id":"c1","app_version":"1.4.0"}}'
```

Connect Claude Code, as an agent that reports and as a developer that triages:

```sh
claude mcp add --transport http brutal http://localhost:8787/mcp --header "Authorization: Bearer $BRUTAL_INGEST_KEY"
claude mcp add --transport http brutal-triage http://localhost:8787/mcp --header "Authorization: Bearer $BRUTAL_READ_KEY"
```

## The TypeScript SDK

`@brutal-ai/sdk` gives your agent the tool, records its recent tool calls per conversation, and
attaches them to every report. Delivery never slows or fails the agent's turn.

```ts
import { createBrutal } from "@brutal-ai/sdk";

const brutal = createBrutal({
  endpoint: process.env.BRUTAL_URL,
  ingestKey: process.env.BRUTAL_INGEST_KEY,
  context: () => ({ app_version: VERSION, environment: "production" }),
  redact: (report) => report, // scrub, or return null to drop
});

const convo = brutal.conversation(conversationId);
const searchParts = convo.wrap("search_parts", rawSearchParts); // recorded from now on

// Anthropic Messages API: tools: [brutal.anthropicTool(), ...]
// when the model calls report_feedback: tool_result content = await convo.handle(block.input)
// Vercel AI SDK: tools: { report_feedback: brutal.aiSdkTool(conversationId), ... }
```

`examples/broken-tools.ts` runs a stand-in agent against deliberately broken tools:
`BRUTAL_URL=… BRUTAL_INGEST_KEY=… bun run --cwd examples broken-tools`.

## Deploy your own

Brutal runs on your own Cloudflare account, so reports never leave infrastructure you control.

```sh
bun create brutal-ai my-brutal
```

That makes a folder (its own git repo) holding your settings, `brutal.config.json` (Worker name,
optional custom domain), and depending on `@brutal-ai/server`, the prebuilt Worker. It asks you
to sign in to Cloudflare, asks for the settings, and deploys. The first deploy prints a setup
code: open `/setup` on your instance and enter it for your keys. Updating is
`bun update @brutal-ai/server && bun run deploy`; the database migrates itself.

## Releases

Four packages are released together from a `v*` tag matching `worker/package.json`'s version
(`.github/workflows/release.yml`): `@brutal-ai/server`, `@brutal-ai/schema`, `@brutal-ai/sdk`
and `create-brutal-ai`. `bun run pack` builds and packs them into `dist/` without publishing.

## Develop

`worker/brutal.config.json` (gitignored) holds the settings of the instance deployed from this
repo; `bun run --cwd worker setup` writes it, and `bun run deploy` deploys with it. CI uses
`brutal.config.example.json` through `BRUTAL_CONFIG`. `bun run dev` needs no settings.

## Layout

- `packages/schema`: the report schema (zod), the tool description and its JSON Schema.
- `packages/sdk`: the TypeScript SDK (tool formats, recorder, redaction, delivery).
- `worker`: the Worker (Hono): API, MCP, dashboard, setup, D1 migrations; `config.ts`
  (`defineBrutal`, the Worker's cf config from an owner's settings) and `cli/brutal-server.ts`.
- `packages/create-brutal-ai`: `bun create brutal-ai`.
- `scripts/pack.ts`: builds the four publishable packages.
- `examples`: a stand-in agent against broken tools.

`bun run check` runs lint (Biome), typecheck and tests, as CI does.
