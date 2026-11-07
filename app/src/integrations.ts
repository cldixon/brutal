/** The person's GitHub and Linear connections (the Worker's src/integrations.ts). */
import { api } from "./api";

export interface ProviderInfo {
  id: "github" | "linear";
  name: string;
  available: boolean;
  install_url: string | null;
}
export interface Integration {
  id: string;
  provider: ProviderInfo["id"];
  account: string;
  created_at: string;
}
export interface Target {
  id: string;
  name: string;
}

export const loadIntegrations = () =>
  api<{ providers: ProviderInfo[]; integrations: Integration[] }>("/integrations");

/** Starts connecting: a full page load to the Worker, which sends the browser to the provider. */
export const connectUrl = (provider: string, back = location.pathname) =>
  `/api/integrations/${provider}/connect?return=${encodeURIComponent(back)}`;
