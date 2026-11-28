import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { expect } from "@playwright/test";
import { directoryFixture, vendorRoster } from "./fixtures/vendor-directory.synthetic.mjs";
import { expectVendorScreen, matchesVendorRequest, openVendors, screenFor } from "./fixtures/vendor-screen.ts";

const shots = "out/test-artifacts/directory-tiles";
await mkdir(shots, { recursive: true });

const roster = vendorRoster({ uncategorized: true });
const banking = "/vendors?category=banker";

test("Vendors opens on a tile per category that opens its list, and Joe recounts them", async (t) => {
  const { page } = await openVendors(t, roster);
  await expectVendorScreen(page, screenFor(roster));
  await page.screenshot({ path: `${shots}/tiles-1440.png` });

  const joeTiles = screenFor(roster, { view: "/vendors?owner=joe" });
  const tile = (label: string) =>
    page.locator("a.directory-tile").filter({ has: page.getByText(label, { exact: true }) });
  await page.getByRole("button", { name: "Joe", exact: true }).click();
  await expectVendorScreen(page, joeTiles);

  await tile("Banking").click();
  await expectVendorScreen(page, screenFor(roster, { view: `${banking}&owner=joe` }));
  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await expectVendorScreen(page, joeTiles);

  await tile("No category").click();
  await expectVendorScreen(page, screenFor(roster, { view: "/vendors?owner=joe&no_category=true" }));
  await page.goBack();
  await expectVendorScreen(page, joeTiles);

  const view = "/vendors?owner=joe&all=true";
  await tile("All vendors").click();
  await expectVendorScreen(page, screenFor(roster, { view }));
  await page.locator("#scrollSentinel").scrollIntoViewIfNeeded();
  await expectVendorScreen(page, screenFor(roster, { view, page: 2 }));
});

test("Find a vendor swaps the tiles for matches and clearing it brings them back", async (t) => {
  const { page } = await openVendors(t, roster, { width: 1280, height: 640 });
  await expectVendorScreen(page, screenFor(roster));
  await page.screenshot({ path: `${shots}/tiles-1280x640.png` });
  const find = page.getByPlaceholder("Find a vendor");
  await find.fill("Partner 0");
  await expectVendorScreen(page, screenFor(roster, { view: "/vendors?q=Partner+0" }));
  await find.fill("");
  await expectVendorScreen(page, screenFor(roster));
});

test("on a phone the tiles are two across", async (t) => {
  const { page } = await openVendors(t, roster, { width: 390, height: 844 });
  const expected = screenFor(roster, { layout: "phone" });
  await expectVendorScreen(page, expected);
  const boxes = await page
    .locator("a.directory-tile")
    .evaluateAll((tiles) => tiles.slice(0, 2).map((tile) => tile.getBoundingClientRect().top));
  assert.equal(boxes[0], boxes[1], "the first two tiles share a row");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const dell = await page.getByRole("button", { name: "Dell", exact: true }).boundingBox();
  assert.ok(dell && dell.x + dell.width <= 390, "the owner chips fit beside Categories");
  await page.screenshot({ path: `${shots}/tiles-390.png`, fullPage: true });
  await expectVendorScreen(page, expected);
});

test("New vendor offers every category while the tiles are showing (Edit reads the same list)", async (t) => {
  const { page } = await openVendors(t, roster, { live: true });
  await expectVendorScreen(page, screenFor(roster, { live: true }));
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  const choices = await dialog.locator('input[name="categories"]').count();
  assert.ok(choices >= 3, `the form lists the categories (${choices})`);
  assert.equal(await dialog.getByText("No categories yet.").count(), 0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expectVendorScreen(page, screenFor(roster, { live: true }));
});

test("a saved link to My work keeps showing the vendors recorded as yours", async (t) => {
  const view = "/vendors?scope=mine";
  const { page } = await openVendors(t, roster, { view });
  await expectVendorScreen(page, screenFor(roster, { view }));
  await page.locator("#scrollSentinel").scrollIntoViewIfNeeded();
  await expectVendorScreen(page, screenFor(roster, { view, page: 2 }));
});

test("a refresh keeps keyboard focus on the same tile", async (t) => {
  const { page } = await openVendors(t, roster);
  await expectVendorScreen(page, screenFor(roster));
  await page.getByRole("link", { name: /^Banking / }).focus();

  const refreshed = vendorRoster({ uncategorized: true, banking: "Commercial Banking" });
  await page.route(
    (url) => matchesVendorRequest(url, "/api/v1/business/vendors/summary"),
    (route) => route.fulfill({ json: directoryFixture(route.request().url(), { roster: refreshed }) }),
    { times: 1 },
  );
  await page.locator("#refreshList").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("link", { name: /^Commercial Banking / })).toBeFocused();
  await expectVendorScreen(page, screenFor(refreshed));
});

