import { html } from "hono/html";
import type { Outcome, People } from "./operator";

/** The portal's pages: server-rendered, no script, every value escaped by hono/html. */

const OUTCOMES: Record<Outcome, string> = {
  invited: "invited, and emailed where to sign in.",
  already: "was already invited.",
  dismissed: "is off the waitlist.",
  withdrawn: "is no longer invited (an account, if they made one, stays).",
  bad_email: "isn't a valid email.",
  no_mail: "invited. Mail isn't set up yet, so tell them to sign in.",
  mail_failed: "invited, but the mail failed. Tell them to sign in.",
};

export function isOutcome(value: string | undefined): value is Outcome {
  return !!value && value in OUTCOMES;
}

function layout(title: string, body: unknown) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${title} · Brutal admin</title>
        <link rel="stylesheet" href="/admin.css" />
      </head>
      <body>
        <main>
          <p class="brand">Brutal admin</p>
          ${body}
        </main>
      </body>
    </html>`;
}

export function message(title: string, text: string) {
  return layout(title, html`<h1>${title}</h1><p>${text}</p>`).toString();
}

const day = (iso: string) => iso.slice(0, 10);

/** A small form that posts one email to `action`, as a button. */
const act = (action: string, email: string, label: string) =>
  html`<form method="post" action="${action}"><input type="hidden" name="email" value="${email}" /><button>${label}</button></form>`;

export function home(opts: {
  people: People | null;
  done: { outcome: Outcome; email: string } | null;
}) {
  const { people, done } = opts;
  const waiting = people?.waiting ?? [];
  const pending = (people?.invites ?? []).filter((i) => !i.signed_up);
  const users = people?.users ?? [];
  return layout(
    "Access",
    html`<h1>Who has access</h1>
      ${done ? html`<p class="done">${done.email} ${OUTCOMES[done.outcome]}</p>` : ""}
      ${people ? "" : html`<p class="error">The app didn't answer; these lists may be incomplete.</p>`}
      <form method="post" action="/invite" class="row">
        <input type="email" name="email" placeholder="someone@example.com" required />
        <button class="primary">Invite</button>
      </form>

      <h2>Waiting (${waiting.length})</h2>
      ${
        waiting.length === 0
          ? html`<p class="muted">Nobody is waiting.</p>`
          : html`<table>
            ${waiting.map(
              (w) => html`<tr>
                <td>${w.email}</td><td class="muted">${day(w.created_at)}</td>
                <td class="actions">${act("/invite", w.email, "Invite")} ${act("/dismiss", w.email, "Dismiss")}</td>
              </tr>`,
            )}
          </table>`
      }

      <h2>Invited, not signed up yet (${pending.length})</h2>
      ${
        pending.length === 0
          ? html`<p class="muted">None.</p>`
          : html`<table>
            ${pending.map(
              (i) => html`<tr>
                <td>${i.email}</td><td class="muted">invited ${day(i.created_at)}</td>
                <td class="actions">${act("/uninvite", i.email, "Withdraw")}</td>
              </tr>`,
            )}
          </table>`
      }

      <h2>Accounts (${users.length})</h2>
      ${
        users.length === 0
          ? html`<p class="muted">No accounts yet.</p>`
          : html`<table>
            ${users.map(
              (u) => html`<tr>
                <td>${u.email}</td><td class="muted">since ${day(u.created_at)}</td>
                <td class="muted">${u.projects} project${u.projects === 1 ? "" : "s"}</td>
              </tr>`,
            )}
          </table>`
      }`,
  ).toString();
}
