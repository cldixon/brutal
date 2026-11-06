import { mock } from "bun:test";

// cloudflare:workers exists only in workerd; the OAuth provider and the entry import it.
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
// As in cloudflare.config.ts: the OAuth library enables client metadata documents (CIMD) only
// under global_fetch_strictly_public.
Object.assign(globalThis, {
  Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } },
});
