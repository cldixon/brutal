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
open http://localhost:8787/setup # make your keys
```

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

## Deploy

```sh
bun run deploy   # cf deploy: creates the D1 database on first deploy
```

Then open `/setup` on your Worker's URL straight away. The database migrates itself on first
use; nobody runs a migration.

## Layout

- `packages/schema`: the report schema (zod), the tool description and its JSON Schema.
- `worker`: the Worker (Hono): API, MCP, dashboard, D1 migrations.

`bun run check` runs lint (Biome), typecheck and tests, as CI does.
