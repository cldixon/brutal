import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app";
import { bunD1 } from "./d1";

const claimWith = (code: string): RequestInit => ({
  method: "POST",
  body: new URLSearchParams({ code }),
});

async function setup() {
  const app = createApp();
  const env = { DB: bunD1(), SETUP_CODE: "s3cret" };
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`http://localhost${path}`, init, env);
  const res = await call("/setup", claimWith("s3cret"));
  const page = await res.text();
  const [ingest] = page.match(/brutal_ingest_[\w-]+/) ?? [];
  const [read] = page.match(/brutal_read_[\w-]+/) ?? [];
  if (!ingest || !read) throw new Error("setup did not show keys");
  const as = (key: string, path: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } });
  return { app, env, call, as, ingest, read };
}

const report = {
  kind: "friction",
  title: "Year filter rejects 2024-25",
  summary: "search_parts rejected a fiscal-year range the user typed.",
  tool_name: "search_parts",
  impact: "worked_around",
  context: {
    conversation_id: "conv_1",
    app_version: "1.2.3",
    recent_tool_calls: [
      { name: "search_parts", args: { year: "2024-25" }, status: "error", error: "bad year" },
    ],
  },
};

describe("HTTP API", () => {
  test("setup runs once", async () => {
    const { call } = await setup();
    expect((await call("/setup", claimWith("s3cret"))).status).toBe(409);
  });

  test("setup needs the code; without a secret one is generated and logged", async () => {
    const app = createApp();
    const env = { DB: bunD1() };
    const call = (path: string, init: RequestInit = {}) =>
      app.request(`http://localhost${path}`, init, env);
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: string) => logged.push(line);
    try {
      expect((await call("/setup")).status).toBe(200);
    } finally {
      console.log = log;
    }
    const code = logged.join("\n").match(/Setup code: (\w+)/)?.[1];
    expect(code).toBeDefined();
    expect((await call("/setup", claimWith("wrong"))).status).toBe(403);
    const claimed = await call("/setup", claimWith(code ?? ""));
    expect(claimed.status).toBe(200);
    expect(await claimed.text()).toContain("brutal_read_");
    // The code is used up, and the page says so.
    expect((await call("/setup", claimWith(code ?? ""))).status).toBe(409);
    expect(await (await call("/setup")).text()).toContain("already set up");
  });

  test("an ingested report shows up in the list and in full", async () => {
    const { as, ingest, read } = await setup();
    const posted = await as(ingest, "/v1/reports", {
      method: "POST",
      body: JSON.stringify(report),
      headers: { "content-type": "application/json" },
    });
    expect(posted.status).toBe(201);
    const { id } = (await posted.json()) as { id: string };

    const list = (await (await as(read, "/v1/reports?kind=friction")).json()) as {
      reports: { id: string; status: string }[];
    };
    expect(list.reports.map((r) => r.id)).toEqual([id]);
    expect(list.reports[0].status).toBe("new");
    const none = (await (await as(read, "/v1/reports?kind=bug")).json()) as { reports: [] };
    expect(none.reports).toHaveLength(0);

    const full = (await (await as(read, `/v1/reports/${id}`)).json()) as {
      context: { recent_tool_calls: unknown[] };
    };
    expect(full.context.recent_tool_calls).toHaveLength(1);
  });

  test("keys are scoped", async () => {
    const { as, call, ingest } = await setup();
    expect((await call("/v1/reports")).status).toBe(401);
    expect((await as(ingest, "/v1/reports")).status).toBe(403);
    expect((await as("brutal_read_nope", "/v1/reports")).status).toBe(401);
  });

  test("invalid reports are refused with the issues", async () => {
    const { as, ingest } = await setup();
    const res = await as(ingest, "/v1/reports", {
      method: "POST",
      body: JSON.stringify({ kind: "nope", title: "" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  test("triage: status and issue link", async () => {
    const { as, ingest, read } = await setup();
    const { id } = (await (
      await as(ingest, "/v1/reports", { method: "POST", body: JSON.stringify(report) })
    ).json()) as { id: string };
    const patched = await as(read, `/v1/reports/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "linked", issue_url: "https://github.com/o/r/issues/1" }),
    });
    expect(((await patched.json()) as { status: string }).status).toBe("linked");
    const bad = await as(read, `/v1/reports/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ issue_url: "javascript:alert(1)" }),
    });
    expect(bad.status).toBe(400);
  });

  test("pages with a cursor, newest first", async () => {
    const { as, ingest, read } = await setup();
    for (let i = 0; i < 3; i++) {
      await as(ingest, "/v1/reports", {
        method: "POST",
        body: JSON.stringify({ ...report, title: `r${i}` }),
      });
    }
    type Page = { reports: { title: string }[]; next: string | null };
    const first = (await (await as(read, "/v1/reports?limit=2")).json()) as Page;
    expect(first.reports.map((r) => r.title)).toEqual(["r2", "r1"]);
    const second = (await (
      await as(read, `/v1/reports?limit=2&before=${first.next}`)
    ).json()) as Page;
    expect(second.reports.map((r) => r.title)).toEqual(["r0"]);
    expect(second.next).toBeNull();
  });

  test("the tool definition is public", async () => {
    const { call } = await setup();
    const tool = (await (await call("/v1/schema/tool")).json()) as {
      name: string;
      input_schema: { required: string[] };
    };
    expect(tool.name).toBe("report_feedback");
    expect(tool.input_schema.required).toEqual(["kind", "title", "summary"]);
  });

  test("the dashboard takes the read key over Basic auth and escapes reports", async () => {
    const { as, call, ingest, read } = await setup();
    expect((await call("/")).status).toBe(401);
    await as(ingest, "/v1/reports", {
      method: "POST",
      body: JSON.stringify({ ...report, title: "<script>x</script>" }),
    });
    const page = await call("/", { headers: { authorization: `Basic ${btoa(`me:${read}`)}` } });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(text).not.toContain("<script>x");
  });
});

describe("MCP", () => {
  async function connect(key: string, s: Awaited<ReturnType<typeof setup>>) {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: async (url, init) => s.app.request(new Request(url, init), undefined, s.env),
    });
    await client.connect(transport);
    return client;
  }

  test("an agent files a report; a coding agent finds and triages it", async () => {
    const s = await setup();
    const agent = await connect(s.ingest, s);
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["report_feedback"]);
    const ack = await agent.callTool({
      name: "report_feedback",
      arguments: {
        kind: "eval_candidate",
        title: "Hard multi-part lookup",
        summary: "Worth an eval.",
      },
    });
    expect(ack.content).toEqual([{ type: "text", text: "Feedback recorded." }]);

    const dev = await connect(s.read, s);
    const names = (await dev.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_eval_candidates", "get_report", "list_reports", "update_report"]);
    const listed = await dev.callTool({ name: "list_reports", arguments: {} });
    const { reports } = JSON.parse((listed.content as { text: string }[])[0].text);
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toBe("Hard multi-part lookup");

    const updated = await dev.callTool({
      name: "update_report",
      arguments: { id: reports[0].id, status: "triaged" },
    });
    expect(JSON.parse((updated.content as { text: string }[])[0].text).status).toBe("triaged");
  });
});