for (const width of [390, 320])
  test(`the top row keeps Joe, Dell and New vendor on screen at ${width}`, async (t) => {
    const { page } = await openVendors(t, roster, { width, height: 844, live: true, light: true });
    const expected = screenFor(roster, { layout: "phone", live: true });
    await expectVendorScreen(page, expected);
    await page.getByRole("button", { name: "New vendor" }).waitFor();
    await page.screenshot({ path: `${shots}/tiles-new-${width}.png`, fullPage: true });
    for (const name of ["New vendor", "Joe", "Dell"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${name} sits inside ${width} wide`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await expectVendorScreen(page, expected);
  });

test("inside a category the relationship counts and Quiet filter the one table, and headings sort it", async (t) => {
  const { page } = await openVendors(t, roster, { view: banking });
  const category = screenFor(roster, { view: banking });
  await expectVendorScreen(page, category);
  const core = page.getByRole("button", { name: /^Core / });
  const coreScreen = screenFor(roster, { view: `${banking}&relationship=core` });
  await core.click();
  await expectVendorScreen(page, coreScreen);
  await core.click();
  await expectVendorScreen(page, category);

  const quiet = page.getByRole("button", { name: /^Quiet/ });
  const quietScreen = screenFor(roster, { view: `${banking}&quiet=true` });
  await quiet.click();
  await expectVendorScreen(page, quietScreen);
  assert.equal(await page.locator(".record-row:visible .contact-note:not(.quiet)").count(), 0);
  await quiet.click();
  await expectVendorScreen(page, category);

  const name = page.getByRole("button", { name: "Name", exact: true });
  await name.click();
  await expectVendorScreen(page, screenFor(roster, { view: `${banking}&sort=name` }));
  await name.click();
  await expectVendorScreen(page, category);
});

test("outside a category the relationship counts and the Quiet count stay away, however small the answer", async (t) => {
  const view = "/vendors?all=true&q=Partner+0";
  const { page } = await openVendors(t, roster, { view });
  await expectVendorScreen(page, screenFor(roster, { view }));
});

test("a filter that matches nothing says so and Clear filters brings the category back", async (t) => {
  const view = `${banking}&q=Nobody`;
  const { page } = await openVendors(t, roster, { view, width: 1280, height: 640 });
  await expectVendorScreen(page, screenFor(roster, { view }));
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expectVendorScreen(page, screenFor(roster, { view: banking }));
});

for (const width of [320, 390])
  test(`at ${width} wide a tile's count stays inside its tile`, async (t) => {
    const { page } = await openVendors(t, roster, { width, height: 740 });
    const expected = screenFor(roster, { layout: "phone" });
    await expectVendorScreen(page, expected);
    const touching = await page.locator("a.directory-tile").evaluateAll((tiles) =>
      tiles
        .filter((tile) => {
          const count = tile.querySelector(".tile-count")?.getBoundingClientRect();
          return count && count.right > tile.getBoundingClientRect().right - 8;
        })
        .map((tile) => tile.querySelector(".tile-name")?.textContent),
    );
    assert.deepEqual(touching, []);
    await expectVendorScreen(page, expected);
  });

const marketRoster = vendorRoster({ markets: true });

test("territory tiles combine with search and clear in place", async (t) => {
  const { page } = await openVendors(t, marketRoster, { view: banking });
  const territory = page.getByRole("group", { name: "Territories" });
  const [mobile] = marketRoster.markets;
  assert.ok(mobile);
  const mobileButton = territory.getByRole("button", { name: "Mobile 1" });
  const bankingScreen = screenFor(marketRoster, { view: banking });
  await expectVendorScreen(page, bankingScreen);

  await mobileButton.click();
  await expectVendorScreen(page, screenFor(marketRoster, { view: `${banking}&market=${mobile.id}` }));
  await mobileButton.click();
  await expectVendorScreen(page, bankingScreen);

  await territory.getByRole("button", { name: "Elsewhere 1" }).click();
  await expectVendorScreen(page, screenFor(marketRoster, { view: `${banking}&market=elsewhere` }));
  await territory.getByRole("button", { name: "No territory 1" }).click();
  const noTerritory = `${banking}&market=no_territory`;
  await expectVendorScreen(page, screenFor(marketRoster, { view: noTerritory }));
  const find = page.getByPlaceholder("Find in Banking");
  await find.fill("missing");
  await expectVendorScreen(page, screenFor(marketRoster, { view: `${noTerritory}&q=missing` }));
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expectVendorScreen(page, bankingScreen);
  await page.screenshot({ path: `${shots}/territories-1440.png` });

  const sortTerritory = page.getByRole("button", { name: "Territory", exact: true });
  await sortTerritory.click();
  await expectVendorScreen(page, screenFor(marketRoster, { view: `${banking}&sort=territory` }));
  await sortTerritory.click();
  await expectVendorScreen(page, bankingScreen);

  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await expectVendorScreen(page, screenFor(marketRoster));
  await page.getByRole("link", { name: /^All vendors / }).click();
  const all = "/vendors?all=true";
  await expectVendorScreen(page, screenFor(marketRoster, { view: all }));
  await page.getByRole("button", { name: "Dell", exact: true }).click();
  const dell = `${all}&owner=dell`;
  await expectVendorScreen(page, screenFor(marketRoster, { view: dell }));
  await mobileButton.click();
  const dellMobile = `${dell}&market=${mobile.id}`;
  await expectVendorScreen(page, screenFor(marketRoster, { view: dellMobile }));
  await page.getByRole("button", { name: "People worth meeting" }).click();
  assert.equal(await page.locator(".app-layout-main").evaluate((main) => getComputedStyle(main).overflowY), "auto");
  await expectVendorScreen(page, screenFor(marketRoster, { view: dellMobile, meetings: true }));
});

for (const [width, height, touch] of [
  [1280, 640, false],
  [390, 844, true],
] as const) {
  test(`territory tiles fit at ${width}×${height}`, async (t) => {
    const { page } = await openVendors(t, marketRoster, { view: banking, width, height, touch, light: touch });
    const layout = touch ? "phone" : "desktop";
    const expected = screenFor(marketRoster, { view: banking, layout });
    const group = page.getByRole("group", { name: "Territories" });
    await page.evaluate(() => (document.documentElement.dataset.colorAssist = "on"));
    await expectVendorScreen(page, expected);
    if (touch) {
      assert.ok(await group.evaluate((row) => row.scrollWidth > row.clientWidth));
      const firstTile = await group.getByRole("button").first().boundingBox();
      assert.ok(firstTile && firstTile.height >= 44);
      await group.getByRole("button", { name: "No territory 1" }).tap();
      await expectVendorScreen(page, screenFor(marketRoster, { view: `${banking}&market=no_territory`, layout }));
      await group.getByRole("button", { name: "All territories 31" }).tap();
    } else {
      const region = page.locator("#listRegion");
      const wholeRows = await region.evaluate((list) => {
        const edge = list.getBoundingClientRect();
        return [...list.querySelectorAll(".record-row")].filter((row) => {
          const box = row.getBoundingClientRect();
          return box.top >= edge.top && box.bottom <= Math.min(edge.bottom, innerHeight);
        }).length;
      });
      assert.ok(wholeRows >= 11, `${wholeRows} whole vendor rows`);
      const top = await group.boundingBox();
      await region.evaluate((list) => {
        list.scrollTop = 200;
      });
      assert.ok(await region.evaluate((list) => list.scrollTop > 0));
      assert.deepEqual(await group.boundingBox(), top);
    }
    await expectVendorScreen(page, expected);
    await page.screenshot({ path: `${shots}/territories-${width}.png` });
    await expectVendorScreen(page, expected);
  });
}

test("territory tiles and market reads stay off before rollout", async (t) => {
  const { page } = await openVendors(t, roster, { view: `${banking}&market=elsewhere` });
  const expected = screenFor(roster, { view: banking });
  await expectVendorScreen(page, expected);
});

test("Tab through the vendor table scrolls only the list", async (t) => {
  const { page } = await openVendors(t, marketRoster, { view: banking, width: 1280, height: 640 });
  const expected = screenFor(marketRoster, { view: banking });
  await expectVendorScreen(page, expected);
  const tiles = page.getByRole("group", { name: "Territories" });
  const headings = page.locator(".list-head");
  const tilesTop = (await tiles.boundingBox())?.y;
  const headingsTop = (await headings.boundingBox())?.y;
  const rows = page.locator(".record-row");
  const count = marketRoster.rows.filter((row) => row.categories.some(({ slug }) => slug === "banker")).length;
  await rows.first().focus();
  for (let index = 1; index < count; index++) {
    await page.keyboard.press("Tab");
    await expect(rows.nth(index)).toBeFocused();
  }
  assert.equal(
    await page.locator(".app-layout-main").evaluate((main) => main.scrollTop),
    0,
    "the outer workspace scrolled",
  );
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.ok(await page.locator("#listRegion").evaluate((list) => list.scrollTop > 0));
  assert.equal((await tiles.boundingBox())?.y, tilesTop);
  assert.equal((await headings.boundingBox())?.y, headingsTop);
  await page.keyboard.press("Shift+Tab");
  await expect(rows.nth(count - 2)).toBeFocused();
  await expectVendorScreen(page, expected);
});

test("a phone vendor card removes the territory and table controls from keyboard navigation", async (t) => {
  const { page } = await openVendors(t, marketRoster, { view: banking, width: 390, height: 844, touch: true });
  const expected = screenFor(marketRoster, { view: banking, layout: "phone" });
  await expectVendorScreen(page, expected);
  const quiet = page.locator("#tableFilters [data-quiet-filter]");
  const first = page.locator(".record-row").first();
  await first.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Demo Partner 01" }).waitFor();

  await quiet.focus();
  await expect(quiet).not.toBeFocused();
  assert.equal(await page.getByRole("group", { name: "Show only" }).count(), 0);
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    assert.ok(await dialog.evaluate((panel) => panel.contains(document.activeElement)));
  }
  await page.keyboard.press("Escape");
  await expect(first).toBeFocused();
  await quiet.focus();
  await expect(quiet).toBeFocused();
  await expectVendorScreen(page, expected);
});
