import { describe, expect, spyOn, test } from "bun:test";
import { TOOL_NOT_RECORDED } from "@brutal-ai/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fakeLimiter, harness } from "./harness";

const report = (conversation_id?: string) => ({
  kind: "bug",
  title: "search_parts errors",
  summary: "search_parts returned a 500 for a valid part number.",
  tool_name: "search_parts",
  ...(conversation_id ? { context: { conversation_id } } : {}),
});

async function setup(env: Record<string, unknown>) {
  const h = harness(env);
  const cookie = await h.signIn("owner@example.com");
  const project = (await (
    await h.call("/api/projects", { method: "POST", body: { name: "Otto" }, cookie })
  ).json()) as { id: string };
  const key = async (kind: string) =>
    (
      (await (
        await h.call(`/api/projects/${project.id}/keys`, {
          method: "POST",
          body: { kind, name: kind },
          cookie,
        })
      ).json()) as { secret: string }
    ).secret;
  const ingest = await key("ingest");
  const read = await key("read");
  const file = (body: unknown, k = ingest) =>
    h.keyed(k, "/v1/reports", { method: "POST", body: JSON.stringify(body) });
  const stored = async () =>
    ((await (await h.keyed(read, "/v1/reports")).json()) as { reports: unknown[] }).reports.length;
  const connect = async (k: string, at = "https://feedback.brutal.test") => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${at}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${k}` } },
        fetch: async (url, init) => h.app.request(new Request(url, init), undefined, h.bindings),
      }),
    );
    return client;
  };
  return { h, cookie, project, ingest, read, file, stored, connect };
}

describe("rate limits on filing", () => {
  test("HTTP: over the key's limit is a 429 with Retry-After, and nothing is stored", async () => {
    const keyLimiter = fakeLimiter(3);
    const s = await setup({ REPORT_KEY_LIMITER: keyLimiter });
    for (let i = 0; i < 3; i++) expect((await s.file(report())).status).toBe(201);
    const over = await s.file(report());
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBe("60");
    expect(await over.json()).toMatchObject({ limit: "key" });
    expect(await s.stored()).toBe(3);
    // Another key of the project has its own allowance.
    expect((await s.file(report(), s.read)).status).toBe(201);
  });

  test("HTTP: a looping conversation stores only its cap; other conversations go on", async () => {
    const conversations = fakeLimiter(5);
    const s = await setup({
      REPORT_KEY_LIMITER: fakeLimiter(1000),
      REPORT_CONVERSATION_LIMITER: conversations,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) statuses.push((await s.file(report("loop"))).status);
    expect(statuses.filter((x) => x === 201)).toHaveLength(5);
    expect(statuses.filter((x) => x === 429)).toHaveLength(45);
    expect((await s.file(report("other"))).status).toBe(201);
    // Without a conversation id only the key's limit applies.
    expect((await s.file(report())).status).toBe(201);
    expect(await s.stored()).toBe(7);
    expect(conversations.seen[0]).toBe(`${s.project.id}:loop`);
    const over = await s.file(report("loop"));
    expect(await over.json()).toMatchObject({ limit: "conversation" });
  });

  test("MCP: over the limit the tool still answers, says nothing was recorded, stores nothing", async () => {
    const s = await setup({ REPORT_KEY_LIMITER: fakeLimiter(2) });
    const agent = await s.connect(s.ingest);
    const call = () =>
      agent.callTool({ name: "report_feedback", arguments: report() }) as Promise<{
        isError?: boolean;
        content: { text: string }[];
      }>;
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await call());
    expect(answers.every((a) => !a.isError)).toBe(true);
    expect(
      answers.slice(0, 2).every((a) => a.content[0]?.text.startsWith("Feedback recorded")),
    ).toBe(true);
    expect(answers.slice(2).map((a) => a.content[0]?.text)).toEqual([
      TOOL_NOT_RECORDED,
      TOOL_NOT_RECORDED,
      TOOL_NOT_RECORDED,
    ]);
    expect(await s.stored()).toBe(2);
  });

  test("reads and triage are never limited", async () => {
    const keys = fakeLimiter(0);
    const conversations = fakeLimiter(0);
    const s = await setup({ REPORT_KEY_LIMITER: keys, REPORT_CONVERSATION_LIMITER: conversations });
    for (let i = 0; i < 5; i++) {
      expect((await s.h.keyed(s.read, "/v1/reports")).status).toBe(200);
      expect((await s.h.keyed(s.read, "/v1/reports/rep_x")).status).toBe(404);
      expect(
        (await s.h.call(`/api/projects/${s.project.id}/reports`, { cookie: s.cookie })).status,
      ).toBe(200);
    }
    const dev = await s.connect(s.read, "https://review.brutal.test");
    for (let i = 0; i < 5; i++) {
      const listed = await dev.callTool({ name: "list_reports", arguments: {} });
      expect(listed.isError).toBeFalsy();
    }
    expect(keys.seen).toEqual([]);
    expect(conversations.seen).toEqual([]);
  });

  test("an invalid report counts against nothing", async () => {
    const keys = fakeLimiter(1);
    const s = await setup({ REPORT_KEY_LIMITER: keys });
    expect((await s.file({ kind: "nope" })).status).toBe(400);
    expect(keys.seen).toEqual([]);
    expect((await s.file(report())).status).toBe(201);
  });

  test("a limiter that fails lets the report through", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const s = await setup({
      REPORT_KEY_LIMITER: {
        limit: async () => {
          throw new Error("down");
        },
      },
    });
    expect((await s.file(report())).status).toBe(201);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
