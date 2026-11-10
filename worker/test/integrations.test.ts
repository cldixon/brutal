import { describe, expect, test } from "bun:test";
import { migrated } from "../src/accounts";
import { harness } from "./harness";

const SECRETS = {
  INTEGRATIONS_KEY: btoa("k".repeat(32)),
  GITHUB_APP_CLIENT_ID: "gh-client",
  GITHUB_APP_CLIENT_SECRET: "gh-secret",
  GITHUB_APP_SLUG: "brutal-test",
  LINEAR_CLIENT_ID: "lin-client",
  LINEAR_CLIENT_SECRET: "lin-secret",
};

const report = {
  kind: "bug",
  title: "search_parts drops the year",
  summary: "Ask @octocat about #12.",
  tool_name: "search_parts",
  impact: "blocked",
  context: { app_version: "1.2.3", recent_tool_calls: [{ name: "search_parts", status: "error" }] },
};

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Fake GitHub and Linear: the endpoints the integrations call, and what they were sent. */
function fakeProviders() {
  const s = {
    challenge: "",
    github: { access: "gh-access-1", refresh: "gh-refresh-1", expiresIn: 28_800 },
    linear: { access: "lin-access-1", refresh: "lin-refresh-1" },
    refreshes: 0,
    revoked: [] as string[],
    issues: [] as { where: string; title: string; body: string; labels?: string[] }[],
    /** Repos with a Brutal label, and whether making one is refused (no push access). */
    githubLabels: new Set<string>(),
    githubLabelRefused: false,
    /** Linear's Brutal labels (null team: the workspace's), and whether making one is refused. */
    linearLabels: [] as { id: string; team: { id: string } | null }[],
    linearLabelRefused: false,
    tokenRequests: [] as URLSearchParams[],
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const key = `${method} ${url.host}${url.pathname}`;
    const pkceOk = async (verifier: string | null) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier ?? ""),
      );
      return b64url(new Uint8Array(digest)) === s.challenge;
    };

    if (key === "POST github.com/login/oauth/access_token") {
      const p = new URLSearchParams(String(init.body));
      s.tokenRequests.push(p);
      if (p.get("client_secret") !== "gh-secret") return json({ error: "incorrect_client" });
      if (p.get("grant_type") === "refresh_token") {
        if (p.get("refresh_token") !== s.github.refresh)
          return json({ error: "bad_refresh_token" });
        s.refreshes++;
        s.github = { access: "gh-access-2", refresh: "gh-refresh-2", expiresIn: 28_800 };
      } else if (p.get("code") !== "good-code" || !(await pkceOk(p.get("code_verifier")))) {
        return json({ error: "bad_verification_code" });
      }
      return json({
        access_token: s.github.access,
        refresh_token: s.github.refresh,
        expires_in: s.github.expiresIn,
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
        scope: "",
      });
    }
    if (
      url.host === "api.github.com" &&
      method !== "DELETE" &&
      auth !== `Bearer ${s.github.access}`
    ) {
      return json({ message: "Bad credentials" }, 401);
    }
    if (key === "GET api.github.com/user") return json({ login: "octo" });
    if (key === "GET api.github.com/user/installations") {
      return json({ total_count: 1, installations: [{ id: 7, account: { login: "octo" } }] });
    }
    if (key === "GET api.github.com/user/installations/7/repositories") {
      return json({
        total_count: 2,
        repositories: [{ full_name: "octo/z" }, { full_name: "octo/a" }],
      });
    }
    if (key === "GET api.github.com/repos/octo/a/labels/Brutal") {
      return s.githubLabels.has("octo/a")
        ? json({ name: "Brutal" })
        : json({ message: "Not Found" }, 404);
    }
    if (key === "POST api.github.com/repos/octo/a/labels") {
      if (s.githubLabelRefused) return json({ message: "Resource not accessible" }, 403);
      expect(JSON.parse(String(init.body))).toMatchObject({ name: "Brutal" });
      s.githubLabels.add("octo/a");
      return json({ name: "Brutal" }, 201);
    }
    if (key === "POST api.github.com/repos/octo/a/issues") {
      const body = JSON.parse(String(init.body)) as {
        title: string;
        body: string;
        labels?: string[];
      };
      s.issues.push({ where: "octo/a", ...body });
      return json({ number: 1, html_url: "https://github.com/octo/a/issues/1" }, 201);
    }
    if (key === "DELETE api.github.com/applications/gh-client/grant") {
      if (auth !== `Basic ${btoa("gh-client:gh-secret")}`) return json({}, 401);
      s.revoked.push(
        `github:${(JSON.parse(String(init.body)) as { access_token: string }).access_token}`,
      );
      return new Response(null, { status: 204 });
    }

    if (key === "POST api.linear.app/oauth/token") {
      const p = new URLSearchParams(String(init.body));
      s.tokenRequests.push(p);
      if (p.get("code") !== "good-code" || !(await pkceOk(p.get("code_verifier")))) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({
        access_token: s.linear.access,
        refresh_token: s.linear.refresh,
        token_type: "Bearer",
        expires_in: 86_399,
        scope: "read issues:create",
      });
    }
    if (key === "POST api.linear.app/oauth/revoke") {
      s.revoked.push(`linear:${auth.replace("Bearer ", "")}`);
      return new Response(null, { status: 200 });
    }
    if (key === "POST api.linear.app/graphql") {
      if (auth !== `Bearer ${s.linear.access}`) return json({ errors: [{ message: "auth" }] }, 401);
      const { query, variables } = JSON.parse(String(init.body)) as {
        query: string;
        variables: {
          input?: {
            teamId: string;
            title: string;
            description: string;
            labelIds?: string[];
            name?: string;
          };
        };
      };
      if (query.includes("issueLabelCreate") && variables.input) {
        if (s.linearLabelRefused) return json({ errors: [{ message: "Forbidden" }] });
        const made = {
          id: `label-${s.linearLabels.length + 1}`,
          team: { id: variables.input.teamId },
        };
        expect(variables.input.name).toBe("Brutal");
        s.linearLabels.push(made);
        return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: made.id } } } });
      }
      if (query.includes("issueLabels")) {
        return json({ data: { issueLabels: { nodes: s.linearLabels } } });
      }
      if (query.includes("organization")) return json({ data: { organization: { name: "Acme" } } });
      if (query.includes("teams")) {
        return json({ data: { teams: { nodes: [{ id: "team-1", name: "Core", key: "COR" }] } } });
      }
      if (query.includes("issueCreate") && variables.input) {
        const { teamId, title, description, labelIds } = variables.input;
        s.issues.push({ where: teamId, title, body: description, labels: labelIds });
        return json({
          data: {
            issueCreate: { success: true, issue: { url: "https://linear.app/acme/issue/COR-1" } },
          },
        });
      }
    }
    return json({ message: `fake: no route for ${key}` }, 404);
  };
  return { s, fetch };
}

