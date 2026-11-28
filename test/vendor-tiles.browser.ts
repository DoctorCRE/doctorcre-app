import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { expect } from "@playwright/test";
import { directoryFixture, vendorRoster } from "./fixtures/vendor-directory.synthetic.mjs";
import {
  expectVendorScreen,
  matchesVendorRequest,
  openVendors,
  screenFor,
  vendorListRequest,
} from "./fixtures/vendor-screen.ts";

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
  await expectVendorScreen(page, screenFor(roster));
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  const choices = await dialog.locator('input[name="categories"]').count();
  assert.ok(choices >= 3, `the form lists the categories (${choices})`);
  assert.equal(await dialog.getByText("No categories yet.").count(), 0);
  await expectVendorScreen(page, screenFor(roster));
});

test("a saved link to My work keeps showing the vendors recorded as yours", async (t) => {
  const view = "/vendors?scope=mine";
  const { page, asked } = await openVendors(t, roster, { view });
  await expectVendorScreen(page, screenFor(roster, { view }));
  assert.ok(asked.some((url) => matchesVendorRequest(url, vendorListRequest("scope=mine"))));
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
    const expected = screenFor(roster, { layout: "phone" });
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
  const { page, asked } = await openVendors(t, roster, { view: banking });
  const category = screenFor(roster, { view: banking });
  await expectVendorScreen(page, category);
  const reads = () => asked.filter((url) => url.pathname.endsWith("/vendors")).length;
  const core = page.getByRole("button", { name: /^Core / });
  const coreScreen = screenFor(roster, { view: `${banking}&relationship=core` });
  await expect(core).toHaveText(`Core ${coreScreen.rows.length}`);
  const before = reads();
  await core.click();
  await expectVendorScreen(page, coreScreen);
  await expect(core).toHaveAttribute("aria-pressed", "true");
  assert.equal(reads(), before, "the filter re-reads nothing");
  await core.click();
  await expectVendorScreen(page, category);

  const quiet = page.getByRole("button", { name: /^Quiet/ });
  const quietScreen = screenFor(roster, { view: `${banking}&quiet=true` });
  await expect(quiet).toHaveText(`Quiet ${quietScreen.rows.length}`);
  await quiet.click();
  await expectVendorScreen(page, quietScreen);
  assert.equal(await page.locator(".record-row:visible .contact-note:not(.quiet)").count(), 0);
  await quiet.click();
  await expectVendorScreen(page, category);

  const name = page.getByRole("button", { name: "Name", exact: true });
  await name.click();
  await expectVendorScreen(page, screenFor(roster, { view: `${banking}&sort=name` }));
  await expect(name).toHaveAttribute("aria-pressed", "true");
  await name.click();
  await expectVendorScreen(page, category);
});

test("outside a category the relationship counts and the Quiet count stay away, however small the answer", async (t) => {
  const view = "/vendors?all=true&q=Partner+0";
  const { page } = await openVendors(t, roster, { view });
  await expectVendorScreen(page, screenFor(roster, { view }));
  assert.equal(await page.locator("#tableFilters [data-relationship-filter]").count(), 0);
  assert.equal(await page.getByRole("button", { name: /^Quiet/ }).textContent(), "Quiet");
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
