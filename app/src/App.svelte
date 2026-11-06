<script lang="ts">
import { api } from "./api";
import Landing from "./pages/Landing.svelte";
import ProjectPage from "./pages/Project.svelte";
import Projects from "./pages/Projects.svelte";
import ReportPage from "./pages/Report.svelte";
import SignIn from "./pages/SignIn.svelte";
import { match, navigate, route } from "./router.svelte";

let me = $state<{ email: string } | null>(null);
let checked = $state(false);

async function refreshMe() {
  me = await api<{ email: string }>("/me").catch(() => null);
  checked = true;
}
refreshMe();

async function signOut() {
  await api("/sign-out", { method: "POST" });
  me = null;
  navigate("/");
}

const report = $derived(match("/projects/:project/reports/:id", route.path));
const project = $derived(match("/projects/:project", route.path));
</script>

<main>
  <nav>
    <a class="brand" href={me ? "/projects" : "/"}>Brutal</a>
    {#if me}
      <span class="muted">{me.email} · <button class="link" onclick={signOut}>Sign out</button></span>
    {:else if checked && route.path !== "/sign-in"}
      <a href="/sign-in">Sign in</a>
    {/if}
  </nav>

  {#if route.path === "/"}
    <Landing signedIn={me !== null} />
  {:else if route.path === "/sign-in"}
    <SignIn onSignedIn={refreshMe} />
  {:else if route.path === "/projects"}
    <Projects />
  {:else if report}
    <ReportPage projectId={report.project ?? ""} reportId={report.id ?? ""} />
  {:else if project}
    <ProjectPage projectId={project.project ?? ""} />
  {:else}
    <h1>Not found</h1>
    <p><a href="/">Home</a></p>
  {/if}
</main>
