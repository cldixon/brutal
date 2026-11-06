import { describe, expect, test } from "bun:test";
import { type AdminEnv, createAdmin } from "../src/index";
import type { OperatorService, People } from "../src/operator";
import { accessSigner } from "./jwt";

const team = "example.cloudflareaccess.com";
const signer = await accessSigner();
const admin = createAdmin({ keys: async () => [signer.jwk] });
const token = (email = "op@example.com") =>
  signer.sign({ aud: ["aud-1"], iss: `https://${team}`, email, exp: Date.now() / 1000 + 600 });

function env(calls: string[] = []): AdminEnv {
  const people: People = {
    waiting: [{ email: "<script>@x.com", created_at: "2026-11-06T00:00:00Z" }],
    invites: [{ email: "in@example.com", created_at: "2026-11-05T00:00:00Z", signed_up: 0 }],
    users: [{ email: "op@example.com", created_at: "2026-11-01T00:00:00Z", projects: 2 }],
  };
  const op: OperatorService = {
    people: async (who) => {
      calls.push(`people ${who}`);
      return people;
    },
    invite: async (who, email) => {
      calls.push(`invite ${who} ${email}`);
      return "invited";
    },
    dismiss: async (who, email) => {
      calls.push(`dismiss ${who} ${email}`);
      return "dismissed";
    },
    uninvite: async (who, email) => {
      calls.push(`uninvite ${who} ${email}`);
      return "withdrawn";
    },
  };
  return {
    ORIGIN: "https://admin.test",
    ACCESS_TEAM: team,
    ACCESS_AUD: "aud-1",
    OPERATOR_EMAIL: "op@example.com",
    OPERATOR: op,
  };
}

describe("the operator's portal", () => {
  test("refuses anyone without Access's token for the operator", async () => {
    expect((await admin.request("https://admin.test/", {}, env())).status).toBe(403);
    const other = await admin.request(
      "https://admin.test/",
      { headers: { "cf-access-jwt-assertion": await token("someone@else.com") } },
      env(),
    );
    expect(other.status).toBe(403);
  });

  test("lists who waits, who's invited and the accounts, escaped", async () => {
    const calls: string[] = [];
    const res = await admin.request(
      "https://admin.test/",
      { headers: { "cf-access-jwt-assertion": await token() } },
      env(calls),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("&lt;script&gt;@x.com");
    expect(text).toContain("in@example.com");
    expect(text).toContain("2 projects");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(calls).toEqual(["people op@example.com"]);
  });

  test("invites from its own page only, then says what happened", async () => {
    const calls: string[] = [];
    const post = async (origin: string) =>
      admin.request(
        "https://admin.test/invite",
        {
          method: "POST",
          headers: { "cf-access-jwt-assertion": await token(), origin },
          body: new URLSearchParams({ email: "new@example.com" }),
        },
        env(calls),
      );
    expect((await post("https://evil.example")).status).toBe(403);
    const res = await post("https://admin.test");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?done=invited&email=new%40example.com");
    expect(calls).toEqual(["invite op@example.com new@example.com"]);
  });
});
