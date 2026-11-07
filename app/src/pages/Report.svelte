<script lang="ts">
import { STATUSES } from "@brutal-ai/schema/constants";
import { api, type Report, when } from "../api";
import CreateIssue from "../CreateIssue.svelte";
import { navigate } from "../router.svelte";

let { projectId, reportId }: { projectId: string; reportId: string } = $props();

let report = $state<Report | null>(null);
let issueUrl = $state("");
let error = $state("");

$effect(() => {
  api<Report>(`/projects/${projectId}/reports/${reportId}`)
    .then((r) => {
      report = r;
      issueUrl = r.issue_url ?? "";
    })
    .catch((e) => (error = (e as Error).message));
});

async function update(change: { status?: string; issue_url?: string | null }) {
  error = "";
  try {
    report = await api<Report>(`/projects/${projectId}/reports/${reportId}`, {
      method: "PATCH",
      body: change,
    });
  } catch (e) {
    error = (e as Error).message;
  }
}

async function remove() {
  if (!confirm("Delete this report? It can't be undone.")) return;
  error = "";
  try {
    await api(`/projects/${projectId}/reports/${reportId}`, { method: "DELETE" });
    navigate(`/projects/${projectId}`);
  } catch (e) {
    error = (e as Error).message;
  }
}

const calls = $derived(report?.context.recent_tool_calls ?? []);
const context = $derived.by(() => {
  if (!report) return {};
  const { recent_tool_calls: _, ...rest } = report.context;
  return rest;
});
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? null, null, 2));
</script>

<p><a href={`/projects/${projectId}`}>← Reports</a></p>
{#if report}
  <h1>{report.title}</h1>
  <p class="muted">
    {report.kind}{report.tool_name ? ` · ${report.tool_name}` : ""}{report.impact ? ` · ${report.impact}` : ""} · {when(report.created_at)}
  </p>
  <p>{report.summary}</p>
  {#if report.details}<h2>Details</h2><pre>{report.details}</pre>{/if}
  {#if report.user_impact}<h2>User impact</h2><p>{report.user_impact}</p>{/if}

  <h2>Triage</h2>
  <form class="row" onsubmit={(e) => { e.preventDefault(); update({ issue_url: issueUrl || null }); }}>
    <select value={report.status} onchange={(e) => update({ status: e.currentTarget.value })}>
      {#each STATUSES as s (s)}<option>{s}</option>{/each}
    </select>
    <input type="url" bind:value={issueUrl} placeholder="Issue URL" />
    <button>Save link</button>
    {#if report.issue_url}<a href={report.issue_url} rel="noopener noreferrer">Open issue</a>{/if}
  </form>
  <p><button onclick={remove}>Delete report</button></p>

  {#if !report.issue_url}
    <CreateIssue {projectId} {reportId} onCreated={(r) => { report = r; issueUrl = r.issue_url ?? ""; }} />
  {/if}

  <h2>Recent tool calls</h2>
  {#if calls.length === 0}
    <p class="muted">None attached.</p>
  {:else}
    <table>
      <thead><tr><th>Tool</th><th>Status</th><th>Latency</th><th>Args</th><th>Result or error</th></tr></thead>
      <tbody>
        {#each calls as t, i (i)}
          <tr>
            <td>{t.name}</td>
            <td>{t.status ?? ""}</td>
            <td>{t.latency_ms !== undefined ? `${t.latency_ms} ms` : ""}</td>
            <td><pre>{show(t.args)}</pre></td>
            <td><pre>{t.error ?? show(t.result)}</pre></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <h2>Context</h2>
  <pre>{JSON.stringify(context, null, 2)}</pre>
{/if}
{#if error}<p class="error">{error}</p>{/if}
