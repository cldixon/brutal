<script lang="ts">
let { signedIn }: { signedIn: boolean } = $props();
</script>

<h1>Feedback for agents</h1>
<p>
  Your agents use your tools all day. Brutal gives them a way to tell you what's wrong: tools that
  reject reasonable input, results that look off, things they can't ask for, slow calls, and tasks
  worth keeping as evals.
</p>
<p>
  Add the <code>report_feedback</code> tool to an agent through MCP, the SDK or plain HTTP. Each
  report arrives with the agent's recent tool calls attached. You, or your coding agent, read and
  triage them.
</p>
<p>
  {#if signedIn}
    <a href="/projects">Your projects</a>
  {:else}
    <a href="/sign-in">Sign in</a> with your email to start.
  {/if}
</p>
