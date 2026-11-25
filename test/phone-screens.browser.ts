import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { routeLeads } from "./leads-browser-fixture.mjs";

const server = await startWorkerFixture({
  routes: await appAssetSnapshot(),
  demo: true,
  env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response(null) } },
});
test.after(() => server.close());

async function phone(t: TestContext) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.clock.install({ time: new Date("2026-10-20T15:00:00Z") });
  return page;
}

const cutText = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)
        .map((node) => node.textContent?.trim()),
    );

for (const view of ["week", "day"])
  test(`Calendar ${view} shows each meeting's whole name on a phone`, async (t) => {
    const page = await phone(t);
    await page.goto(`${server.origin}/calendar?view=${view}&d=2026-10-20`);
    await page.locator(".cal-chip", { hasText: "Demo lender call" }).first().waitFor();
    assert.deepEqual(await cutText(page, ".cal-chip, .cal-chip-label"), [], "no meeting name is cut off");
  });

test("Updates shows each whole title on a phone", async (t) => {
  const page = await phone(t);
  await page.goto(`${server.origin}/updates`);
  await page.locator("#feedList .row-toggle").first().waitFor();
  assert.deepEqual(await cutText(page, "#feedList .row-toggle"), [], "no update title is cut off");
});

test("a national account's deal search shows its whole hint on a phone", async (t) => {
  const page = await phone(t);
  await page.goto(`${server.origin}/deals?view=national`);
  await page.locator(".account-card").first().click();
  const search = page.locator("#openDealToolbar #search");
  await search.waitFor();
  const fits = await search.evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input);
    const pen = document.createElement("canvas").getContext("2d");
    if (!pen) throw Error("no canvas");
    pen.font = style.font;
    const room = input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return pen.measureText(input.placeholder).width <= room;
  });
  assert.equal(fits, true, "the search hint reads whole");
});

test("a lead's phone and email are full tap targets on a phone", async (t) => {
  const page = await phone(t);
  await routeLeads(page);
  await page.goto("http://localhost/leads");
  await page.locator("#leadBoard .lead-card").first().click();
  for (const link of [page.locator('#detailBody a[href^="tel:"]'), page.locator('#detailBody a[href^="mailto:"]')]) {
    const box = await link.boundingBox();
    assert.ok(box && box.height >= 44, `${await link.textContent()} is ${box?.height}px tall`);
  }
});
