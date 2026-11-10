<script lang="ts">
import { IMPACTS, KINDS, STATUSES } from "@brutal-ai/schema/constants";
import { api, type KeyInfo, type Project, type Report, when } from "../api";
import IssueButton from "../IssueButton.svelte";
import { Issues } from "../issues.svelte";
import { navigate, route } from "../router.svelte";

let { projectId }: { projectId: string } = $props();

let project = $state<Project | null>(null);
let keys = $state<KeyInfo[]>([]);
let reports = $state<Report[] | null>(null);
let next = $state<string | null>(null);
let error = $state("");
let newKey = $state({ kind: "ingest" as KeyInfo["kind"], name: "" });
let secret = $state<{ name: string; kind: string; value: string } | null>(null);
let retention = $state<number | null>(null);
let retentionInput = $state<number | null>(null);
let retentionSaved = $state(false);
let connections = $state<{ id: string; client: string; access: string; created_at: string }[]>([]);

const filters = $derived(new URLSearchParams(route.query));
const origin = location.origin;
let feedbackOrigin = $state<string | null>(null);
let reviewOrigin = $state<string | null>(null);

async function loadProject() {
  const r = await api<{
    project: Project;
    keys: KeyInfo[];
    feedback_origin: string | null;
    review_origin: string | null;
  }>(`/projects/${projectId}`);
  project = r.project;
  keys = r.keys;
  feedbackOrigin = r.feedback_origin;
  reviewOrigin = r.review_origin;
  connections = (
    await api<{ connections: typeof connections }>(`/projects/${projectId}/connections`)
  ).connections;
  retention = (await api<{ days: number | null }>(`/projects/${projectId}/retention`)).days;
  retentionInput = retention;
}

async function saveRetention(event: SubmitEvent) {
  event.preventDefault();
  error = "";
  retentionSaved = false;
  const days = typeof retentionInput === "number" ? retentionInput : null;
  if (days !== null && (retention === null || days < retention)) {
    if (!confirm(`Delete reports older than ${days} days, now and every day? It can't be undone.`))
      return;
  }
  try {
    retention = (
      await api<{ days: number | null }>(`/projects/${projectId}/retention`, {
        method: "PUT",
        body: { days },
      })
    ).days;
    retentionSaved = true;
  } catch (e) {
    error = (e as Error).message;
  }
}

async function disconnect(c: (typeof connections)[number]) {
  if (!confirm(`Disconnect ${c.client}? It loses access to this project.`)) return;
  await api(`/projects/${projectId}/connections/${c.id}`, { method: "DELETE" });
  await loadProject();
}

$effect(() => {
  const query = filters.toString();
  reports = null;
  api<{ reports: Report[]; next: string | null }>(`/projects/${projectId}/reports?${query}`)
    .then((r) => {
      reports = r.reports;
      next = r.next;
    })
    .catch((e) => (error = (e as Error).message));
});

$effect(() => {
  loadProject().catch((e) => (error = (e as Error).message));
});

const issues = $derived(new Issues(projectId));
$effect(() => {
  issues.load().catch((e) => (error = (e as Error).message));
});

function filter(name: string, value: string) {
  const q = new URLSearchParams(route.query);
  if (value) q.set(name, value);
  else q.delete(name);
  q.delete("before");
  navigate(`/projects/${projectId}${q.size ? `?${q}` : ""}`, true);
}

async function createKey(event: SubmitEvent) {
  event.preventDefault();
  error = "";
  try {
    const made = await api<{ key: KeyInfo; secret: string }>(`/projects/${projectId}/keys`, {
      method: "POST",
      body: newKey,
    });
    secret = { name: made.key.name, kind: made.key.kind, value: made.secret };
    newKey.name = "";
    await loadProject();
  } catch (e) {
    error = (e as Error).message;
  }
}

async function revoke(key: KeyInfo) {
  if (!confirm(`Revoke "${key.name}"? Anything using it stops working.`)) return;
  await api(`/projects/${projectId}/keys/${key.id}`, { method: "DELETE" });
  await loadProject();
}

const olderHref = $derived.by(() => {
  if (!next) return null;
  const q = new URLSearchParams(route.query);
  q.set("before", next);
  return `/projects/${projectId}?${q}`;
});
</script>

