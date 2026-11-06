import { expect, test } from "bun:test";
import { createBrutal } from "./index";

/** A fake server: records what was posted, answers with the given statuses in turn. */
function fakeServer(statuses: (number | "network")[] = [201]) {
  const posted: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const status = statuses[Math.min(i++, statuses.length - 1)];
    if (status === "network") throw new TypeError("fetch failed");
    posted.push({
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    });
    return new Response(status < 300 ? '{"id":"rep_1"}' : "nope", { status });
  }) as typeof globalThis.fetch;
  return { fetch, posted };
}

const opts = (fetch: typeof globalThis.fetch) => ({
  endpoint: "https://brutal.test/",
  ingestKey: "brutal_ingest_x",
  fetch,
  context: () => ({ app_version: "1.4.0", environment: "test" }),
});

test("a report carries the recent tool calls without the agent naming them", async () => {
  const server = fakeServer();
  const brutal = createBrutal(opts(server.fetch));
  const convo = brutal.conversation("conv_1", { agent_name: "otto" });
  const search = convo.wrap("search_parts", async (q: { year: string }) => {
    if (q.year.includes("-")) throw new Error("year must be YYYY");
    return [];
  });
  await search({ year: "2024" });
  await expect(search({ year: "2024-25" })).rejects.toThrow("year must be YYYY");

  const ack = await convo.handle({
    kind: "friction",
    title: "Year filter rejects fiscal years",
    summary: "search_parts refused 2024-25.",
    tool_name: "search_parts",
  });
  expect(ack).toBe("Feedback recorded.");
  expect(server.posted).toHaveLength(1);
  const { url, auth, body } = server.posted[0];
  expect(url).toBe("https://brutal.test/v1/reports");
  expect(auth).toBe("Bearer brutal_ingest_x");
  const context = body.context as Record<string, unknown> & {
    recent_tool_calls: { name: string; status: string; error?: string }[];
  };
  expect(context).toMatchObject({
    conversation_id: "conv_1",
    agent_name: "otto",
    app_version: "1.4.0",
    sdk: "@brutal-ai/sdk",
  });
  expect(context.recent_tool_calls.map((c) => c.status)).toEqual(["ok", "error"]);
  expect(context.recent_tool_calls[1].error).toBe("year must be YYYY");
});

test("buffers are per conversation, capped, and clip large fields", async () => {
  const brutal = createBrutal({
    ...opts(fakeServer().fetch),
    maxRecentCalls: 3,
    maxFieldChars: 10,
  });
  const a = brutal.conversation("a");
  for (let i = 0; i < 5; i++) a.record({ name: `t${i}`, result: "x".repeat(50) });
  expect(a.recent().map((c) => c.name)).toEqual(["t2", "t3", "t4"]);
  expect(String(a.recent()[0].result)).toStartWith("xxxxxxxxxx…");
  expect(brutal.conversation("b").recent()).toEqual([]);
});

test("delivery never throws: network errors retry once, then give up quietly", async () => {
  const errors: unknown[] = [];
  const flaky = fakeServer(["network", 201]);
  const brutal = createBrutal({ ...opts(flaky.fetch), onError: (e) => errors.push(e) });
  expect(await brutal.report({ kind: "bug", title: "t", summary: "s" })).toBe(true);

  const down = fakeServer(["network"]);
  const dead = createBrutal({ ...opts(down.fetch), onError: (e) => errors.push(e) });
  expect(await dead.conversation("c").handle({ kind: "bug", title: "t", summary: "s" })).toBe(
    "Feedback recorded.",
  );
  expect(errors).toHaveLength(1);
});

test("a 4xx is not retried; a 5xx is, once", async () => {
  const bad = fakeServer([400, 201]);
  expect(
    await createBrutal(opts(bad.fetch)).report({ kind: "bug", title: "t", summary: "s" }),
  ).toBe(false);
  expect(bad.posted).toHaveLength(1);
  const busy = fakeServer([503, 201]);
  expect(
    await createBrutal(opts(busy.fetch)).report({ kind: "bug", title: "t", summary: "s" }),
  ).toBe(true);
  expect(busy.posted).toHaveLength(2);
});

test("redact can scrub or drop; a malformed call is still sent as other", async () => {
  const server = fakeServer();
  const brutal = createBrutal({
    ...opts(server.fetch),
    redact: (r) => (r.title.includes("drop") ? null : { ...r, summary: "[redacted]" }),
  });
  const convo = brutal.conversation("c");
  await convo.handle({ kind: "bug", title: "drop me", summary: "secret" });
  await convo.handle({ kind: "bug", title: "keep", summary: "secret" });
  await convo.handle({ nonsense: true });
  expect(server.posted.map((p) => [p.body.kind, p.body.summary])).toEqual([
    ["bug", "[redacted]"],
    ["other", "[redacted]"],
  ]);
});

test("tool formats", () => {
  const brutal = createBrutal(opts(fakeServer().fetch));
  const anthropic = brutal.anthropicTool();
  expect(anthropic.name).toBe("report_feedback");
  expect(Object.keys(anthropic)).toEqual(["name", "description", "input_schema"]);
  const ai = brutal.aiSdkTool("c");
  expect(typeof ai.execute).toBe("function");
});
