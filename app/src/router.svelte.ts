/** A tiny router: the path in a rune, pushState for links within the app. */
export const route = $state({ path: location.pathname, query: location.search });

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  const url = new URL(to, location.origin);
  route.path = url.pathname;
  route.query = url.search;
  window.scrollTo(0, 0);
}

window.addEventListener("popstate", () => {
  route.path = location.pathname;
  route.query = location.search;
});

// Same-site links move within the app instead of reloading it.
window.addEventListener("click", (event) => {
  const a = (event.target as Element | null)?.closest("a");
  if (!a || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || a.target) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
});

/** The parts of a path that match a pattern such as /projects/:id, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? "";
    const g = decodeURIComponent(got[i] ?? "");
    if (w.startsWith(":")) params[w.slice(1)] = g;
    else if (w !== g) return null;
  }
  return params;
}
