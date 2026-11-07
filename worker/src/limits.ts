import type { Key } from "./accounts";

/**
 * Rate limits on filing reports (issue #10): a looping agent must not fill a project, or cost
 * everyone else, with copies of one report. Two of Cloudflare's Rate Limiting bindings
 * (worker/cloudflare.config.ts), checked before a report is stored, on `POST /v1/reports` and the
 * feedback server's `report_feedback` alone; reading and triage are never limited. Without a
 * binding (tests that don't pass one) there is no limit.
 */

/** Cloudflare's Rate Limiting binding, as far as this module uses it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Both limits count per minute (the binding allows 10 or 60 seconds). */
export const LIMIT_PERIOD = 60;

/**
 * Reports a minute per key or OAuth connection. An agent reports a problem once and carries on,
 * so one conversation files a handful at most; 30 leaves room for several agents sharing a key
 * (a test run, a few users of one product) while a loop is stopped within a minute.
 */
export const REPORTS_PER_KEY = 30;

/**
 * Reports a minute per conversation (`context.conversation_id`, HTTP only: MCP reports carry
 * none). One turn rarely meets more than one or two broken tools; more than 5 a minute from one
 * conversation is a loop, not five problems.
 */
export const REPORTS_PER_CONVERSATION = 5;

/** The bindings, by name in cloudflare.config.ts. */
export interface LimiterBindings {
  /** REPORTS_PER_KEY a minute, keyed by the key's id (`grant:<id>` for a connection). */
  REPORT_KEY_LIMITER?: RateLimiter;
  /** REPORTS_PER_CONVERSATION a minute, keyed by `<project id>:<conversation id>`. */
  REPORT_CONVERSATION_LIMITER?: RateLimiter;
}

/** Which limit a report went over, and when to try again (seconds). */
export interface OverLimit {
  limit: "key" | "conversation";
  retryAfter: number;
}

/**
 * Counts one report against the limits that apply to it; null when it may be stored. The
 * conversation is checked first, so a looping conversation that is already stopped doesn't
 * keep spending its key's allowance, which other conversations share. A limiter that fails
 * lets the report through: losing a limit for a moment is better than losing feedback.
 */
export async function overFilingLimit(
  env: LimiterBindings,
  key: Key,
  conversationId?: string,
): Promise<OverLimit | null> {
  const checks: [OverLimit["limit"], RateLimiter | undefined, string | undefined][] = [
    [
      "conversation",
      env.REPORT_CONVERSATION_LIMITER,
      conversationId ? `${key.project_id}:${conversationId}` : undefined,
    ],
    ["key", env.REPORT_KEY_LIMITER, key.id],
  ];
  for (const [limit, limiter, id] of checks) {
    if (!limiter || !id) continue;
    try {
      const { success } = await limiter.limit({ key: id });
      if (!success) return { limit, retryAfter: LIMIT_PERIOD };
    } catch (error) {
      console.error(`rate limiter (${limit}) failed`, error);
    }
  }
  return null;
}
