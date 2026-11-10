# Integrations: issues in GitHub and Linear

A person connects GitHub or Linear once (the Projects page, under Integrations), then files an
issue from any report in their projects with **Create issue**, on the report's page or its row
in the project's reports. The issue's link is set on the report, its status becomes `linked`,
and the button becomes **Open issue**.

The button is greyed out until the person has a connection. It files where the project's last
issue went, or, before there is one, into the only place there is (one connection with one repo
or team); otherwise the first click asks, and its ▾ picks another place any time. Every issue
carries a **Brutal** label: Brutal makes it in the repo or team when it's missing, and when it
can't (no push access on GitHub; a Linear workspace that won't let the app make labels) the
issue is filed without it. In Linear, a workspace label named Brutal is used when there is one.

The code is `worker/src/integrations.ts` (routes, providers, token sealing) and
`worker/src/issue-body.ts` (the issue's title and body). Until the secrets below are set, both
providers show as unavailable and their routes answer 503; nothing else changes.

## One-time setup (the operator)

The app's origin is `https://thatsbrutal.fyi` (`APP_ORIGIN`, from `deploy.config.ts`); use the
new one if the domain changes. Run the `cf` commands from `worker/` with
`CF_SEND_TELEMETRY=false`. Each `secrets update` makes a new version of the Worker.

### 1. The sealing key

People's tokens are stored in D1 encrypted with AES-GCM under this key (32 random bytes,
base64). Set it once; changing it later makes every stored connection unreadable (people
reconnect).

```sh
bunx cf workers secrets update INTEGRATIONS_KEY --worker brutal --type secret_text \
  --text "$(openssl rand -base64 32)"
```

### 2. GitHub: a GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (under the account or
organization that should own it):

- **Name**: e.g. `Brutal` (its slug, from the app's URL `github.com/apps/<slug>`, is
  `GITHUB_APP_SLUG`).
- **Homepage URL**: `https://thatsbrutal.fyi`
- **Callback URL**: `https://thatsbrutal.fyi/api/integrations/github/callback`
- **Expire user authorization tokens**: on (the default; tokens last 8 hours and are refreshed
  with the refresh token).
- **Request user authorization (OAuth) during installation**: off. **Enable Device Flow**: off.
- **Webhook**: off (uncheck Active).
- **Repository permissions**: Issues: Read and write; Metadata: Read-only (required). Nothing else.
- **Where can this GitHub App be installed?**: Any account, so people can install it on their own
  repositories.

Then generate a client secret, and set:

```sh
bunx cf workers secrets update GITHUB_APP_CLIENT_ID --worker brutal --type secret_text --text "<Client ID>"
bunx cf workers secrets update GITHUB_APP_CLIENT_SECRET --worker brutal --type secret_text --text "<client secret>"
bunx cf workers secrets update GITHUB_APP_SLUG --worker brutal --type secret_text --text "<slug>"
```

No private key is needed: Brutal acts only with each person's user access token, so it can file
issues only in repositories where the app is installed **and** the person has access. A person
installs the app on more repositories from the "Install the GitHub App" link.

### 3. Linear: an OAuth2 application

Linear → Settings → API → OAuth applications → New:

- **Name**: `Brutal`; **Developer URL**: `https://thatsbrutal.fyi`
- **Callback URL**: `https://thatsbrutal.fyi/api/integrations/linear/callback`
- **Public**: on, so people outside your workspace can connect.

Brutal asks for the scopes `read` and `issues:create`, acting as the person (the default
actor). Set:

```sh
bunx cf workers secrets update LINEAR_CLIENT_ID --worker brutal --type secret_text --text "<client id>"
bunx cf workers secrets update LINEAR_CLIENT_SECRET --worker brutal --type secret_text --text "<client secret>"
```

### Local development

Register separate development apps with callback URLs on `http://127.0.0.1:8787` (GitHub and
Linear both accept a loopback http callback) and put the same names in `worker/.dev.vars`.

## How it works

- `GET /api/integrations`: the providers (available or not) and the person's connections (id,
  provider, account, created; never tokens).
- `GET /api/integrations/:provider/connect?return=/path`: stores a random `state` (its hash),
  bound to the session's hash, with a PKCE verifier (S256) for 10 minutes, and redirects to the
  provider.
- `GET /api/integrations/:provider/callback`: the state must be known, unexpired, for this
  provider and this session; it is used up either way. Exchanges the code (with the verifier),
  reads the account's name (GitHub login, Linear workspace), stores the tokens sealed, and
  redirects back to `return` (a path on this site only) with `?integration=connected`.
- `DELETE /api/integrations/:id`: revokes at the provider (GitHub: the app's authorization for
  the person; Linear: the token), then forgets the connection.
- `GET /api/integrations/:id/targets`: GitHub repositories (`/user/installations` and each
  installation's repositories) or Linear teams.
- `GET /api/projects/:project/issue-target`: the project's default, the last target used.
- `POST /api/projects/:project/reports/:id/issue` with `{ integration, target }`: makes sure of
  the Brutal label (best effort), creates the issue with it, sets the report's `issue_url` and
  status `linked`, and remembers the target.

Tokens close to expiry are refreshed before use, keeping a rotated refresh token; if refreshing
fails the person is asked to reconnect (409).
