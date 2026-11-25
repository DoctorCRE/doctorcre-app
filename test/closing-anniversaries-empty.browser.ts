import assert from "node:assert/strict";
import test from "node:test";
import type { Route } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const server = await startWorkerFixture({
  routes: await appAssetSnapshot(),
  demo: true,
  env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response(null) } },
});
test.after(() => server.close());

async function openLeases(
  t: test.TestContext,
  width: number,
  answer: (route: Route) => unknown,
  next: (route: Route) => unknown = (route) => route.fulfill({ json: { next_anniversary_on: null } }),
) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  // Engine sign-in is on, so the page reads the engine's list.
  await page.route("**/leases", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace("<html", '<html data-partner-sign-in="engine"');
    await route.fulfill({ response, body });
  });
  await page.route("**/api/engine/closing-anniversaries", answer);
  await page.route("**/api/engine/closing-anniversaries/next", next);
  await page.goto(`${server.origin}/leases`);
  return { page, panel: page.getByRole("region", { name: "Closing anniversaries", exact: true }) };
}

for (const width of [390, 1280]) {
  test(`Closing anniversaries with none in the next 30 days shows one quiet line under one heading at ${width}`, async (t) => {
    const { page, panel } = await openLeases(t, width, (route) => route.fulfill({ json: [] }));
    const empty = panel.getByText("No closing anniversaries in the next 30 days.", { exact: true });
    await empty.waitFor();
    assert.equal(await panel.textContent(), "No closing anniversaries in the next 30 days.");
    assert.equal(await empty.evaluate((node) => getComputedStyle(node).textAlign), "center");
    assert.equal(await page.locator("#main").getByRole("button").count(), 0, "no Show or Hide button");
    const title = page.locator(".app-layout-center").getByText("Closing anniversaries", { exact: true });
    assert.equal(await title.count(), 1, "the title shows once");
    assert.equal(await title.evaluate((node) => node.tagName), "H1");
  });

  for (const [known, answer, line] of [
    [
      "known",
      { json: { next_anniversary_on: "2027-03-04" } },
      "No closing anniversaries in the next 30 days. The next one is March 4, 2027.",
    ],
    ["unreadable", { status: 503, json: {} }, "No closing anniversaries in the next 30 days."],
  ] as const)
    test(`An empty window with the next date ${known} reads plainly at ${width}`, async (t) => {
      const { panel } = await openLeases(
        t,
        width,
        (route) => route.fulfill({ json: [] }),
        (route) => route.fulfill(answer),
      );
      await panel.getByText(line, { exact: true }).waitFor();
      assert.equal(await panel.textContent(), line);
    });

  test(`Closing anniversaries waits on a skeleton, not loading text, at ${width}`, async (t) => {
    const { panel } = await openLeases(t, width, () => {});
    await panel.locator('[aria-busy="true"] .skeleton-line').first().waitFor();
    assert.equal(await panel.textContent(), "", "no loading text");
  });
}
