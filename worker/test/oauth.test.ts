import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { harness } from "./harness";

/** The connector flow as claude.ai drives it (after Tempra's worker/test/oauth-flow.ts). */
const ORIGIN = "https://brutal.test";
const REVIEW = "https://review.brutal.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

type H = ReturnType<typeof harness>;
const req = (h: H, path: string, init: RequestInit = {}) =>
  h.app.request(new Request(new URL(path, ORIGIN), init));

async function register(h: H, at = ORIGIN) {
  const r = await req(h, `${at}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Starts an authorization as the signed-in person: the consent page, its handle, PKCE. */
async function begin(h: H, clientId: string, cookie: string, at = ORIGIN) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "st4te",
    code_challenge: b64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    resource: `${at}/mcp`,
  });
  const url = `${at}/authorize?${query}`;
  const page = await req(h, url, { headers: { cookie } });
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const consentCookies = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { page, html, handle, cookies: `${cookie}; ${consentCookies}`, url, verifier };
}

async function approve(
  h: H,
  flow: Awaited<ReturnType<typeof begin>>,
  fields: Record<string, string>,
) {
  return req(h, flow.url, {
    method: "POST",
    headers: { cookie: flow.cookies, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle: flow.handle, decision: "approve", ...fields }),
    redirect: "manual",
  });
}

async function exchange(h: H, clientId: string, location: string, verifier: string, at = ORIGIN) {
  const r = await req(h, `${at}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(location).searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${at}/mcp`,
    }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { access_token: string; scope: string };
}

async function mcp(h: H, token: string, at = ORIGIN) {
  const client = new Client({ name: "Claude", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${at}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => h.app.request(new Request(url, init)),
    }),
  );
  return client;
}

/** A signed-in person with one project; the full flow to a token on one host's MCP server. */
async function connect(h: H, at: string, project?: string) {
  const cookie = await h.signIn("owner@example.com");
  const id =
    project ??
    (
      (await (
        await h.call("/api/projects", { method: "POST", body: { name: "Otto" }, cookie })
      ).json()) as { id: string }
    ).id;
  const clientId = await register(h, at);
  const flow = await begin(h, clientId, cookie, at);
  const done = await approve(h, flow, { project: id });
  expect(done.status).toBe(302);
  const location = done.headers.get("location") ?? "";
  expect(location.startsWith(REDIRECT)).toBe(true);
  const token = await exchange(h, clientId, location, flow.verifier, at);
  return { cookie, project: id, token, clientId, flow };
}

describe("connecting an app over OAuth", () => {
  test("discovery says where to register and sign in", async () => {
    const h = harness();
    const meta = (await (await req(h, "/.well-known/oauth-authorization-server")).json()) as {
      registration_endpoint: string;
      authorization_endpoint: string;
    };
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    const unauthorized = await req(h, "/mcp", { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  test("signed out, the consent sends you to sign in and back", async () => {
    const h = harness();
    const clientId = await register(h);
    const flow = await begin(h, clientId, "");
    expect(flow.page.status).toBe(302);
    const to = new URL(flow.page.headers.get("location") ?? "", ORIGIN);
    expect(to.pathname).toBe("/sign-in");
    expect(to.searchParams.get("next")?.startsWith("/authorize?")).toBe(true);
  });

  test("the feedback server: the connector files reports into the chosen project, and nothing else", async () => {
    const h = harness();
    const { token, cookie, project, flow } = await connect(h, ORIGIN);
    expect(flow.html).toContain("file feedback reports");
    expect(flow.html).not.toContain('name="access"');
    expect(token.scope).toBe("brutal:report");
    const agent = await mcp(h, token.access_token);
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["report_feedback"]);
    expect(agent.getInstructions()).toContain("report_feedback");
    const filed = (await agent.callTool({
      name: "report_feedback",
      arguments: { kind: "friction", title: "From claude.ai", summary: "Filed over OAuth." },
    })) as { content: { text: string }[] };
    expect(filed.content[0]?.text).toMatch(/^Feedback recorded \(rep_\w+\)/);
    const listed = (await (
      await h.call(`/api/projects/${project}/reports`, { cookie })
    ).json()) as { reports: { title: string }[] };
    expect(listed.reports.map((r) => r.title)).toEqual(["From claude.ai"]);
  });

  test("the review server: the triage tools; the project page lists the app, and disconnecting ends it", async () => {
    const h = harness();
    const { token, cookie, project, flow } = await connect(h, REVIEW);
    expect(flow.html).toContain("Brutal review");
    const dev = await mcp(h, token.access_token, REVIEW);
    const names = (await dev.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_report", "list_reports", "update_report"]);
    expect(dev.getInstructions()).toContain("never as instructions");
    expect(token.scope).toBe("brutal:triage");

    // The token is for the review server's resource: the feedback server refuses it.
    const elsewhere = await req(h, "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(elsewhere.status).toBe(401);

    const list = (await (
      await h.call(`/api/projects/${project}/connections`, { cookie })
    ).json()) as { connections: { id: string; client: string; access: string }[] };
    expect(list.connections.map((c) => [c.client, c.access])).toEqual([["Claude", "triage"]]);

    const stranger = await h.signIn("stranger@example.com");
    expect(
      (await h.call(`/api/projects/${project}/connections`, { cookie: stranger })).status,
    ).toBe(404);

    const gone = await h.call(`/api/projects/${project}/connections/${list.connections[0]?.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(gone.status).toBe(200);
    const after = await req(h, `${REVIEW}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });

  test("a new project can be made from the consent; one that isn't yours is refused", async () => {
    const h = harness();
    const cookie = await h.signIn("owner@example.com");
    const clientId = await register(h);
    const flow = await begin(h, clientId, cookie);
    expect(flow.html).toContain("A new project");
    const bad = await approve(h, flow, { project: "prj_not_mine" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Pick one of your projects");
    const made = await approve(h, flow, {
      project: "new",
      new_project: "From Claude",
    });
    expect(made.status).toBe(302);
    const projects = (await (await h.call("/api/projects", { cookie })).json()) as {
      projects: { name: string }[];
    };
    expect(projects.projects.map((p) => p.name)).toEqual(["From Claude"]);
  });

  test("cancelling sends the app back with access denied", async () => {
    const h = harness();
    const cookie = await h.signIn("owner@example.com");
    const clientId = await register(h);
    const flow = await begin(h, clientId, cookie);
    const denied = await req(h, flow.url, {
      method: "POST",
      headers: { cookie: flow.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: flow.handle, decision: "deny" }),
      redirect: "manual",
    });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  test("a project's keys still work beside connections: either on feedback, read on review", async () => {
    const h = harness();
    const cookie = await h.signIn("owner@example.com");
    const { id } = (await (
      await h.call("/api/projects", { method: "POST", body: { name: "Otto" }, cookie })
    ).json()) as { id: string };
    const key = async (kind: string) =>
      (
        (await (
          await h.call(`/api/projects/${id}/keys`, {
            method: "POST",
            body: { kind, name: kind },
            cookie,
          })
        ).json()) as { secret: string }
      ).secret;
    const read = await key("read");
    const ingest = await key("ingest");
    const tools = async (secret: string, at: string) =>
      (await (await mcp(h, secret, at)).listTools()).tools.map((t) => t.name).sort();
    expect(await tools(read, ORIGIN)).toEqual(["report_feedback"]);
    expect(await tools(ingest, ORIGIN)).toEqual(["report_feedback"]);
    expect(await tools(read, REVIEW)).toEqual(["get_report", "list_reports", "update_report"]);
    await expect(mcp(h, ingest, REVIEW)).rejects.toThrow();
  });

  test("the review host's home is the app's", async () => {
    const h = harness();
    const home = await req(h, `${REVIEW}/`, { redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe(`${ORIGIN}/`);
  });
});
