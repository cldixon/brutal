<script lang="ts">
import { api, type Project, when } from "../api";
import Integrations from "../Integrations.svelte";
import { navigate } from "../router.svelte";

let projects = $state<Project[] | null>(null);
let name = $state("");
let error = $state("");

api<{ projects: Project[] }>("/projects")
  .then((r) => (projects = r.projects))
  .catch((e) => (error = (e as Error).message));

async function create(event: SubmitEvent) {
  event.preventDefault();
  error = "";
  try {
    const project = await api<Project>("/projects", { method: "POST", body: { name } });
    navigate(`/projects/${project.id}`);
  } catch (e) {
    error = (e as Error).message;
  }
}
</script>

<h1>Projects</h1>
<p class="muted">A project is one agent or tool you're collecting feedback on. Each has its own keys and reports.</p>
<form class="row" onsubmit={create}>
  <input bind:value={name} placeholder="Project name" maxlength="80" required />
  <button class="primary">New project</button>
</form>
{#if error}<p class="error">{error}</p>{/if}
{#if projects === null}
  <p class="muted">Loading…</p>
{:else if projects.length === 0}
  <p class="muted">No projects yet.</p>
{:else}
  <table>
    <thead><tr><th>Name</th><th>Created</th></tr></thead>
    <tbody>
      {#each projects as p (p.id)}
        <tr><td><a href={`/projects/${p.id}`}>{p.name}</a></td><td class="muted">{when(p.created_at)}</td></tr>
      {/each}
    </tbody>
  </table>
{/if}

<Integrations />
