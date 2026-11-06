/**
 * The app's Operator entrypoint as this Worker sees it (worker/src/operator.ts), over the OPERATOR
 * service binding. Duplicated here, not imported, so this project builds on its own. Every method
 * takes the operator's email, which the app checks again.
 */

export interface People {
  /** Asked to sign in without an invite, not decided yet; newest first. */
  waiting: { email: string; created_at: string }[];
  /** Invited; `signed_up` once they have an account. */
  invites: { email: string; created_at: string; signed_up: number }[];
  /** Everyone with an account, and how many projects they have. */
  users: { email: string; created_at: string; projects: number }[];
}

export type Outcome =
  | "invited"
  | "already"
  | "dismissed"
  | "withdrawn"
  | "bad_email"
  | "no_mail"
  | "mail_failed";

export interface OperatorService {
  people(operator: string): Promise<People>;
  invite(operator: string, email: string): Promise<Outcome>;
  dismiss(operator: string, email: string): Promise<Outcome>;
  uninvite(operator: string, email: string): Promise<Outcome>;
}