async function setup(env: Record<string, unknown> = SECRETS) {
  const fake = fakeProviders();
  const h = harness(env, { providerFetch: () => fake.fetch });
  const cookie = await h.signIn("owner@example.com");
  const project = (await (
    await h.call("/api/projects", { method: "POST", body: { name: "Otto" }, cookie })
  ).json()) as { id: string };
  const ingest = (
    (await (
      await h.call(`/api/projects/${project.id}/keys`, {
        method: "POST",
        body: { kind: "ingest", name: "i" },
        cookie,
      })
    ).json()) as { secret: string }
  ).secret;
  const filed = (await (
    await h.keyed(ingest, "/v1/reports", { method: "POST", body: JSON.stringify(report) })
  ).json()) as { id: string };
  return { h, fake, cookie, project, reportId: filed.id };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A fresh ingest key for the project, to file more reports. */
async function ingestKey(t: Setup): Promise<string> {
  return (
    (await (
      await t.h.call(`/api/projects/${t.project.id}/keys`, {
        method: "POST",
        body: { kind: "ingest", name: `i${Math.random()}` },
        cookie: t.cookie,
      })
    ).json()) as { secret: string }
  ).secret;
}

/** Starts connecting; returns the state and where the provider would send the browser. */
async function connect(t: Setup, provider: string, cookie = t.cookie) {
  const res = await t.h.call(
    `/api/integrations/${provider}/connect?return=${encodeURIComponent(`/projects/${t.project.id}`)}`,
    { cookie },
  );
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location") ?? "");
  t.fake.s.challenge = to.searchParams.get("code_challenge") ?? "";
  return { to, state: to.searchParams.get("state") ?? "" };
}

const callback = (t: Setup, provider: string, query: string, cookie = t.cookie) =>
  t.h.call(`/api/integrations/${provider}/callback?${query}`, { cookie });

async function connected(t: Setup, provider: string): Promise<string> {
  const { state } = await connect(t, provider);
  const res = await callback(t, provider, `code=good-code&state=${state}`);
  expect(res.status).toBe(302);
  const list = (await (await t.h.call("/api/integrations", { cookie: t.cookie })).json()) as {
    integrations: { id: string; provider: string }[];
  };
  const found = list.integrations.find((i) => i.provider === provider);
  if (!found) throw new Error("not connected");
  return found.id;
}

describe("integrations", () => {
  test("without secrets, providers are unavailable and their routes answer 503", async () => {
    const t = await setup({});
    const list = (await (await t.h.call("/api/integrations", { cookie: t.cookie })).json()) as {
      providers: { id: string; available: boolean }[];
    };
    expect(list.providers.map((p) => [p.id, p.available])).toEqual([
      ["github", false],
      ["linear", false],
    ]);
    for (const p of ["github", "linear"]) {
      expect((await t.h.call(`/api/integrations/${p}/connect`, { cookie: t.cookie })).status).toBe(
        503,
      );
      expect((await callback(t, p, "code=x&state=y")).status).toBe(503);
    }
    // A key alone isn't enough: the provider's own client id and secret are needed too.
    const keyOnly = await setup({ INTEGRATIONS_KEY: SECRETS.INTEGRATIONS_KEY });
    const res = await keyOnly.h.call("/api/integrations/github/connect", {
      cookie: keyOnly.cookie,
    });
    expect(res.status).toBe(503);
  });

  test("connect sends the browser to GitHub with state and PKCE, and the callback stores the connection", async () => {
    const t = await setup();
    const { to, state } = await connect(t, "github");
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("gh-client");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://brutal.test/api/integrations/github/callback",
    );
    expect(state.length).toBeGreaterThan(20);

    const res = await callback(t, "github", `code=good-code&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/projects/${t.project.id}?integration=connected`);

    const listRes = await t.h.call("/api/integrations", { cookie: t.cookie });
    const text = await listRes.text();
    const list = JSON.parse(text) as {
      providers: { id: string; available: boolean; install_url: string | null }[];
      integrations: Record<string, unknown>[];
    };
    expect(list.providers[0]).toMatchObject({
      id: "github",
      available: true,
      install_url: "https://github.com/apps/brutal-test/installations/new",
    });
    expect(list.integrations).toHaveLength(1);
    expect(Object.keys(list.integrations[0] ?? {}).sort()).toEqual([
      "account",
      "created_at",
      "id",
      "provider",
    ]);
    expect(list.integrations[0]?.account).toBe("octo");
    expect(text).not.toContain("gh-access");
    expect(text).not.toContain("gh-refresh");

    // Stored sealed: neither token is in the row.
    const db = await migrated(t.h.bindings.DB);
    const row = await db
      .prepare("SELECT access_token, refresh_token, expires_at FROM integrations")
      .first<{ access_token: string; refresh_token: string; expires_at: string }>();
    expect(row?.access_token.startsWith("v1.")).toBe(true);
    expect(row?.refresh_token.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain("gh-access-1");
    expect(JSON.stringify(row)).not.toContain("gh-refresh-1");
    expect(Date.parse(row?.expires_at ?? "")).toBeGreaterThan(Date.now());

    // Reconnecting the same account keeps one connection.
    await connected(t, "github");
    const again = (await (await t.h.call("/api/integrations", { cookie: t.cookie })).json()) as {
      integrations: unknown[];
    };
    expect(again.integrations).toHaveLength(1);
  });

  test("a missing, unknown, reused, other session's or other provider's state is refused", async () => {
    const t = await setup();
    expect((await callback(t, "github", "code=good-code")).status).toBe(400);
    expect((await callback(t, "github", "code=good-code&state=bogus")).status).toBe(400);

    const { state } = await connect(t, "github");
    // Another session (the same person signed in elsewhere) can't finish it.
    const other = await t.h.signIn("stranger@example.com");
    expect((await callback(t, "github", `code=good-code&state=${state}`, other)).status).toBe(400);
    // And it was used up by that attempt.
    expect((await callback(t, "github", `code=good-code&state=${state}`)).status).toBe(400);

    const linear = await connect(t, "linear");
    expect((await callback(t, "github", `code=good-code&state=${linear.state}`)).status).toBe(400);

    // Signed out, the callback is refused outright.
    expect((await t.h.call(`/api/integrations/github/callback?state=${state}`)).status).toBe(401);

    const ok = await connect(t, "github");
    expect((await callback(t, "github", `code=good-code&state=${ok.state}`)).status).toBe(302);
    expect((await callback(t, "github", `code=good-code&state=${ok.state}`)).status).toBe(400);

    const db = await migrated(t.h.bindings.DB);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM integrations").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  test("a denied consent goes back without connecting", async () => {
    const t = await setup();
    const { state } = await connect(t, "github");
    const res = await callback(t, "github", `error=access_denied&state=${state}`);
    expect(res.headers.get("location")).toBe(`/projects/${t.project.id}?integration=cancelled`);
  });

  test("the return path stays on this site", async () => {
    const t = await setup();
    const res = await t.h.call("/api/integrations/github/connect?return=//evil.example", {
      cookie: t.cookie,
    });
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    t.fake.s.challenge = new URL(res.headers.get("location") ?? "").searchParams.get(
      "code_challenge",
    ) as string;
    const back = await callback(t, "github", `code=good-code&state=${state}`);
    expect(back.headers.get("location")).toBe("/projects?integration=connected");
  });

  test("targets list the app's repos; an expiring token is refreshed first", async () => {
    const t = await setup();
    const id = await connected(t, "github");
    const targets = async () =>
      (await (await t.h.call(`/api/integrations/${id}/targets`, { cookie: t.cookie })).json()) as {
        targets: { id: string }[];
      };
    expect((await targets()).targets.map((r) => r.id)).toEqual(["octo/a", "octo/z"]);
    expect(t.fake.s.refreshes).toBe(0);

    const db = await migrated(t.h.bindings.DB);
    await db
      .prepare("UPDATE integrations SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await targets()).targets).toHaveLength(2);
    expect(t.fake.s.refreshes).toBe(1);
    const row = await db
      .prepare("SELECT refresh_token, expires_at FROM integrations")
      .first<{ refresh_token: string; expires_at: string }>();
    expect(Date.parse(row?.expires_at ?? "")).toBeGreaterThan(Date.now());
    expect(row?.refresh_token).not.toContain("gh-refresh");
    // The rotated refresh token was kept: the next refresh uses it.
    await db
      .prepare("UPDATE integrations SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    t.fake.s.github.access = "gh-access-2";
    expect((await targets()).targets).toHaveLength(2);
    expect(t.fake.s.tokenRequests.at(-1)?.get("refresh_token")).toBe("gh-refresh-2");

    // A refresh the provider refuses asks the person to reconnect.
    await db
      .prepare("UPDATE integrations SET expires_at = ?, refresh_token = NULL")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    const res = await t.h.call(`/api/integrations/${id}/targets`, { cookie: t.cookie });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Reconnect GitHub");
  });

  test("creating a GitHub issue links it on the report and remembers the target", async () => {
    const t = await setup();
    const id = await connected(t, "github");
    const path = `/api/projects/${t.project.id}/reports/${t.reportId}/issue`;
    const res = await t.h.call(path, {
      method: "POST",
      body: { integration: id, target: "octo/a" },
      cookie: t.cookie,
    });
    expect(res.status).toBe(201);
    const updated = (await res.json()) as { status: string; issue_url: string };
    expect(updated).toMatchObject({
      status: "linked",
      issue_url: "https://github.com/octo/a/issues/1",
    });
    const issue = t.fake.s.issues[0];
    expect(issue?.title).toBe(report.title);
    expect(issue?.body).toContain(
      `https://brutal.test/projects/${t.project.id}/reports/${t.reportId}`,
    );
    expect(issue?.body).not.toContain("@octocat");
    expect(issue?.body).toContain("`1.2.3`");
    // The repo had no Brutal label: it's made, and the issue carries it.
    expect(issue?.labels).toEqual(["Brutal"]);
    expect(t.fake.s.githubLabels.has("octo/a")).toBe(true);

    const stored = (await (
      await t.h.call(`/api/projects/${t.project.id}/reports/${t.reportId}`, { cookie: t.cookie })
    ).json()) as { issue_url: string };
    expect(stored.issue_url).toBe("https://github.com/octo/a/issues/1");

    const def = await t.h.call(`/api/projects/${t.project.id}/issue-target`, { cookie: t.cookie });
    expect(await def.json()).toEqual({ default: { integration: id, target: "octo/a" } });

    // A report links one issue.
    const again = await t.h.call(path, {
      method: "POST",
      body: { integration: id, target: "octo/a" },
      cookie: t.cookie,
    });
    expect(again.status).toBe(409);
    expect(t.fake.s.issues).toHaveLength(1);
  });

  test("creating a Linear issue in a team", async () => {
    const t = await setup();
    const id = await connected(t, "linear");
    const scope = t.fake.s.tokenRequests[0];
    expect(scope?.get("code_verifier")).toBeTruthy();
    const targets = (await (
      await t.h.call(`/api/integrations/${id}/targets`, { cookie: t.cookie })
    ).json()) as { targets: { id: string; name: string }[] };
    expect(targets.targets).toEqual([{ id: "team-1", name: "Core (COR)" }]);
    const res = await t.h.call(`/api/projects/${t.project.id}/reports/${t.reportId}/issue`, {
      method: "POST",
      body: { integration: id, target: "team-1" },
      cookie: t.cookie,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { issue_url: string }).issue_url).toBe(
      "https://linear.app/acme/issue/COR-1",
    );
    expect(t.fake.s.issues[0]?.where).toBe("team-1");
    // No Brutal label yet: one is made in the team and put on the issue.
    expect(t.fake.s.issues[0]?.labels).toEqual(["label-1"]);
  });

  test("an existing Brutal label is reused, and one that can't be made doesn't stop the issue", async () => {
    const t = await setup();
    const gh = await connected(t, "github");
    const lin = await connected(t, "linear");
    const file = async (integration: string, target: string) => {
      const filed = (await (
        await t.h.keyed(await ingestKey(t), "/v1/reports", {
          method: "POST",
          body: JSON.stringify(report),
        })
      ).json()) as { id: string };
      return t.h.call(`/api/projects/${t.project.id}/reports/${filed.id}/issue`, {
        method: "POST",
        body: { integration, target },
        cookie: t.cookie,
      });
    };

    // Linear: the workspace already has one; it's used, and nothing is made.
    t.fake.s.linearLabels.push({ id: "ws-label", team: null });
    expect((await file(lin, "team-1")).status).toBe(201);
    expect(t.fake.s.issues.at(-1)?.labels).toEqual(["ws-label"]);
    expect(t.fake.s.linearLabels).toHaveLength(1);

    // GitHub without push access: the label can't be made, the issue is filed without it.
    t.fake.s.githubLabelRefused = true;
    expect((await file(gh, "octo/a")).status).toBe(201);
    expect(t.fake.s.issues.at(-1)?.labels).toBeUndefined();

    // Linear refusing to make a label: the same.
    t.fake.s.linearLabels.length = 0;
    t.fake.s.linearLabelRefused = true;
    expect((await file(lin, "team-1")).status).toBe(201);
    expect(t.fake.s.issues.at(-1)?.labels).toBeUndefined();
  });

  test("Linear's authorize URL asks for read and issues:create", async () => {
    const t = await setup();
    const { to } = await connect(t, "linear");
    expect(to.origin + to.pathname).toBe("https://linear.app/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("read,issues:create");
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("a stranger can't use or see another person's connection or project", async () => {
    const t = await setup();
    const id = await connected(t, "github");
    const stranger = await t.h.signIn("stranger@example.com");
    const theirs = (await (
      await t.h.call("/api/projects", { method: "POST", body: { name: "Mine" }, cookie: stranger })
    ).json()) as { id: string };

    const issue = (project: string) =>
      t.h.call(`/api/projects/${project}/reports/${t.reportId}/issue`, {
        method: "POST",
        body: { integration: id, target: "octo/a" },
        cookie: stranger,
      });
    expect((await issue(t.project.id)).status).toBe(404);
    // Their own project, the owner's connection: still not found.
    expect((await issue(theirs.id)).status).toBe(404);
    expect((await t.h.call(`/api/integrations/${id}/targets`, { cookie: stranger })).status).toBe(
      404,
    );
    expect(
      (await t.h.call(`/api/integrations/${id}`, { method: "DELETE", cookie: stranger })).status,
    ).toBe(404);
    expect(
      (await t.h.call(`/api/projects/${t.project.id}/issue-target`, { cookie: stranger })).status,
    ).toBe(404);
    const list = (await (await t.h.call("/api/integrations", { cookie: stranger })).json()) as {
      integrations: unknown[];
    };
    expect(list.integrations).toEqual([]);
    expect(t.fake.s.issues).toHaveLength(0);
  });

  test("state-changing calls must come from this site", async () => {
    const t = await setup();
    const id = await connected(t, "github");
    const res = await t.h.call(`/api/projects/${t.project.id}/reports/${t.reportId}/issue`, {
      method: "POST",
      body: { integration: id, target: "octo/a" },
      cookie: t.cookie,
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const del = await t.h.call(`/api/integrations/${id}`, {
      method: "DELETE",
      cookie: t.cookie,
      headers: { origin: "https://evil.example" },
    });
    expect(del.status).toBe(403);
  });

  test("disconnecting revokes at the provider and forgets the connection and default", async () => {
    const t = await setup();
    const gh = await connected(t, "github");
    const lin = await connected(t, "linear");
    await t.h.call(`/api/projects/${t.project.id}/reports/${t.reportId}/issue`, {
      method: "POST",
      body: { integration: gh, target: "octo/a" },
      cookie: t.cookie,
    });
    for (const id of [gh, lin]) {
      const res = await t.h.call(`/api/integrations/${id}`, { method: "DELETE", cookie: t.cookie });
      expect(res.status).toBe(200);
    }
    expect(t.fake.s.revoked).toEqual(["github:gh-access-1", "linear:lin-access-1"]);
    const list = (await (await t.h.call("/api/integrations", { cookie: t.cookie })).json()) as {
      integrations: unknown[];
    };
    expect(list.integrations).toEqual([]);
    const def = await t.h.call(`/api/projects/${t.project.id}/issue-target`, { cookie: t.cookie });
    expect(await def.json()).toEqual({ default: null });
  });

  test("a sealed token copied into another row doesn't open", async () => {
    const { sealingKey, seal, unseal } = await import("../src/integrations");
    const key = await sealingKey({ INTEGRATIONS_KEY: SECRETS.INTEGRATIONS_KEY } as never);
    if (!key) throw new Error("no key");
    const sealed = await seal(key, "secret-token", "int_a");
    expect(await unseal(key, sealed, "int_a")).toBe("secret-token");
    expect(unseal(key, sealed, "int_b")).rejects.toThrow();
    expect(await sealingKey({ INTEGRATIONS_KEY: btoa("short") } as never)).toBeNull();
  });
});
