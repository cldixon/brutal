# Brutal

Feedback for agents. An agent running inside your application calls one tool, `report_feedback`,
to tell you about friction, bugs, gaps in its tools, and tasks worth keeping as evals. Each report
arrives with the agent's recent tool calls attached. You, or your coding agent, read and triage
them.

Hosted at **https://brutal.cldixon.dev**: sign in with your email (a code is mailed to you), make
a project for each agent or tool you're testing, and give the agent a key.

## Connect an agent

| Surface                                          | Use                                                                                                                               | Key    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `/mcp`                                           | MCP: an ingest key gives `report_feedback`; a read key gives `list_reports`, `get_report`, `update_report`, `get_eval_candidates` | either |
| `POST /v1/reports`                               | file one report                                                                                                                   | ingest |
| `GET /v1/reports`, `GET`/`PATCH /v1/reports/:id` | list, read, triage                                                                                                                | read   |
| `GET /v1/schema/tool`                            | the canonical tool definition (name, description, JSON Schema)                                                                    | none   |
| `@brutal-ai/sdk`                                 | TypeScript: the tool in Anthropic and Vercel AI SDK shapes, plus a recorder that attaches recent tool calls                       | ingest |

```sh
claude mcp add --transport http brutal https://brutal.cldixon.dev/mcp --header "Authorization: Bearer <key>"
```

```ts
import { createBrutal } from "@brutal-ai/sdk";

const brutal = createBrutal({
  endpoint: "https://brutal.cldixon.dev",
  ingestKey: process.env.BRUTAL_INGEST_KEY,
});
const convo = brutal.conversation(conversationId);
const searchParts = convo.wrap("search_parts", rawSearchParts); // recorded from now on
// tools: [brutal.anthropicTool(), ...]; on a report_feedback call: await convo.handle(block.input)
```

`examples/broken-tools.ts` runs a stand-in agent against deliberately broken tools:
`BRUTAL_URL=… BRUTAL_INGEST_KEY=… bun run --cwd examples broken-tools`.

## How it's built

- `worker/`: one Cloudflare Worker (Hono). Accounts (people, sign-in codes, sessions, projects,
  keys) are in D1; each project's reports are in its own Durable Object with SQLite.
- `app/`: the web app, Svelte 5 and Vite, served as the Worker's static assets.
- `packages/schema`, `packages/sdk`: the report schema and the TypeScript SDK, published to npm.

## Develop

```sh
bun install
cp worker/.dev.vars.sample worker/.dev.vars   # sign-in codes show on the page
bun run build                                 # the web app, into app/dist
bun run dev                                   # cf dev on http://localhost:8787
bun run --cwd app dev                         # optional: Vite with hot reload, proxying the API
```

`bun run check` runs lint (Biome), typecheck (tsc, svelte-check) and tests, as CI does. Every
green push to `main` deploys to brutal.cldixon.dev. Releasing the npm packages is bumping
`worker/package.json`'s version in a PR (`.github/workflows/release.yml`).
