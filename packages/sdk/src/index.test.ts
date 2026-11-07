import { expect, test } from "bun:test";
import {
  AgentInput,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_NOT_RECORDED,
  toolDefinition,
} from "@brutal-ai/schema";
import { createBrutal, type Json } from "./index";

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
  expect(ack).toBe("Feedback recorded (rep_1). Carry on with the user's task.");
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
    TOOL_NOT_RECORDED,
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

test("anthropic and AI SDK formats", () => {
  const brutal = createBrutal(opts(fakeServer().fetch));
  const anthropic = brutal.anthropicTool();
  expect(anthropic.name).toBe("report_feedback");
  expect(Object.keys(anthropic)).toEqual(["name", "description", "input_schema"]);
  const ai = brutal.aiSdkTool("c");
  expect(Object.keys(ai)).toEqual(["description", "inputSchema", "execute"]);
  expect(ai.description).toBe(TOOL_DESCRIPTION);
  expect(ai.inputSchema).toBe(AgentInput);
});

test("OpenAI formats: a function tool, nested for Chat Completions, flat for Responses", () => {
  const brutal = createBrutal(opts(fakeServer().fetch));
  const { input_schema } = toolDefinition();
  const { $schema, ...bare } = input_schema as { [key: string]: Json };
  expect($schema).toBeString();

  const chat = brutal.openaiTool();
  expect(Object.keys(chat)).toEqual(["type", "function"]);
  expect(chat.type).toBe("function");
  expect(chat.function).toEqual({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: bare,
    strict: false,
  });

  const responses = brutal.openaiResponsesTool();
  expect(responses).toEqual({
    type: "function",
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: bare,
    strict: false,
  });
  // Strict mode would need every property required; this schema has optional ones, so it is off.
  const params = responses.parameters as { properties: object; required: string[] };
  expect(params.required.length).toBeLessThan(Object.keys(params.properties).length);
});

test("Bedrock Converse format: toolSpec with the schema under inputSchema.json", () => {
  const brutal = createBrutal(opts(fakeServer().fetch));
  const tool = brutal.bedrockTool();
  expect(Object.keys(tool)).toEqual(["toolSpec"]);
  expect(Object.keys(tool.toolSpec)).toEqual(["name", "description", "inputSchema"]);
  expect(tool.toolSpec.name).toBe(TOOL_NAME);
  expect(tool.toolSpec.description).toBe(TOOL_DESCRIPTION);
  expect(Object.keys(tool.toolSpec.inputSchema)).toEqual(["json"]);
  expect(tool.toolSpec.inputSchema.json).toMatchObject({
    type: "object",
    required: ["kind", "title", "summary"],
    additionalProperties: false,
  });
  expect(tool.toolSpec.inputSchema.json).not.toHaveProperty("$schema");
});

test("Mastra and LangChain formats: zod schema, canonical name and description", () => {
  const brutal = createBrutal(opts(fakeServer().fetch));
  const mastra = brutal.mastraTool("c");
  expect(Object.keys(mastra)).toEqual(["id", "description", "inputSchema", "execute"]);
  expect(mastra.id).toBe(TOOL_NAME);
  expect(mastra.description).toBe(TOOL_DESCRIPTION);
  expect(mastra.inputSchema).toBe(AgentInput);
  const langchain = brutal.langchainTool("c");
  expect(Object.keys(langchain)).toEqual(["name", "description", "schema", "func"]);
  expect(langchain.name).toBe(TOOL_NAME);
  expect(langchain.description).toBe(TOOL_DESCRIPTION);
  expect(langchain.schema).toBe(AgentInput);
});

test("every format's call reaches handle and the report carries the conversation", async () => {
  const server = fakeServer();
  const brutal = createBrutal(opts(server.fetch));
  const input = { kind: "bug", title: "t", summary: "s", tool_name: "search_parts" };
  const ack = "Feedback recorded (rep_1). Carry on with the user's task.";

  // OpenAI (both APIs) hands over the arguments as a JSON string.
  const openaiCall = { function: { name: TOOL_NAME, arguments: JSON.stringify(input) } };
  expect(openaiCall.function.name).toBe(brutal.openaiTool().function.name);
  expect(
    await brutal.conversation("openai").handle(JSON.parse(openaiCall.function.arguments)),
  ).toBe(ack);

  // Bedrock Converse: a toolUse block, answered with a toolResult.
  const toolUse = { toolUseId: "tooluse_1", name: TOOL_NAME, input };
  expect(toolUse.name).toBe(brutal.bedrockTool().toolSpec.name);
  const toolResult = {
    toolUseId: toolUse.toolUseId,
    content: [{ text: await brutal.conversation("bedrock").handle(toolUse.input) }],
  };
  expect(toolResult.content[0].text).toBe(ack);

  // The zod formats call execute/func with the parsed input (and options after it).
  expect(await brutal.aiSdkTool("ai").execute(input)).toBe(ack);
  expect(await brutal.mastraTool("mastra").execute(input)).toBe(ack);
  expect(await brutal.langchainTool("langchain").func(input)).toBe(ack);

  expect(
    server.posted.map((p) => (p.body.context as { conversation_id: string }).conversation_id),
  ).toEqual(["openai", "bedrock", "ai", "mastra", "langchain"]);
  for (const p of server.posted) expect(p.body).toMatchObject(input);
});
