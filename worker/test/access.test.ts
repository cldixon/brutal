import { describe, expect, test } from "bun:test";
import { type Cf, ensureAccess, parseCfJson } from "../cli/access";
import { accessConfig, type KeySource, verifyAccess } from "../src/access";
import { accessSigner } from "./jwt";

const team = "example.cloudflareaccess.com";
const cfg = { team, aud: "aud-1", emails: ["owner@example.com"] };
const now = Date.now();
const claims = (over: Record<string, unknown> = {}) => ({
  aud: ["aud-1"],
  iss: `https://${team}`,
  email: "Owner@Example.com",
  exp: now / 1000 + 600,
  nbf: now / 1000 - 10,
  ...over,
});

describe("verifyAccess", async () => {
  const signer = await accessSigner();
  const keys: KeySource = async () => [signer.jwk];

  test("a token for this app and an allowed email", async () => {
    expect(await verifyAccess(await signer.sign(claims()), cfg, keys, now)).toEqual({
      ok: true,
      email: "owner@example.com",
    });
  });

  test("refusals", async () => {
    const why = async (token: string | null) =>
      ((await verifyAccess(token, cfg, keys, now)) as { why: string }).why;
    expect(await why(null)).toBe("no token");
    expect(await why("a.b")).toBe("malformed");
    expect(await why(await signer.sign(claims({ aud: ["other"] })))).toBe("wrong audience");
    expect(await why(await signer.sign(claims({ iss: "https://evil.example" })))).toBe(
      "wrong issuer",
    );
    expect(await why(await signer.sign(claims({ exp: now / 1000 - 1 })))).toBe("expired");
    expect(await why(await signer.sign(claims({ email: "someone@else.com" })))).toBe(
      "email not allowed",
    );
    expect(await why(await signer.sign(claims(), { alg: "HS256" }))).toBe("unexpected algorithm");
    const forged = (await accessSigner()).sign(claims());
    expect(await why(await forged)).toBe("bad signature");
  });

  test("an unknown key id fetches the keys afresh once", async () => {
    const asked: boolean[] = [];
    const rotating: KeySource = async (_t, fresh) => {
      asked.push(fresh);
      return fresh ? [signer.jwk] : [];
    };
    expect((await verifyAccess(await signer.sign(claims()), cfg, rotating, now)).ok).toBe(true);
    expect(asked).toEqual([false, true]);
  });

  test("bindings: off unless team and audience are set", () => {
    expect(accessConfig({})).toBeNull();
    expect(
      accessConfig({ ACCESS_TEAM: team, ACCESS_AUD: "a", ACCESS_EMAILS: " A@x.com, b@x.com " }),
    ).toEqual({ team, aud: "a", emails: ["a@x.com", "b@x.com"] });
  });
});

/** A fake `cf zero-trust`: an account's Access state, changed by create and update calls. */
function fakeAccount(org: { auth_domain?: string } = { auth_domain: team }) {
  const state = {
    idps: [] as { id: string; type: string }[],
    policies: [] as Record<string, unknown>[],
    apps: [{ id: "other", name: "Someone else", domain: "other.example.com", aud: "x" }] as Record<
      string,
      unknown
    >[],
  };
  const writes: string[] = [];
  let n = 0;
  const cf: Cf = async (args, body) => {
    const key = args.join(" ");
    if (key === "organization get") return org;
    if (key === "identity-providers list") return state.idps;
    if (key === "access policies list") return state.policies;
    if (key === "access applications list") return state.apps;
    writes.push(key.replace(/ [\w-]+$/, (m) => (m.includes("-") ? " <id>" : m)));
    const made = { id: `id-${++n}`, ...(body as object) };
    if (key === "identity-providers create") state.idps.push(made as { id: string; type: string });
    if (key === "access policies create") state.policies.push(made);
    if (key.startsWith("access policies update")) {
      state.policies[0] = { ...made, id: args[3] };
      return state.policies[0];
    }
    if (key === "access applications create") state.apps.push({ ...made, aud: "aud-new" });
    if (key.startsWith("access applications update")) {
      const i = state.apps.findIndex((a) => a.id === args[3]);
      state.apps[i] = { ...made, id: args[3], aud: state.apps[i]?.aud };
      return state.apps[i];
    }
    return key === "access applications create" ? state.apps.at(-1) : made;
  };
  return { cf, state, writes };
}

const want = {
  host: "brutal.example.com",
  worker: "brutal",
  emails: ["owner@example.com"],
  sessionDuration: "24h",
};

describe("ensureAccess", () => {
  test("creates the login, policy and an app over /dashboard only; a second run changes nothing", async () => {
    const account = fakeAccount();
    const first = await ensureAccess(account.cf, want);
    expect(first.team).toBe(team);
    expect(first.aud).toBe("aud-new");
    expect(account.writes).toEqual([
      "identity-providers create",
      "access policies create",
      "access applications create",
    ]);
    const app = account.state.apps.find((a) => a.name === "Brutal (brutal.example.com)");
    expect(app?.domain).toBe("brutal.example.com/dashboard");
    expect(account.state.apps.find((a) => a.id === "other")?.domain).toBe("other.example.com");

    account.writes.length = 0;
    const again = await ensureAccess(account.cf, want);
    expect(again.changes).toEqual([]);
    expect(account.writes).toEqual([]);
    expect(again.aud).toBe("aud-new");
  });

  test("changed emails correct the policy", async () => {
    const account = fakeAccount();
    await ensureAccess(account.cf, want);
    const changed = await ensureAccess(account.cf, { ...want, emails: ["new@example.com"] });
    expect(changed.changes).toEqual([
      'correct the policy "Brutal brutal: owners" (allow new@example.com only)',
    ]);
  });

  test("a dry run writes nothing; no organization or no email is refused", async () => {
    const account = fakeAccount();
    const dry = await ensureAccess(account.cf, want, true);
    expect(dry.changes).toHaveLength(3);
    expect(dry.aud).toBe("");
    expect(account.writes).toEqual([]);
    await expect(ensureAccess(fakeAccount({}).cf, want)).rejects.toThrow("Zero Trust");
    await expect(ensureAccess(account.cf, { ...want, emails: [] })).rejects.toThrow("email");
  });

  test("cf's output: the JSON after a result_info line", () => {
    expect(parseCfJson('result_info: {"page":1}\n[\n  {"id": "a"}\n]\n')).toEqual([{ id: "a" }]);
    expect(parseCfJson('{"auth_domain": "x"}')).toEqual({ auth_domain: "x" });
    expect(parseCfJson("nothing")).toBeNull();
  });
});
