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

const PHONES = [360, 390];
const LONG_NAME = "Demo lender call with the landlord's attorney about renewal options and the parking easement";

async function open(t: TestContext, width: number, height: number) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const mobile = width < 640;
  const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
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

async function openCalendar(page: Page, view: string) {
  await page.goto(`${server.origin}/calendar?view=${view}&d=2026-10-20`);
  await page.locator(".cal-chip", { hasText: "Demo lender call" }).first().waitFor();
}

for (const width of PHONES) {
  for (const view of ["week", "day"])
    test(`Calendar ${view} shows each meeting's whole name on a phone ${width} wide`, async (t) => {
      const page = await open(t, width, 844);
      await openCalendar(page, view);
      assert.deepEqual(await cutText(page, ".cal-chip, .cal-chip-label"), [], "no meeting name is cut off");
    });

  test(`Calendar day ends a long meeting name with an ellipsis on a phone ${width} wide`, async (t) => {
    const page = await open(t, width, 844);
    await page.route("**/js/fixture-client.js", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace(/(["'])Demo lender call\1/, JSON.stringify(LONG_NAME)),
      });
    });
    await openCalendar(page, "day");
    const block = await page.locator(".cal-blocks .cal-chip", { hasText: "Demo lender call" }).evaluate((chip) => {
      const label = chip.querySelector(".cal-chip-label");
      if (!label) throw Error("no name");
      const box = getComputedStyle(chip);
      const room = chip.clientHeight - Number.parseFloat(box.paddingTop) - Number.parseFloat(box.paddingBottom);
      const lines = Number(getComputedStyle(label).webkitLineClamp);
      return {
        title: chip.getAttribute("title"),
        shortened: label.scrollHeight > room + 1,
        lines,
        shown: lines * Number.parseFloat(getComputedStyle(label).lineHeight),
        room,
      };
    });
    assert.ok(block.title?.endsWith(LONG_NAME), "the whole name shows on hover");
    assert.equal(block.shortened, true, "the name is too long for its block");
    assert.ok(block.lines >= 1, "the shortened name ends with an ellipsis");
    assert.ok(block.shown <= block.room + 1, `${block.lines} lines need ${block.shown}px of ${block.room}px`);
  });

  test(`Updates shows each whole title on a phone ${width} wide`, async (t) => {
    const page = await open(t, width, 844);
    await page.goto(`${server.origin}/updates`);
    await page.locator("#feedList .row-toggle").first().waitFor();
    assert.deepEqual(await cutText(page, "#feedList .row-toggle"), [], "no update title is cut off");
  });

  test(`a national account's deal search shows its whole hint on a phone ${width} wide`, async (t) => {
    const page = await open(t, width, 844);
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

  test(`a lead's phone and email are full tap targets on a phone ${width} wide`, async (t) => {
    const page = await open(t, width, 844);
    await routeLeads(page);
    await page.goto("http://localhost/leads");
    await page.locator("#leadBoard .lead-card").first().click();
    for (const link of [page.locator('#detailBody a[href^="tel:"]'), page.locator('#detailBody a[href^="mailto:"]')]) {
      const box = await link.boundingBox();
      assert.ok(box && box.height >= 44, `${await link.textContent()} is ${box?.height}px tall`);
    }
  });
}

for (const [width, height] of [
  [1280, 640],
  [1440, 900],
] as const)
  test(`Calendar week shows each meeting's whole name ${width} wide`, async (t) => {
    const page = await open(t, width, height);
    await openCalendar(page, "week");
    assert.deepEqual(await cutText(page, ".cal-chip-label"), [], "no meeting name is cut off");
  });
