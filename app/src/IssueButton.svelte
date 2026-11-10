<script lang="ts">
import type { Report } from "./api";
import type { Destination, Issues } from "./issues.svelte";

/**
 * One report's Create issue button: greyed out until GitHub or Linear is connected, then it
 * files where the project's issues go (asking once when that isn't known), and ▾ picks another
 * place. A report with an issue gets a link to it instead.
 */
let {
  issues,
  report,
  onCreated,
}: { issues: Issues; report: Report; onCreated: (r: Report) => void } = $props();

let busy = $state(false);
let error = $state("");
/** The places to pick from, while the picker is open. */
let choices = $state<Destination[] | null>(null);
let picked = $state("");
let where = $state<Destination | null>(null);

$effect(() => {
  if (!issues.connected) return;
  void issues.preferred;
  issues
    .default()
    .then((d) => (where = d))
    .catch(() => (where = null));
});

const key = (d: Destination) => `${d.integration} ${d.target}`;

async function file(d: Destination) {
  busy = true;
  error = "";
  try {
    onCreated(await issues.create(report.id, d));
    choices = null;
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
  }
}

async function pick() {
  error = "";
  try {
    const all = await issues.destinations();
    if (all.length === 0) {
      error =
        "Nothing to file into yet: install the GitHub App on a repository, or join a Linear team.";
      return;
    }
    choices = all;
    picked = key(where ?? (all[0] as Destination));
  } catch (e) {
    error = (e as Error).message;
  }
}

async function primary() {
  if (where) return file(where);
  const d = await issues.default().catch(() => null);
  if (d) return file(d);
  await pick();
}

function confirmPick(event: SubmitEvent) {
  event.preventDefault();
  const d = choices?.find((c) => key(c) === picked);
  if (d) file(d);
}

const hint = $derived(
  !issues.connected
    ? "Connect GitHub or Linear on the Projects page to create issues"
    : where
      ? `Create an issue in ${where.label}`
      : "Create an issue: pick where it goes",
);
</script>

{#if report.issue_url}
  <a href={report.issue_url} rel="noopener noreferrer">Open issue</a>
{:else}
  <span class="split">
    <button class="primary" disabled={!issues.connected || busy} title={hint} onclick={primary}>
      {busy ? "Creating…" : "Create issue"}
    </button>
    {#if issues.connected}
      <button class="caret" disabled={busy} aria-label="Choose where the issue goes" aria-expanded={choices !== null} onclick={() => (choices ? (choices = null) : pick())}>▾</button>
    {/if}
  </span>
  {#if choices}
    <form class="row picker" onsubmit={confirmPick}>
      <select bind:value={picked} aria-label="Where the issue goes">
        {#each choices as c (key(c))}<option value={key(c)}>{c.label}</option>{/each}
      </select>
      <button class="primary" disabled={busy}>Create</button>
      <button type="button" class="link" onclick={() => (choices = null)}>Cancel</button>
    </form>
  {/if}
  {#if error}<span class="error">{error}</span>{/if}
{/if}