{#if project}
  <h1>{project.name}</h1>

  <h2>Reports</h2>
  <div class="row">
    <select value={filters.get("kind") ?? ""} onchange={(e) => filter("kind", e.currentTarget.value)}>
      <option value="">any kind</option>
      {#each KINDS as k (k)}<option>{k}</option>{/each}
    </select>
    <select value={filters.get("status") ?? ""} onchange={(e) => filter("status", e.currentTarget.value)}>
      <option value="">any status</option>
      {#each STATUSES as s (s)}<option>{s}</option>{/each}
    </select>
    <select value={filters.get("impact") ?? ""} onchange={(e) => filter("impact", e.currentTarget.value)}>
      <option value="">any impact</option>
      {#each IMPACTS as i (i)}<option>{i}</option>{/each}
    </select>
  </div>
  {#if reports === null}
    <p class="muted">Loading…</p>
  {:else if reports.length === 0}
    <p class="muted">No reports{filters.size ? " match these filters" : " yet. Connect an agent below"}.</p>
  {:else}
    <table>
      <thead><tr><th>When</th><th>Kind</th><th>Title</th><th>Tool</th><th>Impact</th><th>Status</th><th>Issue</th></tr></thead>
      <tbody>
        {#each reports as r (r.id)}
          <tr>
            <td class="muted">{when(r.created_at)}</td>
            <td>{r.kind}</td>
            <td><a href={`/projects/${projectId}/reports/${r.id}`}>{r.title}</a></td>
            <td>{r.tool_name ?? ""}</td>
            <td>{r.impact ?? ""}</td>
            <td>{r.status}</td>
            <td><IssueButton {issues} report={r} onCreated={(updated) => (reports = (reports ?? []).map((x) => (x.id === updated.id ? updated : x)))} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if olderHref}<p><a href={olderHref}>Older</a></p>{/if}
  {/if}

  <h2>Retention</h2>
  <p class="muted">Reports older than this are deleted once a day. Empty keeps them until you delete them.</p>
  <form class="row" onsubmit={saveRetention}>
    <input type="number" min="1" max="3650" step="1" bind:value={retentionInput} placeholder="Keep forever" aria-label="Retention in days" oninput={() => (retentionSaved = false)} />
    <span>days</span>
    <button>Save</button>
    {#if retentionSaved}<span class="muted">Saved.</span>{/if}
  </form>

  <h2>Keys</h2>
  <p class="muted">An ingest key only files reports: give it to your agent. A read key also reads and triages: for you, scripts and coding agents.</p>
  {#if secret}
    <div class="secret">
      <p>Your new {secret.kind} key, <strong>{secret.name}</strong>. Copy it now: it isn't shown again.</p>
      <code class="block">{secret.value}</code>
      <button class="link" onclick={() => (secret = null)}>Done</button>
    </div>
  {/if}
  <form class="row" onsubmit={createKey}>
    <select bind:value={newKey.kind}>
      <option value="ingest">ingest</option>
      <option value="read">read</option>
    </select>
    <input bind:value={newKey.name} placeholder="Key name, e.g. my agent" maxlength="80" required />
    <button class="primary">New key</button>
  </form>
  {#if keys.length}
    <table>
      <thead><tr><th>Name</th><th>Kind</th><th>Created</th><th></th></tr></thead>
      <tbody>
        {#each keys as k (k.id)}
          <tr>
            <td>{k.name}</td><td>{k.kind}</td><td class="muted">{when(k.created_at)}</td>
            <td><button class="link" onclick={() => revoke(k)}>Revoke</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <h2>Connected apps</h2>
  {#if connections.length === 0}
    <p class="muted">None yet. Connect Claude (below) and it shows up here.</p>
  {:else}
    <table>
      <thead><tr><th>App</th><th>May</th><th>Connected</th><th></th></tr></thead>
      <tbody>
        {#each connections as c (c.id)}
          <tr>
            <td>{c.client}</td>
            <td>{c.access === "triage" ? "review: read and triage" : "feedback: report"}</td>
            <td class="muted">{when(c.created_at)}</td>
            <td><button class="link" onclick={() => disconnect(c)}>Disconnect</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <h2>Connect an agent</h2>
  <p>Two MCP servers (<a href="/docs">how they work</a>). <strong>Feedback</strong>, for the agents using your tools: one tool, <code>report_feedback</code>; they never see the reports.</p>
  <code class="block">{feedbackOrigin ?? origin}/mcp</code>
  {#if reviewOrigin}
    <p><strong>Review</strong>, for your coding agent: list, read and triage this project's reports.</p>
    <code class="block">{reviewOrigin}/mcp</code>
  {/if}
  <p>Claude (claude.ai, Desktop, mobile): Settings → Connectors → Add custom connector, with either URL. You'll sign in, then pick this project. Add both to try your tools and read the feedback in one place.</p>
  <p>Claude Code (or any MCP client) with a key: an ingest or read key on feedback, a read key on review.</p>
  <code class="block">claude mcp add --transport http brutal {feedbackOrigin ?? origin}/mcp --header "Authorization: Bearer &lt;key&gt;"</code>
  {#if reviewOrigin}
    <code class="block">claude mcp add --transport http brutal-review {reviewOrigin}/mcp --header "Authorization: Bearer &lt;read key&gt;"</code>
  {/if}
  <p>Any language, over HTTP:</p>
  <code class="block">curl -X POST {origin}/v1/reports -H "Authorization: Bearer &lt;ingest key&gt;" -H "content-type: application/json" -d '{`{"kind":"friction","title":"…","summary":"…","tool_name":"…"}`}'</code>
  <p>TypeScript: <code>@brutal-ai/sdk</code> with <code>endpoint: "{origin}"</code> records your agent's recent tool calls and attaches them to every report.</p>
{/if}
{#if error}<p class="error">{error}</p>{/if}
