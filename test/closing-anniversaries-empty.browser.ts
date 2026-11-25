import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const server = await startWorkerFixture({
  routes: await appAssetSnapshot(),
  demo: true,
  env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response(null) } },
});
test.after(() => server.close());

for (const width of [1280, 1440])
  test(`Closing anniversaries with none in the next 30 days shows one short line and no button at ${width}`, async (t) => {
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
    await page.route("**/api/engine/closing-anniversaries", (route) => route.fulfill({ json: [] }));
    await page.goto(`${server.origin}/leases`);
    const panel = page.getByRole("region", { name: "Closing anniversaries", exact: true });
    await panel.getByText("No closing anniversaries in the next 30 days.", { exact: true }).waitFor();
    assert.equal(await panel.textContent(), "No closing anniversaries in the next 30 days.");
    assert.equal(await page.locator("#main").getByRole("button").count(), 0, "no Show or Hide button");
  });
