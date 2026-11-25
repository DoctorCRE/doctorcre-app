import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { routeLeads } from "./leads-browser-fixture.mjs";

// Design rules 1 and 4: body text 14px and controls 28-32px on a computer; 16px and 44px touch targets on a phone.
const screens = {
  Home: "/?mode=fixture",
  Deals: "/deals?mode=fixture",
  "deal page": "/deals?mode=fixture&deal=d14",
  Leads: "leads",
  Vendors: "/vendors?mode=fixture",
  Search: "/search?mode=fixture",
  Settings: "/settings?mode=fixture",
};
// Calendar day cells, deal cards and Today rows are not controls; their sizes belong to their screens.
const controls =
  "main :is(button, select, input:not([type=checkbox], [type=radio], [type=hidden])):not(.card-open, .app-layout-item, [class^=cal-])";

test("body text and controls take their size from the tokens on every screen", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const [width, body, fits] of [
    [1280, "14px", (h: number) => h >= 28 && h <= 32],
    [390, "16px", (h: number) => h >= 44],
  ] as const)
    for (const [name, path] of Object.entries(screens))
      await t.test(`${name} at ${width}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        t.after(() => page.close());
        if (path === "leads") {
          await routeLeads(page);
          await page.goto("http://localhost/leads");
          await page.locator("#leadBoard .lead-card").first().waitFor();
        } else {
          await page.route("https://**", (route) => route.abort());
          await page.goto(server.origin + path);
          await page.locator("main").first().waitFor();
        }
        await page.waitForLoadState("networkidle");
        const sizes = await page.evaluate(
          (selector) => ({
            body: getComputedStyle(document.body).fontSize,
            controls: [...document.querySelectorAll(selector)]
              .map((node) => ({
                name: `${node.tagName.toLowerCase()}#${node.id}.${node.className}`,
                height: Math.round(node.getBoundingClientRect().height),
              }))
              .filter((control) => control.height > 0),
          }),
          controls,
        );
        assert.equal(sizes.body, body, "body text");
        assert.ok(sizes.controls.length > 0, "the screen shows controls");
        assert.deepEqual(
          sizes.controls.filter((control) => !fits(control.height)),
          [],
          `every control is the token height at ${width}`,
        );
      });
});
