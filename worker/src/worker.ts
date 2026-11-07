import {
  getOAuthApi,
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { findKey, type Key, migrated, ownedProject } from "./accounts";
import { type Bindings, createApp, type Deps, defaultDeps } from "./app";
import { overFilingLimit } from "./limits";
import { handleMcp } from "./mcp";
import { type GrantProps, type Role, roleOf, scopesFor } from "./oauth";

const HOUR = 3600;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** RFC 6750's answer to a token that no longer works: a Bearer challenge naming the metadata. */
function invalidToken(origin: string, why: string): Response {
  return Response.json(
    { error: "invalid_token", error_description: why },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="${why}"`,
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * The Worker's fetch handler, after Tempra's (cldixon/tempra, worker/src/worker.ts): Cloudflare's
 * OAuth provider in front of the app. It serves OAuth discovery, /register and /token, guards
 * /mcp (an app's access token, or one of a project's keys through resolveExternalToken), and
 * hands everything else to the app, whose /authorize is the consent (oauth.ts). The canonical
 * resource is `<origin>/mcp`, so one provider is built per origin the Worker is reached on.
 *
 * Two MCP servers, one per host: FEEDBACK_ORIGIN serves the feedback server (`report_feedback`
 * only, what an agent using someone's tools sees), REVIEW_ORIGIN the review server (the triage
 * tools, for the developers' coding agents). The app's own host serves neither, nor OAuth. The provider checks a token's audience
 * against its host's resource, so a connection made on one host never works on the other.
 */
export function createWorker(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps, ...overrides };
  const app = createApp(overrides);
  const providers = new Map<string, OAuthProvider<Bindings>>();

  const optionsFor = (origin: string, role: Role): OAuthProviderOptions<Bindings> => {
    const resource = `${origin}/mcp`;
    return {
      apiRoute: "/mcp",
      apiHandler: {
        async fetch(request, env, ctx) {
          const props = (ctx as unknown as { props: GrantProps }).props;
          let key: Key;
          if (props.grant) {
            const g = props.grant;
            // Checked on every call: the project must still be the person's.
            const project = await ownedProject(await migrated(env.DB), g.userId, g.projectId);
            if (!project) return invalidToken(origin, "This connection's project is gone.");
            if (role === "review" && g.kind !== "read") {
              return invalidToken(origin, "This connection can't review reports.");
            }
            key = { id: `grant:${g.id}`, kind: g.kind, project_id: g.projectId };
          } else if (props.key) {
            key = props.key;
          } else {
            return new Response(null, { status: 401 });
          }
          // MCP reports carry no conversation id: only the key's (or connection's) limit applies.
          return handleMcp(request, deps.reports(env, key.project_id), key, role, () =>
            overFilingLimit(env, key),
          );
        },
      },
      defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: scopesFor(role),
      accessTokenTTL: HOUR,
      refreshTokenTTL: 30 * 24 * HOUR,
      resourceMetadata: {
        resource,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: role === "review" ? "Brutal review" : "Brutal",
      },
      // A project's keys keep working on /mcp, for Claude Code, scripts and the SDK: either kind
      // on the feedback server, a read key alone on the review server.
      resolveExternalToken: async ({ token, env }) => {
        const found = await findKey(await migrated(env.DB), token);
        if (!found || (role === "review" && found.kind !== "read")) return null;
        const props: GrantProps = { key: found };
        return { props, audience: resource };
      },
    };
  };

  const providerFor = (origin: string, role: Role) => {
    let provider = providers.get(origin);
    if (!provider) {
      provider = new OAuthProvider<Bindings>(optionsFor(origin, role));
      providers.set(origin, provider);
    }
    return provider;
  };

  return {
    fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      // Only https (or a loopback host in dev) is an origin: the OAuth metadata and cookies need it.
      if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
        url.protocol = "https:";
        return Promise.resolve(Response.redirect(url.toString(), 308));
      }
      const role = roleOf(url.origin, env);
      // The provider puts its helpers on env once (`if (!env.OAUTH_PROVIDER)`), and an isolate's
      // env is shared by every request: a per-request env keeps each host's consent on its own
      // provider.
      const scoped = Object.create(env) as Bindings;
      // The app's own host serves no MCP and no OAuth: straight to the app, with the helpers it
      // lists and revokes connections through (grants are in one KV for both servers).
      if (!role) {
        scoped.OAUTH_PROVIDER = getOAuthApi(optionsFor(url.origin, "report"), scoped);
        return Promise.resolve(app.fetch(request, scoped, ctx));
      }
      // The MCP hosts are for MCP and connecting to it; their home is the app's.
      if (url.pathname === "/" && env.APP_ORIGIN && url.origin !== env.APP_ORIGIN) {
        return Promise.resolve(Response.redirect(`${env.APP_ORIGIN}/`, 302));
      }
      return providerFor(url.origin, role).fetch(request, scoped, ctx);
    },
  };
}
