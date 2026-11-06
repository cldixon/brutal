# Brutal

Feedback for agents. An agent running inside your application calls one tool, `report_feedback`,
to tell you about friction, bugs and gaps in its tools. Each report arrives with the agent's
recent tool calls attached. You, or your coding agent, read and triage them.

Hosted at **https://thatsbrutal.fyi**: sign in with your email (a code is mailed to you), make
a project for each agent or tool you're testing, and give the agent a key.

## Connect an agent

Two MCP servers, so an agent using your tools never learns that reports can be read:

| Surface                                          | Use                                                                                                         | Key          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------ |
| `https://thatsbrutal.fyi/mcp`                    | Feedback MCP: `report_feedback`, nothing else                                                               | ingest, read |
| `https://review.thatsbrutal.fyi/mcp`             | Review MCP: `list_reports`, `get_report`, `update_report`                                                   | read         |
| `POST /v1/reports`                               | file one report                                                                                             | ingest       |
| `GET /v1/reports`, `GET`/`PATCH /v1/reports/:id` | list, read, triage                                                                                          | read         |
| `GET /v1/schema/tool`                            | the canonical tool definition (name, description, JSON Schema)                                              | none         |
| `@brutal-ai/sdk`                                 | TypeScript: the tool in Anthropic and Vercel AI SDK shapes, plus a recorder that attaches recent tool calls | ingest       |

**Claude (claude.ai, Desktop, mobile):** Settings → Connectors → Add custom connector, with
either URL. You sign in and pick a project; what the connection may do is the server's (report on
feedback, read and triage on review), and the project page lists it with Disconnect. Add both
to test your tools with Claude and read what it reported in the same place.

**Claude Code, scripts and the SDK** use a project's key:

```sh
claude mcp add --transport http brutal https://thatsbrutal.fyi/mcp --header "Authorization: Bearer <key>"
claude mcp add --transport http brutal-review https://review.thatsbrutal.fyi/mcp --header "Authorization: Bearer <read key>"
```

```ts
import { createBrutal } from "@brutal-ai/sdk";

const brutal = createBrutal({
  endpoint: "https://thatsbrutal.fyi",
  ingestKey: process.env.BRUTAL_INGEST_KEY,
});
const convo = brutal.conversation(conversationId);
const searchParts = convo.wrap("search_parts", rawSearchParts); // recorded from now on
// tools: [brutal.anthropicTool(), ...]; on a report_feedback call: await convo.handle(block.input)
```

`examples/broken-tools.ts` runs a stand-in agent against deliberately broken tools:
`BRUTAL_URL=… BRUTAL_INGEST_KEY=… bun run --cwd examples broken-tools`.

## How it's built

Three Cloudflare Workers, as Tempra is built. Their names and hosts are in `deploy.config.ts`.

| Folder                | Worker         | What it is                                                                                                                                                                                                                      |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/` + `app/`    | `brutal`       | The app on the main domain: the API (`/v1`), the feedback MCP (`/mcp`; the review MCP on `review.`), the web app's API (`/api`) and the Svelte 5 web app. Accounts are in D1; each project's reports in its own Durable Object. |
| `site/` (`site/web/`) | `brutal-site`  | The landing page, built with Astro. No host of its own: the app shows it at `/` to people who aren't signed in, through a service binding.                                                                                      |
| `admin/`              | `brutal-admin` | The operator's portal, on its own host behind Cloudflare Access: the waitlist, invites and accounts, through the app's `Operator` entrypoint.                                                                                   |

`packages/schema` and `packages/sdk` are the report schema and the TypeScript SDK, published to npm.

## Develop

```sh
bun install
cp worker/.dev.vars.sample worker/.dev.vars   # sign-in codes show on the page
bun run build                                 # the web app, into app/dist
bun run dev                                   # cf dev on http://localhost:8787
bun run --cwd app dev                         # optional: Vite with hot reload, proxying the API
```

`bun run check` runs lint (Biome), typecheck (tsc, svelte-check, astro check) and tests, as CI
does. Every green push to `main` deploys the site, the app and the portal, in that order (repo
secrets `CLOUDFLARE_API_TOKEN` and `OPERATOR_EMAIL`). Sign-up is invite-only: admit people from
the portal, or with `bun run admin invite --email …`. Releasing the npm packages is bumping
`worker/package.json`'s version in a PR (`.github/workflows/release.yml`).
