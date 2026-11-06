import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { harness } from "./harness";

const report = {
  kind: "friction",
  title: "Year filter rejects 2024-25",
  summary: "search_parts rejected a fiscal-year range the user typed.",
  tool_name: "search_parts",
  impact: "worked_around",
  context: {
    conversation_id: "conv_1",
    recent_tool_calls: [{ name: "search_parts", args: { year: "2024-25" }, status: "error" }],
  },
};

/** A signed-in person with a project and both kinds of key. */
async function owner(h: ReturnType<typeof harness>, email = "owner@example.com") {
  const cookie = await h.signIn(email);
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
  return { cookie, project, ingest: await key("ingest"), read: await key("read") };
}

describe("sign-in", () => {
  test("a mailed code signs in, and sign-out ends the session", async () => {
    const h = harness();
    const cookie = await h.signIn("Owner@Example.com");
    expect(h.mail[0]?.to).toBe("owner@example.com");
    const me = await h.call("/api/me", { cookie });
    expect(await me.json()).toEqual({ email: "owner@example.com" });
    await h.call("/api/sign-out", { method: "POST", cookie });
    expect((await h.call("/api/me", { cookie })).status).toBe(401);
  });

  test("a wrong code counts; five wrong tries use the code up", async () => {
    const h = harness();
    await h.call("/api/sign-in", { method: "POST", body: { email: "a@example.com" } });
    const code = h.mail[0]?.text.match(/code is (\w+)/)?.[1] ?? "";
    const verify = (c: string) =>
      h.call("/api/sign-in/verify", { method: "POST", body: { email: "a@example.com", code: c } });
    for (let i = 0; i < 5; i++) {
      expect(((await (await verify("WRONG000")).json()) as { error: string }).error).toContain(
        "isn't right",
      );
    }
    const late = (await (await verify(code)).json()) as { error: string };
    expect(late.error).toContain("expired");
  });

  test("a code works for its own email only, and once", async () => {
    const h = harness();
    await h.call("/api/sign-in", { method: "POST", body: { email: "a@example.com" } });
    const code = h.mail[0]?.text.match(/code is (\w+)/)?.[1] ?? "";
    const other = await h.call("/api/sign-in/verify", {
      method: "POST",
      body: { email: "b@example.com", code },
    });
    expect(other.status).toBe(400);
    const lower = code.toLowerCase();
    const ok = await h.call("/api/sign-in/verify", {
      method: "POST",
      body: { email: "a@example.com", code: lower },
    });
    expect(ok.status).toBe(200);
    const again = await h.call("/api/sign-in/verify", {
      method: "POST",
      body: { email: "a@example.com", code },
    });
    expect(again.status).toBe(400);
  });

  test("asking again too soon, an invite list, and no mail are refused", async () => {
    const h = harness({ SIGNUP_ALLOW: "in@example.com" });
    const ask = (email: string) => h.call("/api/sign-in", { method: "POST", body: { email } });
    expect((await ask("out@example.com")).status).toBe(403);
    expect((await ask("in@example.com")).status).toBe(200);
    expect((await ask("in@example.com")).status).toBe(429);
    expect((await ask("not an email")).status).toBe(400);
  });

  test("local dev shows the code; a deployment with no mail says so", async () => {
    const { createApp } = await import("../src/app");
    const { bunD1 } = await import("./d1");
    const dev = createApp({ mailer: () => null });
    const post = (url: string, env: object) =>
      dev.request(
        url,
        {
          method: "POST",
          headers: { origin: new URL(url).origin, "content-type": "application/json" },
          body: JSON.stringify({ email: "a@example.com" }),
        },
        { DB: bunD1(), ...env },
      );
    const local = await post("http://localhost/api/sign-in", { DEV_SIGNIN: "1" });
    expect(((await local.json()) as { code?: string }).code).toHaveLength(8);
    expect((await post("https://brutal.test/api/sign-in", { DEV_SIGNIN: "1" })).status).toBe(503);
  });

  test("state-changing calls from elsewhere are refused", async () => {
    const h = harness();
    const res = await h.call("/api/sign-in", {
      method: "POST",
      body: { email: "a@example.com" },
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("projects and keys", () => {
  test("an owner's projects; a stranger gets 404 for all of it", async () => {
    const h = harness();
    const a = await owner(h);
    const list = (await (await h.call("/api/projects", { cookie: a.cookie })).json()) as {
      projects: { id: string }[];
    };
    expect(list.projects.map((p) => p.id)).toEqual([a.project.id]);

    const stranger = await h.signIn("stranger@example.com");
    for (const path of [`/api/projects/${a.project.id}`, `/api/projects/${a.project.id}/reports`]) {
      expect((await h.call(path, { cookie: stranger })).status).toBe(404);
    }
    const mine = (await (await h.call("/api/projects", { cookie: stranger })).json()) as {
      projects: unknown[];
    };
    expect(mine.projects).toEqual([]);
  });

  test("signed out, the API asks to sign in", async () => {
    const h = harness();
    expect((await h.call("/api/projects")).status).toBe(401);
  });

  test("a revoked key stops working", async () => {
    const h = harness();
    const a = await owner(h);
    const keys = (await (
      await h.call(`/api/projects/${a.project.id}`, { cookie: a.cookie })
    ).json()) as {
      keys: { id: string; kind: string }[];
    };
    expect(keys.keys.map((k) => k.kind)).toEqual(["ingest", "read"]);
    const ingest = keys.keys.find((k) => k.kind === "ingest");
    await h.call(`/api/projects/${a.project.id}/keys/${ingest?.id}`, {
      method: "DELETE",
      cookie: a.cookie,
    });
    const res = await h.keyed(a.ingest, "/v1/reports", {
      method: "POST",
      body: JSON.stringify(report),
    });
    expect(res.status).toBe(401);
  });
});

describe("reports", () => {
  test("a report lands in its key's project only, and its owner sees it", async () => {
    const h = harness();
    const a = await owner(h);
    const b = await owner(h, "other@example.com");
    const posted = await h.keyed(a.ingest, "/v1/reports", {
      method: "POST",
      body: JSON.stringify(report),
    });
    expect(posted.status).toBe(201);
    const { id } = (await posted.json()) as { id: string };

    const viaKey = (await (await h.keyed(a.read, "/v1/reports")).json()) as {
      reports: { id: string }[];
    };
    expect(viaKey.reports.map((r) => r.id)).toEqual([id]);
    const otherProject = (await (await h.keyed(b.read, "/v1/reports")).json()) as {
      reports: unknown[];
    };
    expect(otherProject.reports).toEqual([]);
    expect((await h.keyed(b.read, `/v1/reports/${id}`)).status).toBe(404);

    const viaSession = (await (
      await h.call(`/api/projects/${a.project.id}/reports/${id}`, { cookie: a.cookie })
    ).json()) as { context: { recent_tool_calls: unknown[] } };
    expect(viaSession.context.recent_tool_calls).toHaveLength(1);

    const triaged = await h.call(`/api/projects/${a.project.id}/reports/${id}`, {
      method: "PATCH",
      body: { status: "triaged", issue_url: "https://github.com/o/r/issues/1" },
      cookie: a.cookie,
    });
    expect(((await triaged.json()) as { status: string }).status).toBe("triaged");
  });

  test("keys are scoped by kind, and reports are validated", async () => {
    const h = harness();
    const a = await owner(h);
    expect((await h.keyed(a.ingest, "/v1/reports")).status).toBe(403);
    expect((await h.keyed("brutal_read_nope", "/v1/reports")).status).toBe(401);
    const bad = await h.keyed(a.ingest, "/v1/reports", {
      method: "POST",
      body: JSON.stringify({ kind: "nope" }),
    });
    expect(bad.status).toBe(400);
    const js = await h.call(`/api/projects/${a.project.id}/reports/x`, {
      method: "PATCH",
      body: { issue_url: "javascript:alert(1)" },
      cookie: a.cookie,
    });
    expect(js.status).toBe(400);
  });

  test("the tool definition is public", async () => {
    const h = harness();
    const tool = (await (await h.call("/v1/schema/tool")).json()) as { name: string };
    expect(tool.name).toBe("report_feedback");
  });
});

describe("MCP", () => {
  test("an agent files with the ingest key; a coding agent triages with the read key", async () => {
    const h = harness();
    const a = await owner(h);
    const connect = async (key: string) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("https://brutal.test/mcp"), {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
          fetch: async (url, init) => h.app.request(new Request(url, init), undefined, h.bindings),
        }),
      );
      return client;
    };
    const agent = await connect(a.ingest);
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["report_feedback"]);
    await agent.callTool({
      name: "report_feedback",
      arguments: { kind: "eval_candidate", title: "Hard lookup", summary: "Worth an eval." },
    });
    const dev = await connect(a.read);
    const listed = await dev.callTool({ name: "list_reports", arguments: {} });
    const { reports } = JSON.parse((listed.content as { text: string }[])[0]?.text ?? "{}");
    expect(reports.map((r: { title: string }) => r.title)).toEqual(["Hard lookup"]);
  });
});
