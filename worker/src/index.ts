import { WorkerEntrypoint } from "cloudflare:workers";
import { type Bindings, mailerFor } from "./app";
import { operatorOps } from "./operator";
import { createWorker } from "./worker";

export { Project } from "./project";

/**
 * The operator's portal's way in (admin/): RPC over its OPERATOR service binding, with no route.
 * Cloudflare Access signed the operator in before the portal calls; each method checks the email
 * it passes is OPERATOR_EMAIL again, and refuses otherwise.
 */
export class Operator extends WorkerEntrypoint<Bindings> {
  private ops(operator: string) {
    const expected = this.env.OPERATOR_EMAIL?.trim().toLowerCase();
    if (!expected || operator.trim().toLowerCase() !== expected) {
      throw new Error("Not the operator.");
    }
    return operatorOps(this.env.DB, mailerFor(this.env), this.env.APP_ORIGIN ?? "");
  }
  people(operator: string) {
    return this.ops(operator).people();
  }
  invite(operator: string, email: string) {
    return this.ops(operator).invite(email);
  }
  dismiss(operator: string, email: string) {
    return this.ops(operator).dismiss(email);
  }
  uninvite(operator: string, email: string) {
    return this.ops(operator).uninvite(email);
  }
}

export default createWorker();
