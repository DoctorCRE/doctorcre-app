import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { vendorRoster } from "./fixtures/vendor-directory.synthetic.mjs";
import { expectVendorScreen, holdVendorList, openVendors, screenFor } from "./fixtures/vendor-screen.ts";

const roster = vendorRoster();
const banking = "/vendors?category=banker";

const lines = (page: Page) =>
  page.locator(".record-row").evaluateAll((rows) =>
    rows.map((row) => {
      const top = (selector: string) => {
        const box = row.querySelector(selector)?.getBoundingClientRect();
        return box && box.width > 0 ? Math.round(box.top + box.height / 2) : null;
      };
      return {
        name: top(".row-name"),
        relationship: top('[data-fact="Relationship"] .fact-value'),
        territory: top('[data-fact="Territory"] .fact-value'),
        contact: top(".contact-note"),
        hidden: top('[data-fact="Location"]') ?? top(".row-foot"),
      };
    }),
  );

test("on a phone each vendor is two lines: name and relationship, then territory and last contact", async (t) => {
  const { page } = await openVendors(t, roster, { view: banking, width: 390, height: 844 });
  const expected = screenFor(roster, { view: banking, layout: "phone" });
  await expectVendorScreen(page, expected);
  const rows = await lines(page);
  for (const row of rows) {
    assert.equal(row.hidden, null, "Location and Owner stay on the computer table");
    assert.ok(
      row.name && row.relationship && Math.abs(row.name - row.relationship) < 6,
      "relationship beside the name",
    );
    assert.ok(
      row.territory && row.contact && Math.abs(row.territory - row.contact) < 6,
      "last contact beside territory",
    );
    assert.ok(row.territory > row.name, "territory under the name");
  }
  const clipped = await page
    .locator(".record-row .row-name")
    .evaluateAll((names) => names.filter((name) => name.scrollWidth > name.clientWidth).length);
  assert.equal(clipped, 0, "short names show whole beside a Want to meet tag");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await expectVendorScreen(page, expected);
});

test("a vendor never contacted says No contact yet with no day count", async (t) => {
  const roster = vendorRoster({ noQuietContact: true });
  const { page } = await openVendors(t, roster, { view: banking });
  await expectVendorScreen(page, screenFor(roster, { view: banking }));
});

test("while a category loads it is named, never by its slug", async (t) => {
  const roster = vendorRoster({ banking: "CPA / Financial" });
  const holdQuery = "category=banker";
  const { page, heldList } = await openVendors(t, roster, { view: banking, holdQuery });
  assert.ok(heldList);
  await heldList.waitUntilHeld();
  await expectVendorScreen(page, screenFor(roster, { view: banking, loading: true }));
  heldList.release();
  const loaded = screenFor(roster, { view: banking });
  await expectVendorScreen(page, loaded);

  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await expectVendorScreen(page, screenFor(roster));
  const tileList = await holdVendorList(page, holdQuery);
  await page.getByRole("link", { name: /^CPA \/ Financial/ }).click();
  await tileList.waitUntilHeld();
  await expectVendorScreen(page, screenFor(roster, { view: banking, loading: true, fromTile: true }));
  tileList.release();
  await expectVendorScreen(page, loaded);
});

for (const [width, height] of [
  [1280, 640],
  [1440, 900],
] as const)
  test(`the relationship counts stay on one row with the card open at ${width}x${height}`, async (t) => {
    const { page } = await openVendors(t, roster, { view: banking, width, height });
    await expectVendorScreen(page, screenFor(roster, { view: banking }));
    const vendor = roster.rows.find((row) => row.name === "Demo Partner 01");
    assert.ok(vendor);
    await page.locator(".record-row").filter({ hasText: vendor.name }).click();
    await page.locator("body[data-card-open]").waitFor();
    const tops = await page
      .locator(".table-filters .filter-count")
      .evaluateAll((counts) => counts.map((count) => Math.round(count.getBoundingClientRect().top)));
    assert.ok(tops.length > 1, "the counts are drawn");
    assert.equal(new Set(tops).size, 1, `every count shares one row: ${tops}`);
    const row = await page.locator(".table-filters").evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(row <= 0, `the row needs no scrolling (${row}px over)`);
    await expectVendorScreen(page, screenFor(roster, { view: `${banking}&record=${vendor.id}` }));
  });

test("the search hint shows whole for a long category name", async (t) => {
  const label = "Practice Management Consultant";
  const roster = vendorRoster({ banking: label });
  const { page } = await openVendors(t, roster, { view: banking, width: 1280, height: 640 });
  const expected = screenFor(roster, { view: banking });
  await expectVendorScreen(page, expected);
  const fit = await page.getByRole("searchbox", { name: "Search" }).evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return null;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return { hint: context.measureText(input.placeholder).width, room };
  });
  assert.ok(fit && fit.hint <= fit.room, `the hint (${fit?.hint}px) fits its box (${fit?.room}px)`);
  await expectVendorScreen(page, expected);
});

test("a vendor's card follows the screen spec's order and ends with Where", async (t) => {
  const { page } = await openVendors(t, roster, { view: banking });
  await expectVendorScreen(page, screenFor(roster, { view: banking }));
  const vendor = roster.rows.find((row) => row.name === "Demo Partner 11");
  assert.ok(vendor);
  await page.locator(".record-row").filter({ hasText: vendor.name }).click();
  await page.locator("#recordActivity").waitFor();
  const headings = await page
    .locator("#recordPanel .record-panel-body > section > h3, #recordPanel .detail-columns h3")
    .allTextContents();
  const order = ["Contacts & offices", "Conversations", "Partnership", "Where"].map((title) => headings.indexOf(title));
  assert.ok(
    order.every((at) => at >= 0),
    `each section is drawn: ${headings.join(", ")}`,
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    `in the spec's order: ${headings.join(", ")}`,
  );
  assert.equal(headings.at(-2), "Where", "Where is the last vendor section before Recent activity");
  await expectVendorScreen(page, screenFor(roster, { view: `${banking}&record=${vendor.id}` }));
});
