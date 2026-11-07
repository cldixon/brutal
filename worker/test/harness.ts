import { Database } from "bun:sqlite";
import type { Deps } from "../src/app";
import { type ProjectReports, ReportStore, type Sql } from "../src/reports";
import { createWorker } from "../src/worker";
import { bunD1 } from "./d1";
import { memoryKV } from "./kv";

/** A SQLite handle over bun:sqlite, standing in for a Durable Object's storage. */
export function bunSql(db = new Database(":memory:")): Sql {
  return {
    all: <T>(sql: string, ...params: unknown[]) => db.query(sql).all(...(params as never[])) as T[],
    run: (sql: string, ...params: unknown[]) => {
      db.query(sql).run(...(params as never[]));
    },
  };
}

/** The app in process: D1 over bun:sqlite, one in-memory store per project, mail captured. */
export function harness(env: Record<string, unknown> = {}, deps: Partial<Deps> = {}) {
  const stores = new Map<string, ReportStore>();
  const mail: { to: string; subject: string; text: string }[] = [];
  const worker = createWorker({
    reports(_env, projectId): ProjectReports {
      let store = stores.get(projectId);
      if (!store) {
        store = new ReportStore(bunSql());
        stores.set(projectId, store);
      }
      const s = store;
      // As Durable Object RPC does: refuse arguments it couldn't serialize, such as an object with
      // no prototype (Hono's c.req.query()).
      const rpc = <T>(arg: T): T => {
        if (arg && typeof arg === "object" && Object.getPrototypeOf(arg) !== Object.prototype) {
          throw new Error("DataCloneError: not a plain object");
        }
        return arg;
      };
      return {
        insert: async (input, keyId) => s.insert(rpc(input), keyId),
        get: async (id) => s.get(id),
        list: async (filter) => s.list(rpc(filter)),
        update: async (id, update) => s.update(id, rpc(update)),
        delete: async (id) => s.delete(id),
        deleteConversation: async (conversationId) => s.deleteConversation(conversationId),
        retention: async () => s.retention(),
        setRetention: async (days) => s.setRetention(days),
      };
    },
    mailer: () => async (to, subject, text) => {
      mail.push({ to, subject, text });
    },
    // No real network in tests: a test that calls a provider passes its fake server.
    providerFetch: () => async (url) => {
      throw new Error(`No network in tests: ${url}`);
    },
    ...deps,
  });
  // Open sign-up unless a test says otherwise; production is invite-only.
  const bindings = {
    DB: bunD1(),
    OAUTH_KV: memoryKV(),
    SIGNUP: "open",
    APP_ORIGIN: "https://brutal.test",
    FEEDBACK_ORIGIN: "https://feedback.brutal.test",
    REVIEW_ORIGIN: "https://review.brutal.test",
    ...env,
  };
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  /** The whole Worker, OAuth provider included, with Hono's app.request shape. */
  const app = {
    request: (input: string | Request, init?: RequestInit, envOverride?: unknown) =>
      worker.fetch(
        input instanceof Request ? input : new Request(input, init),
        (envOverride ?? bindings) as never,
        ctx,
      ),
  };
  const origin = "https://brutal.test";

  /** A request as the web app makes it: same origin, JSON, the session cookie if given. */
  const call = (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      cookie?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(
      `${origin}${path}`,
      {
        method: init.method ?? "GET",
        headers: {
          origin,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      bindings,
    );

  /** Signs `email` in through the mailed code; returns the session cookie. */
  async function signIn(email: string): Promise<string> {
    const sent = await call("/api/sign-in", { method: "POST", body: { email } });
    if (sent.status !== 200) throw new Error(`sign-in: ${sent.status} ${await sent.text()}`);
    const code = mail.at(-1)?.text.match(/code is (\w+)/)?.[1] ?? "";
    const verified = await call("/api/sign-in/verify", { method: "POST", body: { email, code } });
    const cookie = verified.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("no session cookie");
    return cookie;
  }

  /** As an agent or script: a key, no cookie, no origin. */
  const keyed = (key: string, path: string, init: RequestInit = {}) =>
    app.request(
      `${origin}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...init.headers,
        },
      },
      bindings,
    );

  return { app, bindings, call, keyed, signIn, mail, stores };
}

/**
 * A stand-in for Cloudflare's Rate Limiting binding: `limit` calls per key, with no window (a test
 * runs well inside one). Pass it in harness's env as REPORT_KEY_LIMITER or
 * REPORT_CONVERSATION_LIMITER; without one there is no limit. `seen` records each key counted.
 */
export function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  const seen: string[] = [];
  return {
    seen,
    async limit({ key }: { key: string }) {
      seen.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}
