import { IMPACTS, KINDS, type Report, STATUSES } from "@brutal/schema";
import { html, raw } from "hono/html";

/** The bare dashboard: server-rendered, no script. Everything from a report is escaped. */

const STYLE = `
body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; color: #111; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
pre { background: #f5f5f5; padding: .75rem; overflow-x: auto; white-space: pre-wrap; }
form.filters { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
.muted { color: #666; }
code.key { display: block; padding: .5rem; background: #f5f5f5; margin: .25rem 0 1rem; }
`;

function layout(title: string, body: unknown) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Brutal</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <p><a href="/">Brutal</a></p>
        ${body}
      </body>
    </html>`;
}

function select(name: string, options: readonly string[], current?: string) {
  return html`<select name="${name}">
    <option value="">any ${name}</option>
    ${options.map((o) => html`<option ${o === current ? "selected" : ""}>${o}</option>`)}
  </select>`;
}

export function reportsPage(reports: Report[], q: Record<string, string>, next: string | null) {
  const nextQuery = next ? new URLSearchParams({ ...q, before: next }).toString() : null;
  return layout(
    "Reports",
    html`<h1>Reports</h1>
      <form class="filters">
        ${select("kind", KINDS, q.kind)} ${select("status", STATUSES, q.status)}
        ${select("impact", IMPACTS, q.impact)}
        <input name="tool_name" placeholder="tool" value="${q.tool_name ?? ""}" />
        <button>Filter</button>
      </form>
      ${
        reports.length === 0
          ? html`<p class="muted">No reports yet.</p>`
          : html`<table>
            <thead>
              <tr><th>When</th><th>Kind</th><th>Title</th><th>Tool</th><th>Impact</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${reports.map(
                (r) => html`<tr>
                  <td class="muted">${r.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td>${r.kind}</td>
                  <td><a href="/reports/${r.id}">${r.title}</a></td>
                  <td>${r.tool_name ?? ""}</td>
                  <td>${r.impact ?? ""}</td>
                  <td>${r.status}</td>
                </tr>`,
              )}
            </tbody>
          </table>`
      }
      ${nextQuery ? html`<p><a href="/?${nextQuery}">Older</a></p>` : ""}`,
  );
}

export function reportPage(r: Report) {
  const { recent_tool_calls: calls = [], ...context } = r.context;
  return layout(
    r.title,
    html`<h1>${r.title}</h1>
      <p class="muted">
        ${r.kind}${r.tool_name ? ` · ${r.tool_name}` : ""}${r.impact ? ` · ${r.impact}` : ""} ·
        ${r.status} · ${r.created_at}
        ${r.issue_url ? html` · <a href="${r.issue_url}">issue</a>` : ""}
      </p>
      <p>${r.summary}</p>
      ${r.details ? html`<h2>Details</h2><pre>${r.details}</pre>` : ""}
      ${r.user_impact ? html`<h2>User impact</h2><p>${r.user_impact}</p>` : ""}
      <h2>Recent tool calls</h2>
      ${
        calls.length === 0
          ? html`<p class="muted">None attached.</p>`
          : html`<table>
            <thead><tr><th>Tool</th><th>Status</th><th>Latency</th><th>Args</th><th>Result or error</th></tr></thead>
            <tbody>
              ${calls.map(
                (t) => html`<tr>
                  <td>${t.name}</td>
                  <td>${t.status ?? ""}</td>
                  <td>${t.latency_ms !== undefined ? `${t.latency_ms} ms` : ""}</td>
                  <td><pre>${JSON.stringify(t.args ?? null, null, 2)}</pre></td>
                  <td><pre>${t.error ?? JSON.stringify(t.result ?? null, null, 2)}</pre></td>
                </tr>`,
              )}
            </tbody>
          </table>`
      }
      <h2>Context</h2>
      <pre>${JSON.stringify(context, null, 2)}</pre>`,
  );
}

export function setupPage(state: {
  keys?: { ingest: string; read: string };
  claimed?: boolean;
  wrongCode?: boolean;
}) {
  const { keys } = state;
  if (keys) {
    return layout(
      "Set up",
      html`<h1>Your keys</h1>
        <p>Copy these now: they are not shown again.</p>
        <p>Ingest key, for your agent's backend (it can only submit reports):</p>
        <code class="key">${keys.ingest}</code>
        <p>Read key, for the dashboard, the CLI and coding agents (it reads and triages):</p>
        <code class="key">${keys.read}</code>
        <p><a href="/">Open the dashboard</a> with any username and the read key as the password.</p>`,
    );
  }
  if (state.claimed) {
    return layout("Set up", html`<h1>Set up Brutal</h1><p>This instance is already set up.</p>`);
  }
  return layout(
    "Set up",
    html`<h1>Set up Brutal</h1>
      ${state.wrongCode ? html`<p>That code is not right.</p>` : ""}
      <p>
        Enter the setup code: the <code>SETUP_CODE</code> secret if you set one, otherwise the
        code in this Worker's logs (it was written there when this page opened).
      </p>
      <form method="post">
        <input name="code" autocomplete="off" required />
        <button>Make keys</button>
      </form>`,
  );
}
