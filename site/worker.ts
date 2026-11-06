/**
 * The brutal-site Worker: serves the static build (dist/) through ASSETS and adds security
 * headers. It has no host of its own: the app's Worker owns the domain and asks this one, through
 * its SITE service binding, for `/` when nobody is signed in and for the site's own files.
 */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export const HEADERS: Record<string, string> = {
  // No scripts, no third parties: HTML and one stylesheet.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value);
    return response;
  },
};
