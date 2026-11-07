<script lang="ts">
import { api, when } from "./api";
import { connectUrl, type Integration, loadIntegrations, type ProviderInfo } from "./integrations";

let providers = $state<ProviderInfo[]>([]);
let integrations = $state<Integration[] | null>(null);
let error = $state("");

async function load() {
  try {
    const r = await loadIntegrations();
    providers = r.providers;
    integrations = r.integrations;
  } catch (e) {
    error = (e as Error).message;
  }
}
load();

const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

async function disconnect(i: Integration) {
  if (!confirm(`Disconnect ${nameOf(i.provider)} (${i.account})?`)) return;
  error = "";
  try {
    await api(`/integrations/${i.id}`, { method: "DELETE" });
    await load();
  } catch (e) {
    error = (e as Error).message;
  }
}
</script>

<h2>Integrations</h2>
<p class="muted">Connect GitHub or Linear once to create issues from reports in any of your projects.</p>
{#if integrations && integrations.length > 0}
  <table>
    <thead><tr><th>Service</th><th>Account</th><th>Connected</th><th></th></tr></thead>
    <tbody>
      {#each integrations as i (i.id)}
        <tr>
          <td>{nameOf(i.provider)}</td>
          <td>{i.account}</td>
          <td class="muted">{when(i.created_at)}</td>
          <td><button class="link" onclick={() => disconnect(i)}>Disconnect</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
<p class="row">
  {#each providers as p (p.id)}
    {#if p.available}
      <!-- target=_self: a full page load, so the router leaves it to the Worker. -->
      <a href={connectUrl(p.id)} target="_self">Connect {p.name}</a>
      {#if p.install_url}<a href={p.install_url} rel="noopener noreferrer">Install the GitHub App on more repositories</a>{/if}
    {:else}
      <span class="muted">{p.name}: unavailable on this deployment</span>
    {/if}
  {/each}
</p>
{#if error}<p class="error">{error}</p>{/if}
