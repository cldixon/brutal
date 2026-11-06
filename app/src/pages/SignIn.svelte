<script lang="ts">
import { api } from "../api";
import { navigate, route } from "../router.svelte";

let { onSignedIn }: { onSignedIn: () => Promise<void> } = $props();

let email = $state("");
let code = $state("");
let step = $state<"email" | "code">("email");
let devCode = $state<string | null>(null);
let error = $state("");
let busy = $state(false);

async function sendCode(event: SubmitEvent) {
  event.preventDefault();
  error = "";
  busy = true;
  try {
    const sent = await api<{ sent: boolean; code?: string }>("/sign-in", {
      method: "POST",
      body: { email },
    });
    devCode = sent.code ?? null;
    step = "code";
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
  }
}

async function verify(event: SubmitEvent) {
  event.preventDefault();
  error = "";
  busy = true;
  try {
    await api("/sign-in/verify", { method: "POST", body: { email, code } });
    await onSignedIn();
    const next = new URLSearchParams(route.query).get("next");
    navigate(next?.startsWith("/") && !next.startsWith("//") ? next : "/projects", true);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
  }
}
</script>

<h1>Sign in</h1>
{#if step === "email"}
  <p>We'll email you a code. No password.</p>
  <form class="row" onsubmit={sendCode}>
    <input type="email" bind:value={email} placeholder="you@example.com" autocomplete="email" required />
    <button class="primary" disabled={busy}>Email me a code</button>
  </form>
{:else}
  <p>Enter the code we sent to <strong>{email}</strong>. It works for 15 minutes.</p>
  {#if devCode}
    <p class="muted">Local dev: the code is <code>{devCode}</code>.</p>
  {/if}
  <form class="row" onsubmit={verify}>
    <input bind:value={code} placeholder="Code" autocomplete="one-time-code" required />
    <button class="primary" disabled={busy}>Sign in</button>
    <button type="button" class="link" onclick={() => (step = "email")}>Use another email</button>
  </form>
{/if}
{#if error}<p class="error">{error}</p>{/if}
