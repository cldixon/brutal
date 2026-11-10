<script lang="ts">
import { STATUSES } from "@brutal-ai/schema/constants";
import { api, type Report, when } from "../api";
import IssueButton from "../IssueButton.svelte";
import { Issues } from "../issues.svelte";
import { navigate } from "../router.svelte";

let { projectId, reportId }: { projectId: string; reportId: string } = $props();

let report = $state<Report | null>(null);
let error = $state("");
const issues = $derived(new Issues(projectId));

$effect(() => {
  api<Report>(`/projects/${projectId}/reports/${reportId}`)
    .then((r) => (report = r))
    .catch((e) => (error = (e as Error).message));
});

$effect(() => {
  issues.load().catch((e) => (error = (e as Error).message));
});

async function update(change: { status?: string }) {
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
  <div class="row">
    <select value={report.status} onchange={(e) => update({ status: e.currentTarget.value })} aria-label="Status">
      {#each STATUSES as s (s)}<option>{s}</option>{/each}
    </select>
    <IssueButton {issues} {report} onCreated={(r) => (report = r)} />
  </div>

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

  <p><button onclick={remove}>Delete report</button></p>
{/if}
{#if error}<p class="error">{error}</p>{/if}
