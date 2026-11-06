/** Enough of Workers KV for the OAuth provider, from Tempra (cldixon/tempra, worker/test/harness.ts). */
export function memoryKV() {
  const data = new Map<string, { value: string; expires: number | null; metadata: unknown }>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.expires !== null && e.expires <= Date.now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const kv = {
    data,
    async get(key: string, opts?: string | { type?: string }) {
      const e = live(key);
      if (!e) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(e.value) : e.value;
    },
    async getWithMetadata(key: string, opts?: string | { type?: string }) {
      const value = await kv.get(key, opts);
      return { value, metadata: live(key)?.metadata ?? null };
    },
    async put(
      key: string,
      value: string,
      opts: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {},
    ) {
      const expires = opts.expirationTtl
        ? Date.now() + opts.expirationTtl * 1000
        : opts.expiration
          ? opts.expiration * 1000
          : null;
      data.set(key, { value: String(value), expires, metadata: opts.metadata ?? null });
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const names = [...data.keys()]
        .filter((k) => live(k) && k.startsWith(opts.prefix ?? ""))
        .sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return {
        keys: page.map((name) => ({ name, metadata: data.get(name)?.metadata ?? undefined })),
        list_complete: done,
        cursor: done ? undefined : String(start + limit),
      };
    },
  };
  return kv;
}
