import type { Report } from "@brutal-ai/schema";
import { navigate } from "./router.svelte";

export type { Report };
export interface Project {
  id: string;
  name: string;
  created_at: string;
}
export interface KeyInfo {
  id: string;
  kind: "ingest" | "read";
  name: string;
  created_at: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Calls the Worker's /api. Signed out on a page that needs it: off to sign in. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && !path.startsWith("/sign-in") && path !== "/me") {
    navigate(`/sign-in?next=${encodeURIComponent(location.pathname)}`, true);
  }
  if (!res.ok)
    throw new ApiError(data.error ?? `Something went wrong (${res.status}).`, res.status);
  return data as T;
}

export const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
