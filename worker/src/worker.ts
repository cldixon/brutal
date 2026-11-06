import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { findKey, type Key, migrated, ownedProject } from "./accounts";
import { type Bindings, createApp, type Deps, defaultDeps } from "./app";
import { handleMcp } from "./mcp";
import { type GrantProps, SCOPES } from "./oauth";

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
 */
export function createWorker(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps, ...overrides };
  const app = createApp(overrides);
  const providers = new Map<string, OAuthProvider<Bindings>>();

  const providerFor = (origin: string) => {
    let provider = providers.get(origin);
    if (provider) return provider;
    const resource = `${origin}/mcp`;
    provider = new OAuthProvider<Bindings>({
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
            key = { id: `grant:${g.id}`, kind: g.kind, project_id: g.projectId };
          } else if (props.key) {
            key = props.key;
          } else {
            return new Response(null, { status: 401 });
          }
          return handleMcp(request, deps.reports(env, key.project_id), key);
        },
      },
      defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: SCOPES,
      accessTokenTTL: HOUR,
      refreshTokenTTL: 30 * 24 * HOUR,
      resourceMetadata: {
        resource,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "Brutal",
      },
      // A project's keys keep working on /mcp, for Claude Code, scripts and the SDK.
      resolveExternalToken: async ({ token, env }) => {
        const found = await findKey(await migrated(env.DB), token);
        if (!found) return null;
        const props: GrantProps = { key: found };
        return { props, audience: resource };
      },
    });
    providers.set(origin, provider);
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
      return providerFor(url.origin).fetch(request, env, ctx);
    },
  };
}
