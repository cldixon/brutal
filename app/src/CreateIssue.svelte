<script lang="ts">
import { api, type Report } from "./api";
import {
  connectUrl,
  type Integration,
  loadIntegrations,
  type ProviderInfo,
  type Target,
} from "./integrations";

let {
  projectId,
  reportId,
  onCreated,
}: { projectId: string; reportId: string; onCreated: (r: Report) => void } = $props();

let providers = $state<ProviderInfo[]>([]);
let integrations = $state<Integration[]>([]);
let integration = $state("");
let target = $state("");
let targets = $state<Target[] | null>(null);
let preferred = $state<{ integration: string; target: string } | null>(null);
let busy = $state(false);
let error = $state("");

$effect(() => {
  Promise.all([
    loadIntegrations(),
    api<{ default: typeof preferred }>(`/projects/${projectId}/issue-target`),
  ])
    .then(([r, d]) => {
      providers = r.providers;
      integrations = r.integrations;
      preferred = d.default;
      const start =
        r.integrations.find((i) => i.id === d.default?.integration) ?? r.integrations[0];
      if (start) pick(start.id);
    })
    .catch((e) => (error = (e as Error).message));
});

async function pick(id: string) {
  integration = id;
  targets = null;
  target = "";
  error = "";
  try {
    const r = await api<{ targets: Target[] }>(`/integrations/${id}/targets`);
    if (integration !== id) return;
    targets = r.targets;
    const remembered = preferred?.integration === id ? preferred.target : "";
    target = r.targets.some((t) => t.id === remembered) ? remembered : (r.targets[0]?.id ?? "");
  } catch (e) {
    error = (e as Error).message;
  }
}

async function create(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  error = "";
  try {
    const report = await api<Report>(`/projects/${projectId}/reports/${reportId}/issue`, {
      method: "POST",
      body: { integration, target },
    });
    onCreated(report);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
  }
}

const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
const current = $derived(integrations.find((i) => i.id === integration));
const install = $derived(
  current?.provider === "github" ? providers.find((p) => p.id === "github")?.install_url : null,
);
const unconnected = $derived(
  providers.filter((p) => p.available && !integrations.some((i) => i.provider === p.id)),
);
</script>

<h2>Create issue</h2>
{#if integrations.length > 0}
  <form class="row" onsubmit={create}>
    <select value={integration} onchange={(e) => pick(e.currentTarget.value)} aria-label="Connection">
      {#each integrations as i (i.id)}<option value={i.id}>{nameOf(i.provider)} · {i.account}</option>{/each}
    </select>
    {#if targets === null}
      <span class="muted">Loading…</span>
    {:else if targets.length === 0}
      <span class="muted">Nothing to file into.</span>
    {:else}
      <select bind:value={target} aria-label={current?.provider === "linear" ? "Team" : "Repository"}>
        {#each targets as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
      </select>
    {/if}
    <button class="primary" disabled={busy || !target}>{busy ? "Creating…" : "Create"}</button>
    {#if install}<a href={install} rel="noopener noreferrer">Install the app on more repositories</a>{/if}
  </form>
{/if}
{#if unconnected.length > 0}
  <p class="row">
    {#each unconnected as p (p.id)}
      <!-- target=_self: a full page load, so the router leaves it to the Worker. -->
      <a href={connectUrl(p.id)} target="_self">Connect {p.name}</a>
    {/each}
  </p>
{:else if integrations.length === 0 && providers.length > 0}
  <p class="muted">Issue integrations aren't set up on this deployment.</p>
{/if}
{#if error}<p class="error">{error}</p>{/if}
