/**
 * Creating issues from a project's reports: the person's connections (GitHub, Linear), where
 * the project's issues go by default, and the places they can go. One per project page, shared
 * by every Create issue button on it.
 */
import { api, type Report } from "./api";
import { type Integration, loadIntegrations, type ProviderInfo, type Target } from "./integrations";

/** One place an issue can go: a connection and a repo (GitHub) or team (Linear) in it. */
export interface Destination {
  integration: string;
  target: string;
  /** "GitHub · octo/repo", "Linear · Core (COR)". */
  label: string;
}

export class Issues {
  providers = $state<ProviderInfo[]>([]);
  integrations = $state<Integration[]>([]);
  /** The project's last destination (the server forgets it with its connection). */
  preferred = $state<{ integration: string; target: string } | null>(null);
  #destinations: Promise<Destination[]> | null = null;
  readonly projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  async load() {
    const [r, d] = await Promise.all([
      loadIntegrations(),
      api<{ default: Issues["preferred"] }>(`/projects/${this.projectId}/issue-target`),
    ]);
    this.providers = r.providers;
    this.integrations = r.integrations;
    this.preferred = d.default;
    this.#destinations = null;
  }

  get connected(): boolean {
    return this.integrations.length > 0;
  }

  nameOf(provider: string): string {
    return this.providers.find((p) => p.id === provider)?.name ?? provider;
  }

  /** Every place the person's connections can file into, fetched once. */
  destinations(): Promise<Destination[]> {
    this.#destinations ??= Promise.all(
      this.integrations.map(async (i) => {
        const { targets } = await api<{ targets: Target[] }>(`/integrations/${i.id}/targets`);
        return targets.map((t) => ({
          integration: i.id,
          target: t.id,
          label: `${this.nameOf(i.provider)} · ${t.name}`,
        }));
      }),
    ).then((lists) => lists.flat());
    this.#destinations.catch(() => (this.#destinations = null));
    return this.#destinations;
  }

  /**
   * Where the button files without asking: the project's last destination, or the only one
   * there is. Null when the person has to pick.
   */
  async default(): Promise<Destination | null> {
    const all = await this.destinations();
    const p = this.preferred;
    const last = p && all.find((d) => d.integration === p.integration && d.target === p.target);
    return last ?? (all.length === 1 ? (all[0] ?? null) : null);
  }

  /** Files the report's issue; the report comes back linked, and the destination is remembered. */
  async create(reportId: string, d: Destination): Promise<Report> {
    const report = await api<Report>(`/projects/${this.projectId}/reports/${reportId}/issue`, {
      method: "POST",
      body: { integration: d.integration, target: d.target },
    });
    this.preferred = { integration: d.integration, target: d.target };
    return report;
  }
}
