import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrated } from "../src/accounts";
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

  test("asking again too soon and a malformed email are refused", async () => {
    const h = harness();
    const ask = (email: string) => h.call("/api/sign-in", { method: "POST", body: { email } });
    expect((await ask("a@example.com")).status).toBe(200);
    expect((await ask("a@example.com")).status).toBe(429);
    expect((await ask("not an email")).status).toBe(400);
  });

  test("invite-only: invited, existing and the operator get codes; anyone else the waitlist", async () => {
    const h = harness({ SIGNUP: "invite", OPERATOR_EMAIL: "op@example.com" });
    const ask = (email: string) => h.call("/api/sign-in", { method: "POST", body: { email } });
    const db = await migrated(h.bindings.DB);
    await db
      .prepare("INSERT INTO invites (email, created_at) VALUES (?, ?)")
      .bind("in@example.com", "x")
      .run();

    // Same answer for everyone; only the invited and the operator are mailed a code.
    for (const email of ["in@example.com", "op@example.com", "new@example.com"]) {
      expect(await (await ask(email)).json()).toEqual({ sent: true });
    }
    const codes = h.mail.filter((m) => m.subject.includes("sign-in code")).map((m) => m.to);
    expect(codes).toEqual(["in@example.com", "op@example.com"]);
    expect(h.mail.map((m) => [m.to, m.subject])).toContainEqual([
      "new@example.com",
      "You're on the Brutal waitlist",
    ]);
    expect(h.mail.map((m) => m.subject)).toContain("Brutal waitlist: new@example.com");
    const waiting = await db.prepare("SELECT email FROM waitlist").all<{ email: string }>();
    expect(waiting.results.map((r) => r.email)).toEqual(["new@example.com"]);

    // Asking again doesn't mail the waitlist note twice.
    await ask("new@example.com");
    expect(h.mail.filter((m) => m.to === "new@example.com")).toHaveLength(1);

    // The invited person signs in, and keeps their account if the invite is withdrawn.
    const cookie = await h.signIn("in@example.com").catch(() => "");
    expect(cookie).toBe("");
  });

  test("invite-only: a withdrawn invite stops a code already sent", async () => {
    const h = harness({ SIGNUP: "invite" });
    const db = await migrated(h.bindings.DB);
    await db
      .prepare("INSERT INTO invites (email, created_at) VALUES (?, ?)")
      .bind("in@example.com", "x")
      .run();
    await h.call("/api/sign-in", { method: "POST", body: { email: "in@example.com" } });
    const code = h.mail.at(-1)?.text.match(/code is (\w+)/)?.[1] ?? "";
    await db.prepare("DELETE FROM invites WHERE email = ?").bind("in@example.com").run();
    const res = await h.call("/api/sign-in/verify", {
      method: "POST",
      body: { email: "in@example.com", code },
    });
    expect(res.status).toBe(400);
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
        { DB: bunD1(), SIGNUP: "open", ...env },
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

describe("deletion and retention", () => {
  const file = async (h: ReturnType<typeof harness>, key: string, conversation_id: string) => {
    const res = await h.keyed(key, "/v1/reports", {
      method: "POST",
      body: JSON.stringify({ ...report, context: { conversation_id } }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  test("a read key deletes by id or conversation; an ingest key and other projects can't", async () => {
    const h = harness();
    const a = await owner(h);
    const b = await owner(h, "other@example.com");
    const one = await file(h, a.ingest, "c1");
    await file(h, a.ingest, "c2");
    await file(h, a.ingest, "c2");

    expect((await h.keyed(a.ingest, `/v1/reports/${one}`, { method: "DELETE" })).status).toBe(403);
    expect(
      (await h.keyed(a.ingest, "/v1/reports?conversation_id=c2", { method: "DELETE" })).status,
    ).toBe(403);
    // Another project's key finds nothing to delete.
    expect((await h.keyed(b.read, `/v1/reports/${one}`, { method: "DELETE" })).status).toBe(404);
    const elsewhere = await h.keyed(b.read, "/v1/reports?conversation_id=c2", { method: "DELETE" });
    expect(await elsewhere.json()).toEqual({ deleted: 0 });

    const gone = await h.keyed(a.read, `/v1/reports/${one}`, { method: "DELETE" });
    expect(await gone.json()).toEqual({ deleted: 1 });
    expect((await h.keyed(a.read, `/v1/reports/${one}`)).status).toBe(404);
    expect((await h.keyed(a.read, `/v1/reports/${one}`, { method: "DELETE" })).status).toBe(404);
    expect((await h.keyed(a.read, "/v1/reports", { method: "DELETE" })).status).toBe(400);
    const conv = await h.keyed(a.read, "/v1/reports?conversation_id=c2", { method: "DELETE" });
    expect(await conv.json()).toEqual({ deleted: 2 });
    const left = (await (await h.keyed(a.read, "/v1/reports")).json()) as { reports: unknown[] };
    expect(left.reports).toEqual([]);
  });

  test("the owner deletes and sets retention in the app; a stranger gets 404", async () => {
    const h = harness();
    const a = await owner(h);
    const one = await file(h, a.ingest, "c1");
    await file(h, a.ingest, "c2");
    const base = `/api/projects/${a.project.id}`;
    const stranger = await h.signIn("stranger@example.com");

    for (const [path, method, body] of [
      [`${base}/reports/${one}`, "DELETE", undefined],
      [`${base}/reports?conversation_id=c2`, "DELETE", undefined],
      [`${base}/retention`, "GET", undefined],
      [`${base}/retention`, "PUT", { days: 30 }],
    ] as const) {
      expect((await h.call(path, { method, body, cookie: stranger })).status).toBe(404);
    }
    expect((await h.call(`${base}/reports/${one}`, { method: "DELETE" })).status).toBe(401);

    const del = await h.call(`${base}/reports/${one}`, { method: "DELETE", cookie: a.cookie });
    expect(await del.json()).toEqual({ deleted: 1 });
    const conv = await h.call(`${base}/reports?conversation_id=c2`, {
      method: "DELETE",
      cookie: a.cookie,
    });
    expect(await conv.json()).toEqual({ deleted: 1 });

    const get = async () =>
      (await (await h.call(`${base}/retention`, { cookie: a.cookie })).json()) as {
        days: number | null;
      };
    expect(await get()).toEqual({ days: null });
    const put = (body: unknown) =>
      h.call(`${base}/retention`, { method: "PUT", body, cookie: a.cookie });
    expect((await put({ days: 90 })).status).toBe(200);
    expect(await get()).toEqual({ days: 90 });
    for (const bad of [{ days: 0 }, { days: 3651 }, { days: 1.5 }, { days: "90" }, {}]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect(await get()).toEqual({ days: 90 });
    expect((await put({ days: null })).status).toBe(200);
    expect(await get()).toEqual({ days: null });
  });
});

describe("MCP", () => {
  test("an agent files with the ingest key; a coding agent triages with the read key", async () => {
    const h = harness();
    const a = await owner(h);
    const connect = async (key: string, at = "https://feedback.brutal.test") => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${at}/mcp`), {
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
      arguments: { kind: "missing_capability", title: "Hard lookup", summary: "No search." },
    });
    const dev = await connect(a.read, "https://review.brutal.test");
    const listed = await dev.callTool({ name: "list_reports", arguments: {} });
    const { reports } = JSON.parse((listed.content as { text: string }[])[0]?.text ?? "{}");
    expect(reports.map((r: { title: string }) => r.title)).toEqual(["Hard lookup"]);
  });

  test("delete_report is on the review server only, by id or conversation", async () => {
    const h = harness();
    const a = await owner(h);
    const connect = async (key: string, at: string) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${at}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
          fetch: async (url, init) => h.app.request(new Request(url, init), undefined, h.bindings),
        }),
      );
      return client;
    };
    for (const key of [a.ingest, a.read]) {
      const feedback = await connect(key, "https://feedback.brutal.test");
      expect((await feedback.listTools()).tools.map((t) => t.name)).not.toContain("delete_report");
    }
    const ids: string[] = [];
    for (const conversation_id of ["c1", "c2", "c2"]) {
      const res = await h.keyed(a.ingest, "/v1/reports", {
        method: "POST",
        body: JSON.stringify({ ...report, context: { conversation_id } }),
      });
      ids.push(((await res.json()) as { id: string }).id);
    }
    const dev = await connect(a.read, "https://review.brutal.test");
    const tool = (await dev.listTools()).tools.find((t) => t.name === "delete_report");
    expect(tool?.description).toContain("permanently");
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
    const call = (args: Record<string, unknown>) =>
      dev.callTool({ name: "delete_report", arguments: args });

    expect((await call({})).isError).toBe(true);
    expect((await call({ id: ids[0], conversation_id: "c2" })).isError).toBe(true);
    expect(JSON.parse(text(await call({ id: ids[0] })))).toEqual({ deleted: 1 });
    expect((await call({ id: ids[0] })).isError).toBe(true);
    expect(JSON.parse(text(await call({ conversation_id: "c2" })))).toEqual({ deleted: 2 });
    const listed = await dev.callTool({ name: "list_reports", arguments: {} });
    expect(JSON.parse(text(listed)).reports).toEqual([]);
  });
});

test("reports filed as eval_candidate before it was dropped read back as other", async () => {
  const { Database } = await import("bun:sqlite");
  const { ReportStore } = await import("../src/reports");
  const { bunSql } = await import("./harness");
  const db = new Database(":memory:");
  const sql = bunSql(db);
  // A store at the first schema version, with a report of the old kind.
  new ReportStore(sql);
  sql.run("UPDATE _schema SET version = 1");
  sql.run(
    "INSERT INTO reports (id, kind, title, summary, created_at, updated_at) VALUES ('rep_1', 'eval_candidate', 't', 's', 'x', 'x')",
  );
  expect(new ReportStore(sql).get("rep_1")?.kind).toBe("other");
});
