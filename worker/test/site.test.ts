import { expect, test } from "bun:test";
import { harness } from "./harness";

/** A fake landing-page Worker that echoes what it was sent. */
const site = {
  fetch: async (req: Request) =>
    new Response(
      `site ${new URL(req.url).pathname} cookie=${req.headers.get("cookie") ?? "none"}`,
      {
        headers: { "content-type": "text/html" },
      },
    ),
};
const assets = {
  fetch: async () => new Response("the app", { headers: { "content-type": "text/html" } }),
};

test("signed out, / is the landing page, without the cookie, varying by cookie", async () => {
  const h = harness({ SITE: site, ASSETS: assets });
  const res = await h.call("/", { cookie: "__Host-brutal_session=stale; other=1" });
  expect(await res.text()).toBe("site / cookie=none");
  expect(res.headers.get("vary")).toContain("Cookie");
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(await (await h.call("/_astro/site.css")).text()).toBe("site /_astro/site.css cookie=none");
});

test("signed in, / is the app", async () => {
  const h = harness({ SITE: site, ASSETS: assets });
  const cookie = await h.signIn("a@example.com");
  const res = await h.call("/", { cookie });
  expect(await res.text()).toBe("the app");
  expect(res.headers.get("vary")).toContain("Cookie");
});

test("without the site (local dev), signed-out / goes to sign-in", async () => {
  const h = harness();
  const res = await h.call("/");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/sign-in");
});
