import { expect, test } from "bun:test";
import { harness } from "./harness";

test("the docs come from the site, signed in or out, with no cookie forwarded", async () => {
  const seen: { path: string; cookie: string | null }[] = [];
  const SITE = {
    fetch: async (req: Request) => {
      seen.push({ path: new URL(req.url).pathname, cookie: req.headers.get("cookie") });
      return new Response("<h1>Docs</h1>", { headers: { "content-type": "text/html" } });
    },
  };
  const h = harness({ SITE });
  const r = await h.call("/docs", { cookie: "__Host-brutal_session=x" });
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("Docs");
  expect(seen).toEqual([{ path: "/docs", cookie: null }]);
});
