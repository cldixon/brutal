import { adminView, dismiss, EMAIL, invite, migrated, normalizeEmail, uninvite } from "./accounts";
import type { Mailer } from "./app";

/**
 * What the operator does from the portal (admin/, after Tempra's): who has access, inviting, the
 * waitlist's decisions. The portal calls these through the `Operator` RPC entrypoint (index.ts),
 * which has no route and checks the operator's email again. Free of Worker APIs.
 */

export type Outcome =
  | "invited"
  | "already"
  | "dismissed"
  | "withdrawn"
  | "bad_email"
  | "no_mail"
  | "mail_failed";

export function operatorOps(db: D1Database, mailer: Mailer | null, origin: string) {
  const valid = (email: string) => {
    const e = normalizeEmail(email);
    return EMAIL.test(e) && e.length <= 254 ? e : null;
  };
  return {
    async people() {
      return adminView(await migrated(db));
    },

    /** Invites `email` and mails them "You're in"; once, however often it's clicked. */
    async invite(email: string): Promise<Outcome> {
      const e = valid(email);
      if (!e) return "bad_email";
      if (!(await invite(await migrated(db), e))) return "already";
      if (!mailer) return "no_mail";
      try {
        await mailer(
          e,
          "You're in: Brutal",
          `You're invited to Brutal, feedback for agents.\n\nSign in with this email at ${origin}/sign-in\n`,
        );
        return "invited";
      } catch (error) {
        console.error(JSON.stringify({ invitation_mail_failed: String(error) }));
        return "mail_failed";
      }
    },

    async dismiss(email: string): Promise<Outcome> {
      const e = valid(email);
      if (!e) return "bad_email";
      await dismiss(await migrated(db), e);
      return "dismissed";
    },

    async uninvite(email: string): Promise<Outcome> {
      const e = valid(email);
      if (!e) return "bad_email";
      await uninvite(await migrated(db), e);
      return "withdrawn";
    },
  };
}
