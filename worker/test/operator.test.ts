import { expect, test } from "bun:test";
import { joinWaitlist, migrated } from "../src/accounts";
import { operatorOps } from "../src/operator";
import { bunD1 } from "./d1";

function setup(withMail = true) {
  const db = bunD1();
  const mail: { to: string; subject: string; text: string }[] = [];
  const mailer = withMail
    ? async (to: string, subject: string, text: string) => {
        mail.push({ to, subject, text });
      }
    : null;
  return { db, mail, ops: operatorOps(db, mailer, "https://brutal.test") };
}

test("inviting someone waiting mails them once and moves them off the waitlist", async () => {
  const { db, mail, ops } = setup();
  await joinWaitlist(await migrated(db), "new@example.com");
  expect((await ops.people()).waiting.map((w) => w.email)).toEqual(["new@example.com"]);

  expect(await ops.invite("New@Example.com")).toBe("invited");
  expect(await ops.invite("new@example.com")).toBe("already");
  expect(mail.map((m) => [m.to, m.subject])).toEqual([["new@example.com", "You're in: Brutal"]]);
  expect(mail[0]?.text).toContain("https://brutal.test/sign-in");

  const people = await ops.people();
  expect(people.waiting).toEqual([]);
  expect(people.invites.map((i) => [i.email, i.signed_up])).toEqual([["new@example.com", 0]]);
});

test("dismiss, withdraw, bad emails and no mail", async () => {
  const { db, ops } = setup(false);
  await joinWaitlist(await migrated(db), "nope@example.com");
  expect(await ops.dismiss("nope@example.com")).toBe("dismissed");
  expect((await ops.people()).waiting).toEqual([]);
  expect(await ops.invite("someone@example.com")).toBe("no_mail");
  expect(await ops.uninvite("someone@example.com")).toBe("withdrawn");
  expect((await ops.people()).invites).toEqual([]);
  expect(await ops.invite("not an email")).toBe("bad_email");
});
